import { Logger } from '@nestjs/common';
import { DemoFeatureDisabledError, type DemoRepoLedgerPort } from '../../demo';
import { EverWorksGitProvider } from '../ever-works-git.provider';
import {
    EverWorksGitDeletionRefusedError,
    EverWorksGitMisconfiguredError,
    EverWorksGitRequestError,
    type EverWorksProviderWorkRef,
} from '../types';

/**
 * Platform demo mode — the repository ledger at the provider (design §5.2.4 "Repo ledger").
 *
 * Every repository `EverWorksGitProvider` creates on a demo instance is written to the ledger
 * with GitHub's id from the create response and the sandbox (the Work owner) it belongs to; the
 * sweeper deletes exactly those later. A create that does not end in GitHub's 201 records
 * nothing, and a demo instance with no ledger bound refuses to create at all (ruling R22): an
 * unledgered repository could never be swept.
 *
 * The lookup and delete the sweeper uses go to `GET` / `DELETE /repos/{owner}/{name}` with the
 * platform PAT, follow no redirect, and never touch a list endpoint.
 */

const ORG = 'ever-works-cloud';
const SANDBOX_ID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

function work(userSlug = 'demo-1a2b3c4d'): EverWorksProviderWorkRef {
    return {
        id: 'b8a4f8e0-1234-4def-aaaa-bbbbbbbbbbbb',
        slug: 'foo',
        userId: SANDBOX_ID,
        userSlug,
        description: 'A curated directory',
    };
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function created(name: string, id: number): Response {
    return json(201, {
        id,
        name,
        owner: { login: ORG },
        full_name: `${ORG}/${name}`,
        html_url: `https://github.com/${ORG}/${name}`,
        clone_url: `https://github.com/${ORG}/${name}.git`,
        private: true,
    });
}

function repoBody(owner: string, name: string, id: number): Response {
    return json(200, {
        id,
        name,
        owner: { login: owner },
        full_name: `${owner}/${name}`,
    });
}

function nameTaken(): Response {
    return json(422, {
        message: 'Validation Failed',
        errors: [{ code: 'custom', message: 'name already exists on this account' }],
    });
}

function ledgerDouble(): DemoRepoLedgerPort & { record: jest.Mock } {
    return { record: jest.fn().mockResolvedValue(undefined) };
}

type FetchCall = { url: string; method: string; init: RequestInit };

/** Records every request the provider makes, across the whole file. */
const requests: FetchCall[] = [];

function recordingFetch(...responses: Response[]): jest.Mock {
    const queue = [...responses];
    return jest.fn(async (url: string, init: RequestInit = {}) => {
        requests.push({ url, method: (init.method ?? 'GET').toUpperCase(), init });
        const next = queue.shift();
        if (!next) throw new Error(`unexpected request ${init.method ?? 'GET'} ${url}`);
        return next;
    });
}

describe('EverWorksGitProvider — demo repository ledger', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
        process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = 'ghp_test';
        process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = ORG;
        process.env.DEMO_GITHUB_ORG = ORG;
        delete process.env.DEMO_REPO_PREFIX;
        delete process.env.DEMO;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.restoreAllMocks();
    });

    afterAll(() => {
        // Never a listing: the ledger is the only source of what to delete.
        const listings = requests.filter(
            ({ url, method }) =>
                method === 'GET' && /\/(orgs\/[^/]+|users\/[^/]+|user)\/repos(\?|$)/.test(url),
        );
        expect(listings).toEqual([]);
    });

    describe('createRepository with the demo on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
        });

        it("records the created repository with GitHub's id and the sandbox's user id", async () => {
            const ledger = ledgerDouble();
            const fetchImpl = recordingFetch(created('demo-1a2b3c4d-foo', 812345678));
            const provider = new EverWorksGitProvider(ledger);

            const repo = await provider.createRepository({ work: work(), fetchImpl });

            expect(repo).toMatchObject({ id: 812345678, owner: ORG, repo: 'demo-1a2b3c4d-foo' });
            expect(ledger.record).toHaveBeenCalledTimes(1);
            expect(ledger.record).toHaveBeenCalledWith({
                sandboxUserId: SANDBOX_ID,
                owner: ORG,
                name: 'demo-1a2b3c4d-foo',
                githubId: 812345678,
            });
        });

        it('records only the name GitHub created on the collision retry', async () => {
            const ledger = ledgerDouble();
            const fetchImpl = recordingFetch(
                nameTaken(),
                created('demo-1a2b3c4d-foo-b8a4f8e', 812345679),
            );
            const provider = new EverWorksGitProvider(ledger);

            await provider.createRepository({ work: work(), fetchImpl });

            expect(ledger.record).toHaveBeenCalledTimes(1);
            expect(ledger.record).toHaveBeenCalledWith({
                sandboxUserId: SANDBOX_ID,
                owner: ORG,
                name: 'demo-1a2b3c4d-foo-b8a4f8e',
                githubId: 812345679,
            });
        });

        it('records nothing when GitHub refuses the create', async () => {
            const ledger = ledgerDouble();
            const fetchImpl = recordingFetch(json(500, { message: 'Server Error' }));
            const provider = new EverWorksGitProvider(ledger);

            await expect(
                provider.createRepository({ work: work(), fetchImpl }),
            ).rejects.toBeInstanceOf(EverWorksGitRequestError);
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('records nothing when both names are taken (neither repository is ours)', async () => {
            const ledger = ledgerDouble();
            const fetchImpl = recordingFetch(nameTaken(), nameTaken());
            const provider = new EverWorksGitProvider(ledger);

            await expect(
                provider.createRepository({ work: work(), fetchImpl }),
            ).rejects.toBeInstanceOf(EverWorksGitRequestError);
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('records nothing for a name the demo prefix refuses', async () => {
            const ledger = ledgerDouble();
            const fetchImpl = recordingFetch();
            const provider = new EverWorksGitProvider(ledger);

            await expect(
                provider.createRepository({ work: work('anon-x'), fetchImpl }),
            ).rejects.toBeInstanceOf(DemoFeatureDisabledError);
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('records a null id when the response carries none', async () => {
            const ledger = ledgerDouble();
            const fetchImpl = recordingFetch(
                json(201, {
                    name: 'demo-1a2b3c4d-foo',
                    owner: { login: ORG },
                    full_name: `${ORG}/demo-1a2b3c4d-foo`,
                    html_url: '',
                    clone_url: '',
                    private: true,
                }),
            );
            const provider = new EverWorksGitProvider(ledger);

            await provider.createRepository({ work: work(), fetchImpl });

            expect(ledger.record).toHaveBeenCalledWith(
                expect.objectContaining({ githubId: null, name: 'demo-1a2b3c4d-foo' }),
            );
        });

        it('fails the create, naming the repository, when the ledger cannot record it', async () => {
            const ledger = ledgerDouble();
            ledger.record.mockRejectedValue(new Error('database is locked'));
            const errors = jest
                .spyOn(Logger.prototype, 'error')
                .mockImplementation(() => undefined);
            const fetchImpl = recordingFetch(created('demo-1a2b3c4d-foo', 812345678));
            const provider = new EverWorksGitProvider(ledger);

            await expect(provider.createRepository({ work: work(), fetchImpl })).rejects.toThrow(
                'database is locked',
            );
            expect(errors).toHaveBeenCalledWith(
                expect.stringContaining(`${ORG}/demo-1a2b3c4d-foo (id 812345678)`),
            );
        });

        it('refuses to create with no ledger bound, before any GitHub call (R22), and says so once', async () => {
            const errors = jest
                .spyOn(Logger.prototype, 'error')
                .mockImplementation(() => undefined);
            const fetchImpl = recordingFetch();
            const provider = new EverWorksGitProvider();

            for (let attempt = 0; attempt < 2; attempt += 1) {
                const result = provider.createRepository({ work: work(), fetchImpl });
                await expect(result).rejects.toBeInstanceOf(DemoFeatureDisabledError);
                await expect(result).rejects.toMatchObject({
                    feature: 'repository creation (ledger not configured)',
                    code: 'DEMO_DISABLED',
                });
            }
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(errors).toHaveBeenCalledTimes(1);
            expect(errors.mock.calls[0][0]).toMatch(/DEMO_REPO_LEDGER/);
        });
    });

    describe('createRepository with the demo off', () => {
        it('calls no ledger, even one that is bound', async () => {
            const ledger = ledgerDouble();
            const fetchImpl = recordingFetch(created('anon-x-foo', 812345680));
            const provider = new EverWorksGitProvider(ledger);

            const repo = await provider.createRepository({ work: work('anon-x'), fetchImpl });

            expect(repo.id).toBe(812345680);
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('creates with no ledger bound', async () => {
            const fetchImpl = recordingFetch(created('anon-x-foo', 812345681));
            const provider = new EverWorksGitProvider();

            await expect(
                provider.createRepository({ work: work('anon-x'), fetchImpl }),
            ).resolves.toMatchObject({ repo: 'anon-x-foo' });
        });
    });

    describe('getRepositoryId', () => {
        it("answers the live repository's id from GET /repos/{owner}/{name} with the PAT", async () => {
            const fetchImpl = recordingFetch(repoBody(ORG, 'demo-1a2b3c4d-foo', 812345678));
            const provider = new EverWorksGitProvider();

            await expect(
                provider.getRepositoryId(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
            ).resolves.toBe(812345678);

            const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
            expect(url).toBe(`https://api.github.com/repos/${ORG}/demo-1a2b3c4d-foo`);
            expect(init.method).toBe('GET');
            expect(init.redirect).toBe('manual');
            expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_test');
        });

        it('answers null on 404 (the repository is gone)', async () => {
            const fetchImpl = recordingFetch(json(404, { message: 'Not Found' }));
            const provider = new EverWorksGitProvider();

            await expect(
                provider.getRepositoryId(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
            ).resolves.toBeNull();
        });

        it('encodes the coordinates into the path', async () => {
            const fetchImpl = recordingFetch(json(404, {}));
            const provider = new EverWorksGitProvider();

            await provider.getRepositoryId(ORG, 'demo-x/../../orgs', { fetchImpl });

            expect(fetchImpl.mock.calls[0][0]).toBe(
                `https://api.github.com/repos/${ORG}/demo-x%2F..%2F..%2Forgs`,
            );
        });

        it.each([301, 302, 307])(
            'throws on a %p redirect (renamed or moved: not the repository asked for)',
            async (status) => {
                const fetchImpl = recordingFetch(
                    new Response(null, {
                        status,
                        headers: { location: 'https://api.github.com/repositories/1' },
                    }),
                );
                const provider = new EverWorksGitProvider();

                await expect(
                    provider.getRepositoryId(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
                ).rejects.toBeInstanceOf(EverWorksGitRequestError);
            },
        );

        it('throws when GitHub answers for a different repository', async () => {
            const fetchImpl = recordingFetch(repoBody(ORG, 'customer-site', 5));
            const provider = new EverWorksGitProvider();

            await expect(
                provider.getRepositoryId(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
            ).rejects.toBeInstanceOf(EverWorksGitRequestError);
        });

        it('throws on any other status', async () => {
            const fetchImpl = recordingFetch(json(403, { message: 'Forbidden' }));
            const provider = new EverWorksGitProvider();

            await expect(
                provider.getRepositoryId(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
            ).rejects.toMatchObject({ status: 403 });
        });

        it('needs the PAT when no transport is injected', async () => {
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = '';
            const provider = new EverWorksGitProvider();

            await expect(provider.getRepositoryId(ORG, 'demo-1a2b3c4d-foo')).rejects.toBeInstanceOf(
                EverWorksGitMisconfiguredError,
            );
        });
    });

    describe('deleteRepository', () => {
        describe('with the demo on', () => {
            beforeEach(() => {
                process.env.DEMO = 'true';
            });

            it('deletes with DELETE /repos/{owner}/{name} and the PAT: 204 is "deleted"', async () => {
                const fetchImpl = recordingFetch(new Response(null, { status: 204 }));
                const provider = new EverWorksGitProvider();

                await expect(
                    provider.deleteRepository(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
                ).resolves.toBe('deleted');

                const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
                expect(url).toBe(`https://api.github.com/repos/${ORG}/demo-1a2b3c4d-foo`);
                expect(init.method).toBe('DELETE');
                expect(init.redirect).toBe('manual');
                expect((init.headers as Record<string, string>).authorization).toBe(
                    'Bearer ghp_test',
                );
            });

            it('answers "gone" on 404', async () => {
                const fetchImpl = recordingFetch(json(404, { message: 'Not Found' }));
                const provider = new EverWorksGitProvider();

                await expect(
                    provider.deleteRepository(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
                ).resolves.toBe('gone');
            });

            it.each([307, 403, 500])('throws on %p', async (status) => {
                const fetchImpl = recordingFetch(
                    new Response(status === 307 ? null : '{"message":"no"}', { status }),
                );
                const provider = new EverWorksGitProvider();

                await expect(
                    provider.deleteRepository(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
                ).rejects.toBeInstanceOf(EverWorksGitRequestError);
            });

            it.each([
                ['another owner', 'ever-works', 'demo-1a2b3c4d-foo'],
                ['an owner of another case', 'Ever-Works-Cloud', 'demo-1a2b3c4d-foo'],
                ['a name without the prefix', ORG, 'anon-1a2b3c4d-foo'],
                ['a customer repository', ORG, 'acme-website'],
            ])('refuses %s before any GitHub call', async (_label, owner, name) => {
                const fetchImpl = recordingFetch();
                const provider = new EverWorksGitProvider();

                await expect(
                    provider.deleteRepository(owner, name, { fetchImpl }),
                ).rejects.toBeInstanceOf(EverWorksGitDeletionRefusedError);
                expect(fetchImpl).not.toHaveBeenCalled();
            });

            it('refuses when DEMO_GITHUB_ORG is not set', async () => {
                process.env.DEMO_GITHUB_ORG = '';
                const fetchImpl = recordingFetch();
                const provider = new EverWorksGitProvider();

                await expect(
                    provider.deleteRepository('', 'demo-1a2b3c4d-foo', { fetchImpl }),
                ).rejects.toBeInstanceOf(EverWorksGitDeletionRefusedError);
                expect(fetchImpl).not.toHaveBeenCalled();
            });
        });

        it('refuses everything with the demo off', async () => {
            const fetchImpl = recordingFetch();
            const provider = new EverWorksGitProvider();

            await expect(
                provider.deleteRepository(ORG, 'demo-1a2b3c4d-foo', { fetchImpl }),
            ).rejects.toBeInstanceOf(EverWorksGitDeletionRefusedError);
            expect(fetchImpl).not.toHaveBeenCalled();
        });
    });
});
