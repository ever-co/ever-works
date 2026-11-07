const mockRequestToken = jest.fn();
const mockAppId = jest.fn<string | undefined, []>();
const mockPrivateKey = jest.fn<string | undefined, []>();

jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    WorkRepository: class {},
}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        githubApp: {
            getAppId: () => mockAppId(),
            getPrivateKey: () => mockPrivateKey(),
        },
    },
}));
jest.mock('@ever-works/agent/utils', () => ({
    requestGitHubAppInstallationAccessTokenDetails: (...args: unknown[]) =>
        mockRequestToken(...args),
    createGitHubAppJwt: () => 'app-jwt',
    createGitHubAppHeaders: (jwt: string) => ({ Authorization: `Bearer ${jwt}` }),
}));

import { SiteGitTokenError, SiteGitTokenService } from './site-git-token.service';

const KEY = 'k'.repeat(48);
const ENV_KEYS = [
    'EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED',
    'EVER_WORKS_SITE_GIT_TOKEN_KEY',
    'EVER_WORKS_SITE_GIT_TOKEN_ORGS',
    'EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL',
    'PUBLIC_API_URL',
    'PLATFORM_API_URL',
];

const makeWork = (overrides: { id?: string; owner?: string; dataRepo?: string } = {}) =>
    ({
        id: overrides.id ?? 'work-1',
        getRepoOwner: () => overrides.owner ?? 'ever-works',
        getDataRepo: () => overrides.dataRepo ?? 'acme-data',
    }) as any;

const build = (
    opts: {
        installation?: Record<string, unknown> | null;
        work?: ReturnType<typeof makeWork> | null;
    } = {},
) => {
    const installations = {
        findActiveByAccountLogin: jest
            .fn()
            .mockResolvedValue(
                opts.installation === undefined
                    ? { installationId: '169597044', deletedAt: null, suspendedAt: null }
                    : opts.installation,
            ),
    };
    const works = {
        findById: jest.fn().mockResolvedValue(opts.work === undefined ? makeWork() : opts.work),
    };
    const service = new SiteGitTokenService(installations as any, works as any);
    return { service, installations, works };
};

const enable = () => {
    process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED = 'true';
    process.env.EVER_WORKS_SITE_GIT_TOKEN_KEY = KEY;
    process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL = 'https://api.ever.works';
};

describe('SiteGitTokenService', () => {
    let fetchSpy: jest.SpyInstance | undefined;

    beforeEach(() => {
        mockAppId.mockReturnValue('5249501');
        mockPrivateKey.mockReturnValue('-----BEGIN KEY-----');
        mockRequestToken.mockReset();
        mockRequestToken.mockResolvedValue({
            token: 'ghs_scoped',
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
    });
    afterEach(() => {
        for (const key of ENV_KEYS) delete process.env[key];
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
    });

    describe('configuration', () => {
        it('is disabled by default', () => {
            const { service } = build();
            expect(SiteGitTokenService.isEnabled()).toBe(false);
            expect(service.configurationGap()).toBe('disabled');
        });

        it('needs the signing key, a broker URL and the App when enabled', () => {
            const { service } = build();
            process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED = 'true';
            expect(service.configurationGap()).toBe('not-configured');

            process.env.EVER_WORKS_SITE_GIT_TOKEN_KEY = KEY;
            expect(service.configurationGap()).toBe('not-configured');

            process.env.PUBLIC_API_URL = 'https://api.ever.works';
            expect(service.configurationGap()).toBeNull();

            mockAppId.mockReturnValue(undefined);
            expect(service.configurationGap()).toBe('not-configured');
        });

        it('refuses a signing key shorter than 32 characters', () => {
            enable();
            process.env.EVER_WORKS_SITE_GIT_TOKEN_KEY = 'short';
            const { service } = build();
            expect(service.configurationGap()).toBe('not-configured');
            expect(service.deriveSecret('work-1')).toBeNull();
        });

        it('defaults the managed orgs to ever-works and ever-works-cloud', () => {
            expect(SiteGitTokenService.managedOrgs()).toEqual(['ever-works', 'ever-works-cloud']);
            process.env.EVER_WORKS_SITE_GIT_TOKEN_ORGS = ' Ever-Works , ';
            expect(SiteGitTokenService.managedOrgs()).toEqual(['ever-works']);
        });

        it('builds the broker URL from the origin only, and refuses plain http', () => {
            enable();
            const { service } = build();
            process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL = 'https://api.ever.works/api/';
            expect(service.brokerUrl('work-1')).toBe(
                'https://api.ever.works/api/sites/work-1/git-token',
            );

            process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL = 'http://api.ever.works';
            expect(service.brokerUrl('work-1')).toBeNull();

            process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL = 'http://localhost:3100';
            expect(service.brokerUrl('w')).toBe('http://localhost:3100/api/sites/w/git-token');
        });
    });

    describe('per-site secret', () => {
        it('is deterministic per Work and different across Works', () => {
            enable();
            const { service } = build();
            const a = service.deriveSecret('work-a');
            expect(a).toMatch(/^ewsgt_[0-9a-f]{64}$/);
            expect(service.deriveSecret('work-a')).toBe(a);
            expect(service.deriveSecret('work-b')).not.toBe(a);
        });

        it('changes when the signing key rotates', () => {
            enable();
            const { service } = build();
            const before = service.deriveSecret('work-a');
            process.env.EVER_WORKS_SITE_GIT_TOKEN_KEY = 'z'.repeat(48);
            expect(service.deriveSecret('work-a')).not.toBe(before);
        });

        it("verifies only the Work's own secret", () => {
            enable();
            const { service } = build();
            const secret = service.deriveSecret('work-a') as string;
            expect(service.verifySecret('work-a', secret)).toBe(true);
            expect(service.verifySecret('work-a', ` ${secret} `)).toBe(true);
            expect(service.verifySecret('work-b', secret)).toBe(false);
            expect(service.verifySecret('work-a', secret.slice(0, -1))).toBe(false);
            expect(service.verifySecret('work-a', '')).toBe(false);
            expect(service.verifySecret('work-a', undefined)).toBe(false);
        });
    });

    describe('resolveTarget', () => {
        it('maps a managed-org Work to its data repo and installation', async () => {
            enable();
            const { service } = build();
            await expect(service.resolveTarget(makeWork({ owner: 'Ever-Works' }))).resolves.toEqual(
                {
                    owner: 'ever-works',
                    repo: 'acme-data',
                    installationId: '169597044',
                },
            );
        });

        it('refuses an owner outside the managed orgs', async () => {
            enable();
            const { service, installations } = build();
            await expect(
                service.resolveTarget(makeWork({ owner: 'someone' })),
            ).rejects.toMatchObject({
                reason: 'unmanaged-owner',
            });
            expect(installations.findActiveByAccountLogin).not.toHaveBeenCalled();
        });

        it.each([
            ['https://github.com/ever-works/acme-data', 'acme-data'],
            ['https://github.com/ever-works/acme-data.git', 'acme-data'],
            ['https://github.com/other-org/acme-data', null],
            ['https://gitlab.com/ever-works/acme-data', null],
            ['owner/acme-data', null],
            ['..', null],
        ])('reads DATA_REPOSITORY %s as %s', (raw, expected) => {
            expect(SiteGitTokenService.bareRepositoryName(raw, 'ever-works')).toBe(expected);
        });

        it('falls back to GitHub when the platform has no installation row', async () => {
            enable();
            const { service } = build({ installation: null });
            fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
                ok: true,
                json: async () => ({ id: 98765, suspended_at: null }),
            } as unknown as Response);

            const target = await service.resolveTarget(makeWork({ owner: 'ever-works-cloud' }));

            expect(target.installationId).toBe('98765');
            expect(fetchSpy).toHaveBeenCalledWith(
                'https://api.github.com/orgs/ever-works-cloud/installation',
                expect.anything(),
            );
        });

        it('refuses when the App is installed nowhere for the owner', async () => {
            enable();
            const { service } = build({ installation: null });
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue({ ok: false, status: 404 } as unknown as Response);

            await expect(service.resolveTarget(makeWork())).rejects.toMatchObject({
                reason: 'no-installation',
            });
        });

        it('treats a suspended installation row as no installation', async () => {
            enable();
            const { service } = build({
                installation: { installationId: '1', deletedAt: null, suspendedAt: new Date() },
            });
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue({ ok: false, status: 404 } as unknown as Response);

            await expect(service.resolveTarget(makeWork())).rejects.toBeInstanceOf(
                SiteGitTokenError,
            );
        });
    });

    describe('mintForWork', () => {
        it('narrows the token to the one data repo and contents:write', async () => {
            enable();
            const { service } = build();

            const minted = await service.mintForWork(makeWork());

            expect(minted).toMatchObject({
                token: 'ghs_scoped',
                repository: 'ever-works/acme-data',
            });
            expect(mockRequestToken).toHaveBeenCalledWith(
                '169597044',
                { appId: '5249501', privateKey: '-----BEGIN KEY-----' },
                { repositoryNames: ['acme-data'], permissions: { contents: 'write' } },
            );
        });

        it('reuses a cached token while it has more than 20 minutes left', async () => {
            enable();
            const { service } = build();
            await service.mintForWork(makeWork());
            await service.mintForWork(makeWork());
            expect(mockRequestToken).toHaveBeenCalledTimes(1);
        });

        it('mints again when the cached token is close to expiry', async () => {
            enable();
            mockRequestToken.mockResolvedValue({
                token: 'ghs_short',
                expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            });
            const { service } = build();
            await service.mintForWork(makeWork());
            await service.mintForWork(makeWork());
            expect(mockRequestToken).toHaveBeenCalledTimes(2);
        });

        it("never serves a cached token for a different repo (the Work's data repo moved)", async () => {
            enable();
            const { service } = build();
            await service.mintForWork(makeWork({ dataRepo: 'old-data' }));
            const minted = await service.mintForWork(makeWork({ dataRepo: 'new-data' }));
            expect(minted.repository).toBe('ever-works/new-data');
            expect(mockRequestToken).toHaveBeenCalledTimes(2);
        });

        it('shares one in-flight mint between concurrent callers', async () => {
            enable();
            const { service } = build();
            await Promise.all([service.mintForWork(makeWork()), service.mintForWork(makeWork())]);
            expect(mockRequestToken).toHaveBeenCalledTimes(1);
        });

        it('turns a GitHub refusal into mint-failed', async () => {
            enable();
            mockRequestToken.mockRejectedValue(new Error('422 Unprocessable Entity'));
            const { service } = build();
            await expect(service.mintForWork(makeWork())).rejects.toMatchObject({
                reason: 'mint-failed',
            });
        });
    });

    describe('siteEnvFor (deploy time)', () => {
        it('is null when the broker is off, so the deploy keeps the env-token path', async () => {
            const { service } = build();
            await expect(service.siteEnvFor(makeWork())).resolves.toBeNull();
            expect(mockRequestToken).not.toHaveBeenCalled();
        });

        it('is null when enabled but not configured', async () => {
            process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED = 'true';
            const { service } = build();
            await expect(service.siteEnvFor(makeWork())).resolves.toBeNull();
        });

        it('is null for an unmanaged owner or a missing installation', async () => {
            enable();
            const { service } = build();
            await expect(service.siteEnvFor(makeWork({ owner: 'acme' }))).resolves.toBeNull();

            const noInstall = build({ installation: null });
            fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
            await expect(noInstall.service.siteEnvFor(makeWork())).resolves.toBeNull();
        });

        it('returns the broker URL, the site secret and a bootstrap token', async () => {
            enable();
            const { service } = build();

            const env = await service.siteEnvFor(makeWork());

            expect(env).toEqual({
                url: 'https://api.ever.works/api/sites/work-1/git-token',
                secret: service.deriveSecret('work-1'),
                bootstrap: expect.objectContaining({ token: 'ghs_scoped' }),
            });
        });

        it('still returns the broker env when the bootstrap mint fails', async () => {
            enable();
            mockRequestToken.mockRejectedValue(new Error('502'));
            const { service } = build();

            const env = await service.siteEnvFor(makeWork());

            expect(env?.bootstrap).toBeNull();
            expect(env?.secret).toBe(service.deriveSecret('work-1'));
        });
    });

    describe('mintForSite (the endpoint)', () => {
        it('refuses a wrong secret before reading the Work', async () => {
            enable();
            const { service, works } = build();
            await expect(service.mintForSite('work-1', 'ewsgt_nope')).resolves.toBeNull();
            expect(works.findById).not.toHaveBeenCalled();
            expect(mockRequestToken).not.toHaveBeenCalled();
        });

        it("refuses another Work's secret", async () => {
            enable();
            const { service } = build();
            const other = service.deriveSecret('work-2');
            await expect(service.mintForSite('work-1', other)).resolves.toBeNull();
        });

        it('answers null for an unknown Work even with a valid-looking secret', async () => {
            enable();
            const { service } = build({ work: null });
            const secret = service.deriveSecret('ghost');
            await expect(service.mintForSite('ghost', secret)).resolves.toBeNull();
        });

        it("mints for the Work's own data repo with the right secret", async () => {
            enable();
            const { service } = build();
            const minted = await service.mintForSite('work-1', service.deriveSecret('work-1'));
            expect(minted).toMatchObject({
                token: 'ghs_scoped',
                repository: 'ever-works/acme-data',
            });
        });

        it('throws disabled when the broker is off', async () => {
            const { service } = build();
            await expect(service.mintForSite('work-1', 'x')).rejects.toMatchObject({
                reason: 'disabled',
            });
        });
    });
});
