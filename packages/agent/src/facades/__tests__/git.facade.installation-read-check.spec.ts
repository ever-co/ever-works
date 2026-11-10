import { requestGitHubAppInstallationAccessTokenDetails } from '@src/utils';

import { GitFacadeService } from '../git.facade';

jest.mock('@src/utils', () => ({
    requestGitHubAppInstallationAccessTokenDetails: jest.fn(),
}));

/**
 * `GitFacadeService.canInstallationStandInForUser` — the LIVE half of the
 * Repository Work installation fallback (`WorkLifecycleService`).
 *
 * The caller has already decided, from platform rows, that the installation
 * is the user's and lists the repository. This method answers what a database
 * cannot, with a read-only installation token narrowed to the snapshot's
 * repository id:
 *
 *   1. the installation still covers that repository (the narrowed mint);
 *   2. the requested NAME still means that repository (id + current name);
 *   3. the USER can read it themselves, according to GitHub, for the GitHub
 *      account the platform has on record for them — bound to its id.
 *
 * `false` (never a throw) for everything that is not a confirmed yes.
 */

const INPUT = {
    installationId: '4242',
    githubRepoId: '556677',
    owner: 'ever-co',
    repo: 'ever-works',
    userId: 'user-1',
} as const;
const ACTIVE = { id: 'inst-entity-1', installationId: '4242', deletedAt: null, suspendedAt: null };

/** The plugin-integration connection the platform stores for the user. */
const PLUGIN_ACCOUNT = {
    userId: 'user-1',
    providerId: 'plugin:github',
    accountId: '9001',
    username: 'octo-member',
    metadata: { oauthUserId: '9001' },
};
/** The social sign-in connection. */
const SIGN_IN_ACCOUNT = {
    userId: 'user-1',
    providerId: 'github',
    accountId: '9002',
    username: 'octo-signin',
    metadata: { providerUserId: '9002', login: 'octo-signin' },
};

const mint = jest.mocked(requestGitHubAppInstallationAccessTokenDetails);

function makeFacade(
    options: {
        installation?: unknown;
        accounts?: Record<string, unknown>;
        plugin?: Record<string, unknown>;
        pluginState?: string;
    } = {},
) {
    const installations = {
        findByInstallationId: jest.fn(async () =>
            'installation' in options ? options.installation : ACTIVE,
        ),
    };
    const accounts: Record<string, unknown> = options.accounts ?? {
        'plugin:github': PLUGIN_ACCOUNT,
    };
    const authAccounts = {
        findProviderAccount: jest.fn(
            async (_userId: string, providerId: string) => accounts[providerId] ?? null,
        ),
    };
    const plugin = {
        id: 'github',
        getRepositoryIdentity: jest.fn(async () => ({
            id: '556677',
            fullName: 'ever-co/ever-works',
        })),
        getUserRepositoryPermission: jest.fn(async () => ({
            permission: 'read',
            userId: '9001',
            login: 'octo-member',
        })),
        ...(options.plugin ?? {}),
    };
    // A real registry entry, so the facade's own `resolvePlugin` (enabled for
    // the user's scope, loaded, materialised) is what hands the plugin over.
    const registry = {
        get: jest.fn(() => ({
            plugin,
            manifest: { capabilities: ['git-provider'] },
            state: options.pluginState ?? 'loaded',
        })),
        isPluginEnabledForScope: jest.fn(async () => true),
    };
    const facade = new GitFacadeService(
        registry as never,
        authAccounts as never,
        {} as never,
        {} as never,
        installations as never,
    );
    return { facade, installations, authAccounts, plugin, registry };
}

describe('GitFacadeService.canInstallationStandInForUser', () => {
    const saved = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY };

    beforeEach(() => {
        mint.mockReset();
        mint.mockResolvedValue({ token: 'ghs_read_only', expiresAt: null });
        process.env.GITHUB_APP_ID = 'app-1';
        process.env.GITHUB_APP_PRIVATE_KEY = 'pem-placeholder';
    });

    afterAll(() => {
        if (saved.id === undefined) delete process.env.GITHUB_APP_ID;
        else process.env.GITHUB_APP_ID = saved.id;
        if (saved.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
        else process.env.GITHUB_APP_PRIVATE_KEY = saved.key;
    });

    // ─────────────────────────────────────────────────────────────────────
    // The one situation that passes.
    // ─────────────────────────────────────────────────────────────────────
    it('passes when the mint, the id-bound read and the user’s own permission all agree', async () => {
        const { facade, installations, authAccounts, plugin, registry } = makeFacade();

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(true);

        expect(installations.findByInstallationId).toHaveBeenCalledWith('4242');
        // The plugin is resolved for THIS user's scope.
        expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
            'github',
            undefined,
            'user-1',
        );
        // The GitHub identity comes from the platform's stored connection.
        expect(authAccounts.findProviderAccount).toHaveBeenCalledWith('user-1', 'plugin:github');
        expect(mint).toHaveBeenCalledTimes(1);
        expect(mint).toHaveBeenCalledWith(
            '4242',
            { appId: 'app-1', privateKey: 'pem-placeholder' },
            {
                repositoryIds: ['556677'],
                permissions: { contents: 'read', metadata: 'read' },
            },
        );
        // Nothing that can write was asked for.
        expect(Object.values(mint.mock.calls[0][2]?.permissions ?? {})).toEqual(['read', 'read']);
        // Both reads use the NARROWED token, and the permission is asked about
        // the stored login.
        expect(plugin.getRepositoryIdentity).toHaveBeenCalledWith(
            'ever-co',
            'ever-works',
            'ghs_read_only',
        );
        expect(plugin.getUserRepositoryPermission).toHaveBeenCalledWith(
            'ever-co',
            'ever-works',
            'octo-member',
            'ghs_read_only',
        );
    });

    it.each(['read', 'write', 'admin'])('accepts the `%s` permission level', async (permission) => {
        const { facade } = makeFacade({
            plugin: {
                getUserRepositoryPermission: jest.fn(async () => ({
                    permission,
                    userId: '9001',
                    login: 'octo-member',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(true);
    });

    it('is never cached — every check asks GitHub again', async () => {
        const { facade, plugin } = makeFacade();

        await facade.canInstallationStandInForUser(INPUT);
        await facade.canInstallationStandInForUser(INPUT);

        expect(mint).toHaveBeenCalledTimes(2);
        expect(plugin.getRepositoryIdentity).toHaveBeenCalledTimes(2);
        expect(plugin.getUserRepositoryPermission).toHaveBeenCalledTimes(2);
    });

    // ─────────────────────────────────────────────────────────────────────
    // (2) The name must still mean the snapshot's repository id.
    // ─────────────────────────────────────────────────────────────────────
    it('refuses when the name now belongs to a DIFFERENT repository id (renamed repo, new repo of the old name)', async () => {
        const { facade, plugin } = makeFacade({
            plugin: {
                // The by-name read succeeds — a public repository answers any
                // token — but it is not the repository the snapshot row is about.
                getRepositoryIdentity: jest.fn(async () => ({
                    id: '999999',
                    fullName: 'ever-co/ever-works',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        // The user is never even asked about: the repository is the wrong one.
        expect(plugin.getUserRepositoryPermission).not.toHaveBeenCalled();
    });

    it('refuses a name that only REDIRECTS to the covered repository (same id, different current name)', async () => {
        const { facade, plugin } = makeFacade({
            plugin: {
                getRepositoryIdentity: jest.fn(async () => ({
                    id: '556677',
                    fullName: 'ever-co/ever-works-platform',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(plugin.getUserRepositoryPermission).not.toHaveBeenCalled();
    });

    it('compares the current name case-insensitively', async () => {
        const { facade } = makeFacade({
            plugin: {
                getRepositoryIdentity: jest.fn(async () => ({
                    id: '556677',
                    fullName: 'Ever-Co/Ever-Works',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(true);
    });

    it('refuses when the repository read says no (404/403 from the provider)', async () => {
        const { facade, plugin } = makeFacade({
            plugin: { getRepositoryIdentity: jest.fn(async () => null) },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(plugin.getUserRepositoryPermission).not.toHaveBeenCalled();
    });

    it('refuses a snapshot repository id that is not a positive integer, without minting', async () => {
        for (const githubRepoId of ['', 'abc', '12ab', '0', '-5', '1e3', ' ']) {
            const { facade } = makeFacade();
            await expect(
                facade.canInstallationStandInForUser({ ...INPUT, githubRepoId }),
            ).resolves.toBe(false);
        }
        expect(mint).not.toHaveBeenCalled();
    });

    // ─────────────────────────────────────────────────────────────────────
    // (3) The USER must be able to read it themselves.
    // ─────────────────────────────────────────────────────────────────────
    it('refuses a user GitHub says has NO access — an installation owner who was removed from the organization', async () => {
        const { facade } = makeFacade({
            plugin: {
                getUserRepositoryPermission: jest.fn(async () => ({
                    permission: 'none',
                    userId: '9001',
                    login: 'octo-member',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
    });

    it('refuses when GitHub does not answer for that user (404)', async () => {
        const { facade } = makeFacade({
            plugin: { getUserRepositoryPermission: jest.fn(async () => null) },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
    });

    it('refuses a permission value it does not recognise', async () => {
        const { facade } = makeFacade({
            plugin: {
                getUserRepositoryPermission: jest.fn(async () => ({
                    permission: 'triage-ish',
                    userId: '9001',
                    login: 'octo-member',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
    });

    it('refuses when GitHub answered about a DIFFERENT account id (the stored login was renamed and re-registered)', async () => {
        const { facade } = makeFacade({
            plugin: {
                // Somebody else now holds the login, and THEY can read it.
                getUserRepositoryPermission: jest.fn(async () => ({
                    permission: 'admin',
                    userId: '7777',
                    login: 'octo-member',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
    });

    it('refuses when GitHub reports no account id to bind the answer to', async () => {
        const { facade } = makeFacade({
            plugin: {
                getUserRepositoryPermission: jest.fn(async () => ({
                    permission: 'read',
                    userId: null,
                    login: 'octo-member',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
    });

    // ─────────────────────────────────────────────────────────────────────
    // The GitHub identity is the platform's stored connection, or nothing.
    // ─────────────────────────────────────────────────────────────────────
    it('refuses, without minting, a user with NO linked GitHub identity', async () => {
        const { facade, plugin } = makeFacade({ accounts: {} });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(mint).not.toHaveBeenCalled();
        expect(plugin.getRepositoryIdentity).not.toHaveBeenCalled();
    });

    it('falls back to the sign-in connection when there is no plugin-integration one, preferring its recorded login', async () => {
        const { facade, authAccounts, plugin } = makeFacade({
            accounts: { github: SIGN_IN_ACCOUNT },
            plugin: {
                getUserRepositoryPermission: jest.fn(async () => ({
                    permission: 'write',
                    userId: '9002',
                    login: 'octo-signin',
                })),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(true);
        expect(authAccounts.findProviderAccount).toHaveBeenNthCalledWith(
            1,
            'user-1',
            'plugin:github',
        );
        expect(authAccounts.findProviderAccount).toHaveBeenNthCalledWith(2, 'user-1', 'github');
        expect(plugin.getUserRepositoryPermission).toHaveBeenCalledWith(
            'ever-co',
            'ever-works',
            'octo-signin',
            'ghs_read_only',
        );
    });

    it('uses the plugin-integration connection when both exist — the account git operations use', async () => {
        const { facade, plugin } = makeFacade({
            accounts: { 'plugin:github': PLUGIN_ACCOUNT, github: SIGN_IN_ACCOUNT },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(true);
        expect(plugin.getUserRepositoryPermission).toHaveBeenCalledWith(
            'ever-co',
            'ever-works',
            'octo-member',
            'ghs_read_only',
        );
    });

    it('does not need the stored connection to hold a usable token — only to say who the user is', async () => {
        const { facade } = makeFacade({
            accounts: {
                'plugin:github': {
                    ...PLUGIN_ACCOUNT,
                    accessToken: null,
                    accessTokenExpiresAt: new Date(0),
                    scope: 'read:user',
                },
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(true);
    });

    it.each([
        ['a non-numeric account id', { ...PLUGIN_ACCOUNT, accountId: 'octo-member' }],
        ['a synthetic account id', { ...PLUGIN_ACCOUNT, accountId: 'user-1:plugin:github' }],
        ['no login at all', { ...PLUGIN_ACCOUNT, username: null, metadata: null }],
        ['a login that is not a GitHub login', { ...PLUGIN_ACCOUNT, username: 'a/b' }],
        ['a row that belongs to another user', { ...PLUGIN_ACCOUNT, userId: 'someone-else' }],
    ])('refuses, without minting, a stored connection with %s', async (_label, account) => {
        const { facade } = makeFacade({ accounts: { 'plugin:github': account } });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(mint).not.toHaveBeenCalled();
    });

    it('never looks anything up for a request with no user id (an undefined filter would match some row)', async () => {
        const { facade, installations, authAccounts } = makeFacade();

        await expect(
            facade.canInstallationStandInForUser({ ...INPUT, userId: undefined as never }),
        ).resolves.toBe(false);

        expect(installations.findByInstallationId).not.toHaveBeenCalled();
        expect(authAccounts.findProviderAccount).not.toHaveBeenCalled();
        expect(mint).not.toHaveBeenCalled();
    });

    // ─────────────────────────────────────────────────────────────────────
    // (1) and everything around it.
    // ─────────────────────────────────────────────────────────────────────
    it('refuses, without minting, a missing, deleted or suspended installation', async () => {
        for (const installation of [
            null,
            { ...ACTIVE, deletedAt: new Date() },
            { ...ACTIVE, suspendedAt: new Date() },
        ]) {
            const { facade, plugin } = makeFacade({ installation });
            await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
            expect(plugin.getRepositoryIdentity).not.toHaveBeenCalled();
        }
        expect(mint).not.toHaveBeenCalled();
    });

    it('refuses, without minting, when the App credentials are unset', async () => {
        delete process.env.GITHUB_APP_PRIVATE_KEY;
        const { facade, plugin } = makeFacade();

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(mint).not.toHaveBeenCalled();
        expect(plugin.getRepositoryIdentity).not.toHaveBeenCalled();
    });

    it.each([['getRepositoryIdentity'], ['getUserRepositoryPermission']])(
        'refuses, without minting, a provider plugin that has no `%s`',
        async (method) => {
            const { facade } = makeFacade({ plugin: { [method]: undefined } });

            await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
            expect(mint).not.toHaveBeenCalled();
        },
    );

    it('refuses — never throws — when the provider plugin is not loaded', async () => {
        const { facade } = makeFacade({ pluginState: 'error' });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(mint).not.toHaveBeenCalled();
    });

    it('refuses — never throws — when GitHub refuses the narrowed mint (the installation no longer covers the repository)', async () => {
        mint.mockRejectedValue(
            new Error('Failed to create GitHub App installation token: 422 Unprocessable Entity'),
        );
        const { facade, plugin } = makeFacade();

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(plugin.getRepositoryIdentity).not.toHaveBeenCalled();
        expect(plugin.getUserRepositoryPermission).not.toHaveBeenCalled();
    });

    it.each([
        ['the repository read', 'getRepositoryIdentity'],
        ['the permission read', 'getUserRepositoryPermission'],
    ])('refuses — never throws — when %s fails', async (_label, method) => {
        const { facade } = makeFacade({
            plugin: {
                [method]: jest.fn(async () => {
                    throw Object.assign(new Error('Bad credentials'), { status: 401 });
                }),
            },
        });

        await expect(facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
    });

    it('refuses — never throws — when a platform lookup fails', async () => {
        const first = makeFacade();
        first.installations.findByInstallationId.mockRejectedValue(new Error('db down'));
        await expect(first.facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);

        const second = makeFacade();
        second.authAccounts.findProviderAccount.mockRejectedValue(new Error('db down'));
        await expect(second.facade.canInstallationStandInForUser(INPUT)).resolves.toBe(false);
        expect(mint).not.toHaveBeenCalled();
    });
});
