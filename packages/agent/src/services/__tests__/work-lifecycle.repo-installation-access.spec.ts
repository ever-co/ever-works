jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

import 'reflect-metadata';
import { ForbiddenException, Module } from '@nestjs/common';
import {
    OPTIONAL_DEPS_METADATA,
    PARAMTYPES_METADATA,
    SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { GitProviderNotFoundError, NoGitCredentialsError } from '@src/facades/git.facade';
import { CreateWorkDto } from '@src/dto/create-work.dto';
import type { User } from '@src/entities/user.entity';
import { GitHubAppInstallationRepository } from '@src/database/repositories/github-app-installation.repository';
import { GitHubAppInstallationRepoRepository } from '@src/database/repositories/github-app-installation-repository.repository';

/**
 * Repository Work — the GitHub App installation fallback of
 * `WorkLifecycleService.createWork` (`kind: 'repo'`).
 *
 * An organization that restricts OAuth app access hides its private
 * repositories from a member's OAuth token while the installed Ever Works
 * GitHub App reads them. Before the fallback such a repository could not be
 * registered at all (400, "not found or is not accessible").
 *
 * This is access-control code, so the suite pins both directions:
 *
 *   - the path that existed before is byte-for-byte unchanged when the
 *     owner's own account reads the repository;
 *   - the fallback is tried for exactly TWO probe outcomes (an answered
 *     "no", and "no git credential connected") and accepts exactly ONE
 *     situation: the caller's own, live installation whose snapshot lists the
 *     repository, confirmed by GitHub right now. Every near miss is refused
 *     with the SAME answer, with nothing persisted.
 *
 * What "confirmed by GitHub" means — the installation still covers the
 * repository id, the name still means that id, and the caller's own linked
 * GitHub account can read the repository — is the facade's
 * `canInstallationStandInForUser`, pinned in
 * `facades/__tests__/git.facade.installation-read-check.spec.ts`. Here it is
 * the seam: these specs prove WHEN it is asked, with WHAT, and that only a
 * strict `true` is accepted.
 */

const baseUser = { id: 'u-1', email: 'u@example.com' } as User;

const repoDto: CreateWorkDto = {
    slug: 'platform',
    name: 'Platform',
    description: 'A description',
    organization: false,
    gitProvider: 'github',
    kind: 'repo',
    repositoryUrl: 'https://github.com/ever-co/ever-works',
} as CreateWorkDto;

/** The caller's own, live installation on the repository's owner. */
const OWN_INSTALLATION = {
    id: 'inst-entity-1',
    installationId: '4242',
    accountLogin: 'ever-co',
    accountType: 'Organization',
    targetType: 'Organization',
    createdByUserId: baseUser.id,
    deletedAt: null,
    suspendedAt: null,
};

/** The snapshot row that says the installation covers the repository. */
const SNAPSHOT_ROW = {
    id: 'inst-repo-row-1',
    installationEntityId: OWN_INSTALLATION.id,
    githubRepoId: '556677',
    owner: 'ever-co',
    repo: 'ever-works',
    fullName: 'ever-co/ever-works',
    isPrivate: true,
    selected: true,
};

interface MockDeps {
    workRepo: {
        create: jest.Mock;
        updateGenerateStatus: jest.Mock;
        findRepositoryWorksWrapping: jest.Mock;
    };
    gitFacade: { hasRepositoryAccess: jest.Mock; canInstallationStandInForUser: jest.Mock };
    installations: { listByCreatedByUserId: jest.Mock };
    installationRepos: { listForInstallation: jest.Mock };
    eventEmitter: { emit: jest.Mock; emitAsync: jest.Mock };
    dataGenerator: { getItems: jest.Mock };
}

/**
 * Defaults model the gap: the owner's OAuth token CANNOT read the
 * repository, and the owner has one live installation that covers it and
 * that GitHub confirms. Each test changes exactly one of those facts.
 */
function makeService(options: { withInstallationRepositories?: boolean } = {}): {
    service: WorkLifecycleService;
    deps: MockDeps;
} {
    const workRepo = {
        create: jest.fn(async (data: Record<string, unknown>) => ({
            id: (data.id as string) ?? 'w-1',
            ...data,
            getRepoOwner: () => (data.owner as string) ?? 'evereq',
        })),
        updateGenerateStatus: jest.fn().mockResolvedValue(undefined),
        findRepositoryWorksWrapping: jest.fn().mockResolvedValue([]),
    };
    const userRepo = {
        findById: jest.fn().mockResolvedValue({ id: baseUser.id, onboardingState: null }),
    };
    const gitFacade = {
        hasRepositoryAccess: jest.fn().mockResolvedValue(false),
        canInstallationStandInForUser: jest.fn().mockResolvedValue(true),
    };
    const installations = {
        listByCreatedByUserId: jest.fn().mockResolvedValue([{ ...OWN_INSTALLATION }]),
    };
    const installationRepos = {
        listForInstallation: jest.fn().mockResolvedValue([{ ...SNAPSHOT_ROW }]),
    };
    const dataGenerator = { getItems: jest.fn().mockResolvedValue([]) };
    const templateCatalog = {
        getVisibleTemplateForUser: jest.fn().mockResolvedValue(null),
        getDefaultTemplateIdForUser: jest.fn().mockResolvedValue(null),
        getWebsiteTemplateIdForNewWork: jest.fn().mockResolvedValue(null),
    };
    const quota = { assertWithinQuota: jest.fn().mockResolvedValue(undefined) };
    const everWorksGit = {
        isEnabled: jest.fn().mockReturnValue(false),
        createRepository: jest.fn(),
    };
    const eventEmitter = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) };
    const everWorksDns = {
        getProvider: jest.fn().mockReturnValue(null),
        ensureWorkSubdomain: jest.fn().mockResolvedValue(undefined),
        removeWorkSubdomain: jest.fn().mockResolvedValue(undefined),
        ingressHostFor: jest.fn((slug: string) => `${slug}.ever.works`),
    };
    const funnel = { emit: jest.fn() };

    const withRepositories = options.withInstallationRepositories !== false;

    const service = new WorkLifecycleService(
        workRepo as never,
        userRepo as never,
        dataGenerator as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        templateCatalog as never,
        {} as never,
        quota as never,
        everWorksGit as never,
        everWorksDns as never,
        funnel as never,
        eventEmitter as never,
        // organizationRepository
        {} as never,
        gitFacade as never,
        // activityLog, appWorkCreate, appWorkDeletion, appWorksTelemetry,
        // domainEvents — all `@Optional()`, none read by the repo create path.
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // The two repositories the installation fallback reads. Appended
        // LAST and `@Optional()`; `withInstallationRepositories: false`
        // models a construction that stops before them.
        (withRepositories ? installations : undefined) as never,
        (withRepositories ? installationRepos : undefined) as never,
    );

    return {
        service,
        deps: {
            workRepo,
            gitFacade,
            installations,
            installationRepos,
            eventEmitter,
            dataGenerator,
        },
    };
}

/** The single refusal every near miss must produce, with nothing persisted. */
async function expectRefused(service: WorkLifecycleService, deps: MockDeps): Promise<string> {
    let message = '';
    await expect(
        service.createWork(repoDto, baseUser).catch((error) => {
            message = String(error?.response?.message ?? '');
            throw error;
        }),
    ).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({
            message: expect.stringContaining('not found or is not accessible'),
        }),
    });
    expect(deps.workRepo.create).not.toHaveBeenCalled();
    expect(deps.eventEmitter.emitAsync).not.toHaveBeenCalled();
    return message;
}

describe('WorkLifecycleService.createWork — repository kind, GitHub App installation fallback', () => {
    // ─────────────────────────────────────────────────────────────────────
    // 1. The path that existed before the fallback does not change at all.
    // ─────────────────────────────────────────────────────────────────────
    describe('when the owner’s own account reads the repository', () => {
        it('never looks at installations and persists no `auth` — unchanged', async () => {
            const { service, deps } = makeService();
            deps.gitFacade.hasRepositoryAccess.mockResolvedValue(true);

            const result = await service.createWork(repoDto, baseUser);

            expect(result.status).toBe('success');
            expect(deps.gitFacade.hasRepositoryAccess).toHaveBeenCalledTimes(1);
            expect(deps.gitFacade.hasRepositoryAccess).toHaveBeenCalledWith(
                'ever-co',
                'ever-works',
                { userId: baseUser.id, providerId: 'github' },
            );
            // The fallback did not run: no installation read, no GitHub call.
            expect(deps.installations.listByCreatedByUserId).not.toHaveBeenCalled();
            expect(deps.installationRepos.listForInstallation).not.toHaveBeenCalled();
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();

            const persisted = deps.workRepo.create.mock.calls[0][0];
            // Exactly the object the pre-fallback code wrote — `toEqual`, so an
            // extra key (an `auth`, say) fails this.
            expect(persisted.sourceRepository).toEqual({
                url: 'https://github.com/ever-co/ever-works',
                owner: 'ever-co',
                repo: 'ever-works',
                type: 'link_existing',
                importedAt: expect.any(Date),
                relatedRepositories: { data: { owner: 'ever-co', repo: 'ever-works' } },
            });
            expect('auth' in persisted.sourceRepository).toBe(false);
            expect(persisted.owner).toBe('ever-co');
            expect(persisted.gitProvider).toBe('github');
            expect(persisted.storageProvider).toBe('user-github');
            expect(persisted.deployProvider).toBeNull();
            expect(persisted.syncIntervalMinutes).toBe(0);
        });

        it('still refuses (409) a repository another account already wraps', async () => {
            const { service, deps } = makeService();
            deps.gitFacade.hasRepositoryAccess.mockResolvedValue(true);
            deps.workRepo.findRepositoryWorksWrapping.mockResolvedValue([
                { id: 'w-other', userId: 'someone-else', slug: 'their-platform' },
            ]);

            await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
                status: 409,
            });
            expect(deps.workRepo.create).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 2. The fallback: accepted in exactly one situation.
    // ─────────────────────────────────────────────────────────────────────
    describe('when the owner’s own account cannot read the repository', () => {
        it('accepts the caller’s own live installation that covers the repository, and persists the installation auth shape', async () => {
            const { service, deps } = makeService();

            const result = await service.createWork(repoDto, baseUser);

            expect(result.status).toBe('success');
            // Only the CALLER's installations were asked for.
            expect(deps.installations.listByCreatedByUserId).toHaveBeenCalledTimes(1);
            expect(deps.installations.listByCreatedByUserId).toHaveBeenCalledWith(baseUser.id);
            // Only THAT installation's snapshot was read.
            expect(deps.installationRepos.listForInstallation).toHaveBeenCalledTimes(1);
            expect(deps.installationRepos.listForInstallation).toHaveBeenCalledWith(
                OWN_INSTALLATION.id,
            );
            // The live check ran with ids taken from platform rows.
            expect(deps.gitFacade.canInstallationStandInForUser).toHaveBeenCalledTimes(1);
            expect(deps.gitFacade.canInstallationStandInForUser).toHaveBeenCalledWith({
                installationId: '4242',
                githubRepoId: '556677',
                owner: 'ever-co',
                repo: 'ever-works',
                userId: baseUser.id,
            });

            expect(deps.workRepo.create).toHaveBeenCalledTimes(1);
            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.kind).toBe('repo');
            expect(persisted.userId).toBe(baseUser.id);
            expect(persisted.owner).toBe('ever-co');
            expect(persisted.gitProvider).toBe('github');
            expect(persisted.sourceRepository).toEqual({
                url: 'https://github.com/ever-co/ever-works',
                owner: 'ever-co',
                repo: 'ever-works',
                type: 'link_existing',
                importedAt: expect.any(Date),
                relatedRepositories: { data: { owner: 'ever-co', repo: 'ever-works' } },
                // The shape `GitFacadeService.getInstallationTokenForWork`
                // reads, so every later git operation uses the installation.
                auth: {
                    mode: 'github_app_installation',
                    providerId: 'github',
                    installationId: '4242',
                    installationRepositoryId: 'inst-repo-row-1',
                    repoFullName: 'ever-co/ever-works',
                },
            });
            // Everything else about a Repository Work is unchanged.
            expect(persisted.storageProvider).toBe('user-github');
            expect(persisted.deployProvider).toBeNull();
            expect(persisted.websiteTemplateId).toBeNull();
            expect(persisted.generateStatus).toEqual({ status: 'generated', step: 'linked' });
            expect(persisted.syncIntervalMinutes).toBe(0);
            expect(deps.dataGenerator.getItems).not.toHaveBeenCalled();
        });

        it('falls back the same way when NO git credential is connected (the facade’s NoGitCredentialsError)', async () => {
            const { service, deps } = makeService();
            deps.gitFacade.hasRepositoryAccess.mockRejectedValue(
                new NoGitCredentialsError('github', baseUser.id),
            );

            const result = await service.createWork(repoDto, baseUser);

            expect(result.status).toBe('success');
            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.sourceRepository.auth).toEqual({
                mode: 'github_app_installation',
                providerId: 'github',
                installationId: '4242',
                installationRepositoryId: 'inst-repo-row-1',
                repoFullName: 'ever-co/ever-works',
            });
        });

        it('matches the snapshot name case-insensitively, and records GitHub’s own casing', async () => {
            const { service, deps } = makeService();
            deps.installationRepos.listForInstallation.mockResolvedValue([
                { ...SNAPSHOT_ROW, fullName: 'Ever-Co/Ever-Works' },
            ]);

            await service.createWork(repoDto, baseUser);

            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.sourceRepository.auth.repoFullName).toBe('Ever-Co/Ever-Works');
            // The coordinates stay the ones the user wrote.
            expect(persisted.sourceRepository.owner).toBe('ever-co');
            expect(persisted.sourceRepository.repo).toBe('ever-works');
        });

        it('skips an unusable installation and accepts a later one that passes every check', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                // Same account, but suspended: never reaches the snapshot.
                {
                    ...OWN_INSTALLATION,
                    id: 'inst-entity-0',
                    installationId: '1111',
                    suspendedAt: new Date(),
                },
                { ...OWN_INSTALLATION },
            ]);

            await service.createWork(repoDto, baseUser);

            expect(deps.installationRepos.listForInstallation).toHaveBeenCalledTimes(1);
            expect(deps.installationRepos.listForInstallation).toHaveBeenCalledWith(
                OWN_INSTALLATION.id,
            );
            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.sourceRepository.auth.installationId).toBe('4242');
        });

        // ─────────────────────────────────────────────────────────────────
        // The SNAPSHOT row decides which installation covers the repository.
        // `accountLogin` is refreshed only by `installation` webhooks and the
        // setup flow, so it lags an organization rename; it may order the
        // candidates and nothing else.
        // ─────────────────────────────────────────────────────────────────
        it('accepts after an organization RENAME: the snapshot has the new name, accountLogin still has the old one', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                // Never refreshed: the organization used to be `ever-co-old`.
                { ...OWN_INSTALLATION, accountLogin: 'ever-co-old' },
            ]);
            // Re-synced from GitHub: the rows carry the organization's new name.
            deps.installationRepos.listForInstallation.mockResolvedValue([{ ...SNAPSHOT_ROW }]);

            const result = await service.createWork(repoDto, baseUser);

            expect(result.status).toBe('success');
            expect(deps.gitFacade.canInstallationStandInForUser).toHaveBeenCalledWith({
                installationId: '4242',
                githubRepoId: '556677',
                owner: 'ever-co',
                repo: 'ever-works',
                userId: baseUser.id,
            });
            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.sourceRepository.auth).toEqual({
                mode: 'github_app_installation',
                providerId: 'github',
                installationId: '4242',
                installationRepositoryId: 'inst-repo-row-1',
                repoFullName: 'ever-co/ever-works',
            });
        });

        it('refuses the OLD name after that rename — no snapshot row carries it any more', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                { ...OWN_INSTALLATION, accountLogin: 'ever-co-old' },
            ]);
            deps.installationRepos.listForInstallation.mockResolvedValue([{ ...SNAPSHOT_ROW }]);

            await expect(
                service.createWork(
                    {
                        ...repoDto,
                        repositoryUrl: 'https://github.com/ever-co-old/ever-works',
                    } as CreateWorkDto,
                    baseUser,
                ),
            ).rejects.toMatchObject({ status: 400 });

            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
            expect(deps.workRepo.create).not.toHaveBeenCalled();
        });

        it('uses accountLogin only to choose which installation to look at FIRST', async () => {
            const { service, deps } = makeService();
            const elsewhere = {
                ...OWN_INSTALLATION,
                id: 'inst-entity-other',
                installationId: '7777',
                accountLogin: 'git-hands',
            };
            // Listed first (newest), but its login is not the repository owner.
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                elsewhere,
                { ...OWN_INSTALLATION },
            ]);
            deps.installationRepos.listForInstallation.mockImplementation(
                async (installationEntityId: string) =>
                    installationEntityId === OWN_INSTALLATION.id ? [{ ...SNAPSHOT_ROW }] : [],
            );

            await service.createWork(repoDto, baseUser);

            // The login-matching installation was read first and sufficed.
            expect(deps.installationRepos.listForInstallation).toHaveBeenCalledTimes(1);
            expect(deps.installationRepos.listForInstallation).toHaveBeenCalledWith(
                OWN_INSTALLATION.id,
            );
        });

        it('still looks at an installation whose accountLogin does not match when the matching one does not list the repository', async () => {
            const { service, deps } = makeService();
            const renamed = {
                ...OWN_INSTALLATION,
                id: 'inst-entity-renamed',
                installationId: '7777',
                accountLogin: 'ever-co-old',
            };
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                { ...OWN_INSTALLATION },
                renamed,
            ]);
            deps.installationRepos.listForInstallation.mockImplementation(
                async (installationEntityId: string) =>
                    installationEntityId === renamed.id
                        ? [{ ...SNAPSHOT_ROW, id: 'row-renamed', installationEntityId: renamed.id }]
                        : [],
            );

            await service.createWork(repoDto, baseUser);

            expect(deps.installationRepos.listForInstallation).toHaveBeenNthCalledWith(
                1,
                OWN_INSTALLATION.id,
            );
            expect(deps.installationRepos.listForInstallation).toHaveBeenNthCalledWith(
                2,
                renamed.id,
            );
            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.sourceRepository.auth.installationId).toBe('7777');
            expect(persisted.sourceRepository.auth.installationRepositoryId).toBe('row-renamed');
        });

        // ─────────────────────────────────────────────────────────────────
        // The fallback is tried for exactly two probe outcomes: an answered
        // "no", and "no git credential connected". Every other probe failure
        // is not an answer about the repository — the caller's own account
        // may well read it — so it must never bind the Work to the App.
        // ─────────────────────────────────────────────────────────────────
        it.each([
            ['a network error', () => new Error('connect ECONNRESET api.github.com')],
            [
                'a rate limit (403 from the provider)',
                () => Object.assign(new Error('API rate limit exceeded'), { status: 403 }),
            ],
            [
                'a secondary rate limit (429)',
                () =>
                    Object.assign(new Error('You have exceeded a secondary rate limit'), {
                        status: 429,
                    }),
            ],
            [
                'an expired or revoked token (401)',
                () => Object.assign(new Error('Bad credentials'), { status: 401 }),
            ],
            [
                'a provider outage (502)',
                () => Object.assign(new Error('Bad Gateway'), { status: 502 }),
            ],
            [
                'a provider plugin that is not installed',
                () => new GitProviderNotFoundError('github'),
            ],
            [
                'an error that only LOOKS like "no credential" (same message, not the class)',
                () => new Error('No connected account found for user u-1 with provider github'),
            ],
            [
                'an error that only carries the class NAME',
                () => Object.assign(new Error('nope'), { name: 'NoGitCredentialsError' }),
            ],
        ])(
            'does NOT fall back on %s — 400 "Could not verify access", as before',
            async (_label, makeError) => {
                const { service, deps } = makeService();
                const failure = makeError();
                deps.gitFacade.hasRepositoryAccess.mockRejectedValue(failure);

                await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
                    status: 400,
                    response: {
                        status: 'error',
                        // The message that existed before the fallback, verbatim:
                        // no remedies appended, because no remedy was evaluated.
                        message:
                            'Could not verify access to https://github.com/ever-co/ever-works with your ' +
                            `connected github account: ${failure.message}`,
                    },
                });

                // The installation that WOULD have qualified was never consulted.
                expect(deps.installations.listByCreatedByUserId).not.toHaveBeenCalled();
                expect(deps.installationRepos.listForInstallation).not.toHaveBeenCalled();
                expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
                expect(deps.workRepo.create).not.toHaveBeenCalled();
                expect(deps.eventEmitter.emitAsync).not.toHaveBeenCalled();
            },
        );

        // ─────────────────────────────────────────────────────────────────
        // 3. Every near miss is refused — same answer, nothing persisted.
        // ─────────────────────────────────────────────────────────────────
        it('refuses when the caller has no installation at all', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([]);

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('never queries installations for a caller with no id (an undefined filter would match every row)', async () => {
            const { service, deps } = makeService();
            // TypeORM drops an `undefined` where-value, so `listByCreatedByUserId(undefined)`
            // would return every installation in the deployment.
            const anonymous = { email: 'nobody@example.com' } as User;

            await expect(service.createWork(repoDto, anonymous)).rejects.toMatchObject({
                status: 400,
            });

            expect(deps.installations.listByCreatedByUserId).not.toHaveBeenCalled();
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
            expect(deps.workRepo.create).not.toHaveBeenCalled();
        });

        it('refuses an installation owned by ANOTHER user, even if a query returned it', async () => {
            const { service, deps } = makeService();
            // The repository method filters by owner; this pins that the
            // service does not rely on that and re-checks the row itself.
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                { ...OWN_INSTALLATION, createdByUserId: 'someone-else' },
            ]);

            await expectRefused(service, deps);
            expect(deps.installationRepos.listForInstallation).not.toHaveBeenCalled();
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses an installation nobody has claimed (no recorded platform owner)', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                { ...OWN_INSTALLATION, createdByUserId: null },
            ]);

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses a DELETED installation', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                { ...OWN_INSTALLATION, deletedAt: new Date() },
            ]);

            await expectRefused(service, deps);
            expect(deps.installationRepos.listForInstallation).not.toHaveBeenCalled();
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses a SUSPENDED installation', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([
                { ...OWN_INSTALLATION, suspendedAt: new Date() },
            ]);

            await expectRefused(service, deps);
            expect(deps.installationRepos.listForInstallation).not.toHaveBeenCalled();
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses a snapshot row whose name merely STARTS WITH the requested one (no prefix match)', async () => {
            const { service, deps } = makeService();
            deps.installationRepos.listForInstallation.mockResolvedValue([
                {
                    ...SNAPSHOT_ROW,
                    repo: 'ever-works-website',
                    fullName: 'ever-co/ever-works-website',
                },
                {
                    ...SNAPSHOT_ROW,
                    id: 'row-2',
                    owner: 'ever-co-labs',
                    fullName: 'ever-co-labs/ever-works',
                },
            ]);

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses when the repository is missing from the installation snapshot', async () => {
            const { service, deps } = makeService();
            deps.installationRepos.listForInstallation.mockResolvedValue([
                {
                    ...SNAPSHOT_ROW,
                    id: 'row-other',
                    repo: 'ever-gauzy',
                    fullName: 'ever-co/ever-gauzy',
                },
            ]);

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses a snapshot row that is not selected', async () => {
            const { service, deps } = makeService();
            deps.installationRepos.listForInstallation.mockResolvedValue([
                { ...SNAPSHOT_ROW, selected: false },
            ]);

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses a snapshot row that belongs to a DIFFERENT installation', async () => {
            const { service, deps } = makeService();
            deps.installationRepos.listForInstallation.mockResolvedValue([
                { ...SNAPSHOT_ROW, installationEntityId: 'somebody-elses-installation' },
            ]);

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        it('refuses when the LIVE check fails — a stale snapshot, or an owner GitHub says cannot read the repository, is not enough', async () => {
            const { service, deps } = makeService();
            deps.gitFacade.canInstallationStandInForUser.mockResolvedValue(false);

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).toHaveBeenCalledTimes(1);
        });

        it('refuses when the live check does not answer a strict `true`', async () => {
            const { service, deps } = makeService();
            deps.gitFacade.canInstallationStandInForUser.mockResolvedValue(undefined);

            await expectRefused(service, deps);
        });

        it.each([
            ['the installation list', 'installations'],
            ['the snapshot', 'snapshot'],
            ['the live check', 'live'],
        ])('fails CLOSED when %s throws', async (_label, which) => {
            const { service, deps } = makeService();
            const boom = new Error('connection terminated: installation 4242 token ghs_secret');
            if (which === 'installations') {
                deps.installations.listByCreatedByUserId.mockRejectedValue(boom);
            } else if (which === 'snapshot') {
                deps.installationRepos.listForInstallation.mockRejectedValue(boom);
            } else {
                deps.gitFacade.canInstallationStandInForUser.mockRejectedValue(boom);
            }

            const message = await expectRefused(service, deps);
            // Nothing the failing dependency said reaches the caller.
            expect(message).not.toContain('4242');
            expect(message).not.toContain('ghs_secret');
            expect(message).not.toContain('connection terminated');
        });

        it('has no fallback at all when the installation repositories are not wired (reduced module graph)', async () => {
            const { service, deps } = makeService({ withInstallationRepositories: false });

            await expectRefused(service, deps);
            expect(deps.gitFacade.canInstallationStandInForUser).not.toHaveBeenCalled();
        });

        // ─────────────────────────────────────────────────────────────────
        // 4. The refusal names both remedies and discloses nothing new.
        // ─────────────────────────────────────────────────────────────────
        it('names both remedies in the refusal', async () => {
            const { service, deps } = makeService();
            deps.installations.listByCreatedByUserId.mockResolvedValue([]);

            const message = await expectRefused(service, deps);

            expect(message).toContain('https://github.com/ever-co/ever-works');
            expect(message).toMatch(/connect a github account that can read the repository/i);
            expect(message).toMatch(/install the ever works github app/i);
        });

        it('gives the SAME message whatever the installation lookup found', async () => {
            const variants: Array<(deps: MockDeps) => void> = [
                // no installation
                (deps) => deps.installations.listByCreatedByUserId.mockResolvedValue([]),
                // somebody else's installation on the right account
                (deps) =>
                    deps.installations.listByCreatedByUserId.mockResolvedValue([
                        { ...OWN_INSTALLATION, createdByUserId: 'someone-else' },
                    ]),
                // own installation, deleted
                (deps) =>
                    deps.installations.listByCreatedByUserId.mockResolvedValue([
                        { ...OWN_INSTALLATION, deletedAt: new Date() },
                    ]),
                // own installation, suspended
                (deps) =>
                    deps.installations.listByCreatedByUserId.mockResolvedValue([
                        { ...OWN_INSTALLATION, suspendedAt: new Date() },
                    ]),
                // own installation that lists a different repository
                (deps) =>
                    deps.installationRepos.listForInstallation.mockResolvedValue([
                        { ...SNAPSHOT_ROW, repo: 'ever-gauzy', fullName: 'ever-co/ever-gauzy' },
                    ]),
                // repository not in the snapshot
                (deps) => deps.installationRepos.listForInstallation.mockResolvedValue([]),
                // snapshot says yes, GitHub says no
                (deps) => deps.gitFacade.canInstallationStandInForUser.mockResolvedValue(false),
                // a dependency blew up
                (deps) =>
                    deps.installationRepos.listForInstallation.mockRejectedValue(new Error('boom')),
            ];

            const messages = new Set<string>();
            for (const arrange of variants) {
                const { service, deps } = makeService();
                arrange(deps);
                messages.add(await expectRefused(service, deps));
            }

            expect(messages.size).toBe(1);
        });

        it('keeps the "could not verify" 400 — with both remedies — when nothing is connected and no installation qualifies', async () => {
            const { service, deps } = makeService();
            deps.gitFacade.hasRepositoryAccess.mockRejectedValue(
                new NoGitCredentialsError('github', baseUser.id),
            );
            deps.installations.listByCreatedByUserId.mockResolvedValue([]);

            await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
                status: 400,
                response: expect.objectContaining({
                    message: expect.stringMatching(
                        /^Could not verify access to https:\/\/github\.com\/ever-co\/ever-works .*No connected account found.*Connect a GitHub account that can read the repository, or install the Ever Works GitHub App/,
                    ),
                }),
            });
            expect(deps.workRepo.create).not.toHaveBeenCalled();
        });

        // ─────────────────────────────────────────────────────────────────
        // 5. Every other check stays in force on the fallback path.
        // ─────────────────────────────────────────────────────────────────
        it('still refuses (409) a repository another account already wraps, AFTER the installation was accepted', async () => {
            const { service, deps } = makeService();
            deps.workRepo.findRepositoryWorksWrapping.mockResolvedValue([
                { id: 'w-other', userId: 'someone-else', slug: 'their-platform' },
            ]);

            await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
                status: 409,
            });

            expect(deps.gitFacade.canInstallationStandInForUser).toHaveBeenCalledTimes(1);
            expect(deps.workRepo.findRepositoryWorksWrapping).toHaveBeenCalledWith(
                'ever-co',
                'ever-works',
            );
            expect(deps.workRepo.create).not.toHaveBeenCalled();
        });

        it('still rethrows an HttpException from the probe untouched, without trying the fallback', async () => {
            const { service, deps } = makeService();
            deps.gitFacade.hasRepositoryAccess.mockRejectedValue(
                new ForbiddenException('provider refused'),
            );

            await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
                status: 403,
            });
            expect(deps.installations.listByCreatedByUserId).not.toHaveBeenCalled();
            expect(deps.workRepo.create).not.toHaveBeenCalled();
        });

        it('still rejects a provider mismatch before probing anything', async () => {
            const { service, deps } = makeService();

            await expect(
                service.createWork(
                    { ...repoDto, gitProvider: 'gitlab' } as CreateWorkDto,
                    baseUser,
                ),
            ).rejects.toMatchObject({ status: 400 });

            expect(deps.gitFacade.hasRepositoryAccess).not.toHaveBeenCalled();
            expect(deps.installations.listByCreatedByUserId).not.toHaveBeenCalled();
        });

        it('never runs for any other kind', async () => {
            const { service, deps } = makeService();

            await service.createWork({ ...repoDto, kind: 'directory' } as CreateWorkDto, baseUser);

            expect(deps.gitFacade.hasRepositoryAccess).not.toHaveBeenCalled();
            expect(deps.installations.listByCreatedByUserId).not.toHaveBeenCalled();
            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.sourceRepository).toBeUndefined();
        });
    });
});

/**
 * The two installation repositories are `@Optional()` constructor
 * parameters, so a token Nest cannot resolve is not a boot failure: the
 * service is built with `undefined` and the fallback silently does not exist.
 * These pin that the tokens are the repository CLASSES, declared explicitly
 * (`@Inject`), so that cannot happen through an import or compiler change —
 * the defect `agent-templates.git-token.spec.ts` records for another service.
 */
describe('WorkLifecycleService — the installation repositories are injected by token', () => {
    /** Where the two repositories sit in the constructor, read from the declared tokens. */
    function slots(): { installations: number; installationRepos: number } {
        const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, WorkLifecycleService) ??
            []) as { index: number; param: unknown }[];
        const installations = declared.find(
            (entry) => entry.param === GitHubAppInstallationRepository,
        );
        const installationRepos = declared.find(
            (entry) => entry.param === GitHubAppInstallationRepoRepository,
        );
        return {
            installations: installations?.index ?? -1,
            installationRepos: installationRepos?.index ?? -1,
        };
    }

    it('self-declares both repository classes as tokens, and both are optional', () => {
        const { installations, installationRepos } = slots();
        const optional = (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, WorkLifecycleService) ??
            []) as number[];

        expect(installations).toBeGreaterThanOrEqual(0);
        expect(installationRepos).toBe(installations + 1);
        expect(optional).toEqual(expect.arrayContaining([installations, installationRepos]));
    });

    /**
     * Build the service through Nest with every REQUIRED dependency stubbed
     * (the tokens are read from the service's own metadata) and the two
     * installation repositories either provided or not.
     */
    async function buildThroughNest(options: {
        provideInstallationRepositories: boolean;
        degradeEmittedTypes: boolean;
    }): Promise<{ gitHubAppInstallations?: unknown; gitHubAppInstallationRepos?: unknown }> {
        const { installations, installationRepos } = slots();
        const emitted = (Reflect.getMetadata(PARAMTYPES_METADATA, WorkLifecycleService) ??
            []) as unknown[];
        const optional = new Set(
            (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, WorkLifecycleService) ?? []) as number[],
        );
        const required = emitted.filter((_token, index) => !optional.has(index));

        if (options.degradeEmittedTypes) {
            // What a type-only import or an import cycle ships: `Object`.
            const shipped = [...emitted];
            shipped[installations] = Object;
            shipped[installationRepos] = Object;
            Reflect.defineMetadata(PARAMTYPES_METADATA, shipped, WorkLifecycleService);
        }

        const installationsStub = { marker: 'installations' };
        const installationReposStub = { marker: 'installation-repos' };

        @Module({
            providers: [
                WorkLifecycleService,
                ...required.map((token) => ({ provide: token as never, useValue: {} })),
                ...(options.provideInstallationRepositories
                    ? [
                          { provide: GitHubAppInstallationRepository, useValue: installationsStub },
                          {
                              provide: GitHubAppInstallationRepoRepository,
                              useValue: installationReposStub,
                          },
                      ]
                    : []),
            ],
        })
        class LifecycleHost {}

        try {
            const moduleRef = await Test.createTestingModule({
                imports: [LifecycleHost],
            }).compile();
            const service = moduleRef.get(WorkLifecycleService) as unknown as {
                gitHubAppInstallations?: unknown;
                gitHubAppInstallationRepos?: unknown;
            };
            const seen = {
                gitHubAppInstallations: service.gitHubAppInstallations,
                gitHubAppInstallationRepos: service.gitHubAppInstallationRepos,
            };
            await moduleRef.close();
            return seen;
        } finally {
            Reflect.defineMetadata(PARAMTYPES_METADATA, emitted, WorkLifecycleService);
        }
    }

    it('receives the repositories its module provides', async () => {
        const seen = await buildThroughNest({
            provideInstallationRepositories: true,
            degradeEmittedTypes: false,
        });

        expect(seen.gitHubAppInstallations).toEqual({ marker: 'installations' });
        expect(seen.gitHubAppInstallationRepos).toEqual({ marker: 'installation-repos' });
    });

    it('still receives them when design:paramtypes says Object for both slots', async () => {
        const seen = await buildThroughNest({
            provideInstallationRepositories: true,
            degradeEmittedTypes: true,
        });

        expect(seen.gitHubAppInstallations).toEqual({ marker: 'installations' });
        expect(seen.gitHubAppInstallationRepos).toEqual({ marker: 'installation-repos' });
    });

    it('still builds without them — the fallback is simply absent', async () => {
        const seen = await buildThroughNest({
            provideInstallationRepositories: false,
            degradeEmittedTypes: false,
        });

        expect(seen.gitHubAppInstallations).toBeUndefined();
        expect(seen.gitHubAppInstallationRepos).toBeUndefined();
    });
});
