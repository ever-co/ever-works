import { requestGitHubAppInstallationAccessTokenDetails } from '@src/utils';

import { GitFacadeService } from '../git.facade';

jest.mock('@src/utils', () => ({
    requestGitHubAppInstallationAccessTokenDetails: jest.fn(),
}));

/**
 * `GitFacadeService.canInstallationReadRepository` — the LIVE half of the
 * Repository Work installation fallback (`WorkLifecycleService`).
 *
 * The caller has already decided, from platform rows, that the installation
 * is the user's and lists the repository. This method answers the one thing
 * a database cannot: does GitHub agree right now. It mints a read-only token
 * narrowed to the snapshot's repository id, reads the repository with it, and
 * answers `false` (never throws) for everything that is not a confirmed yes.
 */

const INPUT = {
    installationId: '4242',
    githubRepoId: '556677',
    owner: 'ever-co',
    repo: 'ever-works',
    userId: 'user-1',
} as const;
const ACTIVE = { id: 'inst-entity-1', installationId: '4242', deletedAt: null, suspendedAt: null };
const mint = jest.mocked(requestGitHubAppInstallationAccessTokenDetails);

function makeFacade(installation: unknown) {
    const installations = { findByInstallationId: jest.fn(async () => installation) };
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        installations as never,
    );
    // The provider read is the facade's own `hasRepositoryAccess`; it is
    // covered by `git.facade.spec.ts`. Here it is the seam.
    const read = jest.spyOn(facade, 'hasRepositoryAccess').mockResolvedValue(true);
    return { facade, installations, read };
}

describe('GitFacadeService.canInstallationReadRepository', () => {
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

    it('mints a token narrowed to the ONE repository id, read-only, and reads the repository with it', async () => {
        const { facade, installations, read } = makeFacade(ACTIVE);

        await expect(facade.canInstallationReadRepository(INPUT)).resolves.toBe(true);

        expect(installations.findByInstallationId).toHaveBeenCalledWith('4242');
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
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith('ever-co', 'ever-works', {
            providerId: 'github',
            userId: 'user-1',
            token: 'ghs_read_only',
        });
    });

    it('is never cached — every check asks GitHub again', async () => {
        const { facade } = makeFacade(ACTIVE);

        await facade.canInstallationReadRepository(INPUT);
        await facade.canInstallationReadRepository(INPUT);

        expect(mint).toHaveBeenCalledTimes(2);
    });

    it('answers false when the repository read says no (404/403 from the provider)', async () => {
        const { facade, read } = makeFacade(ACTIVE);
        read.mockResolvedValue(false);

        await expect(facade.canInstallationReadRepository(INPUT)).resolves.toBe(false);
    });

    it('answers false without minting for a missing, deleted or suspended installation', async () => {
        for (const installation of [
            null,
            { ...ACTIVE, deletedAt: new Date() },
            { ...ACTIVE, suspendedAt: new Date() },
        ]) {
            const { facade, read } = makeFacade(installation);
            await expect(facade.canInstallationReadRepository(INPUT)).resolves.toBe(false);
            expect(read).not.toHaveBeenCalled();
        }
        expect(mint).not.toHaveBeenCalled();
    });

    it('answers false without minting when the App credentials are unset', async () => {
        delete process.env.GITHUB_APP_PRIVATE_KEY;
        const { facade, read } = makeFacade(ACTIVE);

        await expect(facade.canInstallationReadRepository(INPUT)).resolves.toBe(false);
        expect(mint).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });

    it('answers false — never throws — when GitHub refuses the narrowed mint (the installation no longer covers the repository)', async () => {
        mint.mockRejectedValue(
            new Error('Failed to create GitHub App installation token: 422 Unprocessable Entity'),
        );
        const { facade, read } = makeFacade(ACTIVE);

        await expect(facade.canInstallationReadRepository(INPUT)).resolves.toBe(false);
        expect(read).not.toHaveBeenCalled();
    });

    it('answers false — never throws — when the read or the installation lookup fails', async () => {
        const first = makeFacade(ACTIVE);
        first.read.mockRejectedValue(new Error('Bad credentials'));
        await expect(first.facade.canInstallationReadRepository(INPUT)).resolves.toBe(false);

        const second = makeFacade(ACTIVE);
        second.installations.findByInstallationId.mockRejectedValue(new Error('db down'));
        await expect(second.facade.canInstallationReadRepository(INPUT)).resolves.toBe(false);
        expect(second.read).not.toHaveBeenCalled();
    });
});
