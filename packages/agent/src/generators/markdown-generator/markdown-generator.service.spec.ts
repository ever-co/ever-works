// `github-slugger` is shipped as ESM-only, which Jest's CommonJS pipeline
// cannot parse. The transitive import path is:
//     markdown-generator.service → readme-builder → github-slugger
// We stub it the same way `readme-builder.spec.ts` does. The shape only
// needs to be `class { slug(input: string): string }` so the constructor
// in readme-builder can build an instance.
jest.mock('github-slugger', () => {
    return class MockGithubSlugger {
        private seen = new Map<string, number>();
        slug(input: string): string {
            const base = input
                .toLowerCase()
                .replace(/&/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const count = this.seen.get(base) ?? 0;
            this.seen.set(base, count + 1);
            return count === 0 ? base : `${base}-${count}`;
        }
    };
});

jest.mock('node:fs/promises', () => ({
    readdir: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/fresh-repository-clone.utils', () => ({
    cloneFreshRepository: jest.fn(),
}));

import { GenerationMethod } from '@ever-works/contracts/api';
import { MarkdownGeneratorService } from './markdown-generator.service';
import { CATEGORY_PAGE_MARKER, MarkdownRepository } from './markdown-repository';
import { ReadmeBuilder } from './readme-builder';
import { TaxonomyResolver, normalizeTaxonomyKey } from './taxonomy-resolver';
import { DataRepository } from '../data-generator/data-repository';
import { cloneFreshRepository } from '../../utils/fresh-repository-clone.utils';
import { createGenerationCancelledError } from '../../utils/generation-cancellation.utils';
import type { GitFacadeService } from '../../facades/git.facade';
import type { WorkOperationsService } from '@src/work-operations';
import type { Work } from '../../entities/work.entity';
import type { User } from '../../entities/user.entity';

const fsMock = jest.requireMock('node:fs/promises') as {
    readdir: jest.Mock;
};

const cloneFreshRepositoryMock = cloneFreshRepository as jest.MockedFunction<
    typeof cloneFreshRepository
>;

type FacadeMock = jest.Mocked<GitFacadeService>;
type WorkOpsMock = jest.Mocked<WorkOperationsService>;

const COMMITTER = { name: 'Test User', email: 'test@example.com' } as const;

const createGitFacadeMock = (): FacadeMock =>
    ({
        createRepository: jest.fn().mockResolvedValue({
            owner: 'acme',
            name: 'test-work',
            fullName: 'acme/test-work',
        }),
        cloneOrPull: jest.fn().mockResolvedValue('/tmp/data-repo'),
        getMainBranch: jest.fn().mockResolvedValue('main'),
        switchBranch: jest.fn().mockResolvedValue(undefined),
        addAll: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        push: jest.fn().mockResolvedValue(undefined),
        createPullRequest: jest.fn().mockResolvedValue({ number: 42, url: 'https://pr/42' }),
        deleteRepository: jest.fn().mockResolvedValue(undefined),
        getLocalDir: jest.fn().mockReturnValue('/tmp/local'),
        // EW-628 G5 — `syncFromDataRepo` calls these to fetch afterSha.
        // Default to resolved values so non-G5 specs do not have to stub.
        getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
        getLatestCommit: jest.fn().mockResolvedValue(null),
    }) as unknown as FacadeMock;

const createWorkOpsMock = (): WorkOpsMock =>
    ({
        updateLastPullRequest: jest.fn().mockResolvedValue(undefined),
    }) as unknown as WorkOpsMock;

const createWork = (overrides: Partial<Record<string, unknown>> = {}): Work =>
    ({
        id: 'dir-1',
        slug: 'test-work',
        gitProvider: 'github',
        organization: null,
        description: 'A test work',
        user: { id: 'user-1' },
        getRepoOwner: jest
            .fn()
            .mockImplementation((kind?: string) => (kind === 'work' ? 'acme' : 'acme')),
        getMainRepo: jest.fn().mockReturnValue('test-work'),
        getDataRepo: jest.fn().mockReturnValue('test-work-data'),
        resolveCommitter: jest.fn().mockReturnValue({ ...COMMITTER }),
        ...overrides,
    }) as unknown as Work;

const createUser = (): User => ({ id: 'user-1' }) as User;

describe('MarkdownGeneratorService', () => {
    let dataRepoCreateSpy: jest.SpyInstance;
    let writeReadmeSpy: jest.SpyInstance;
    let writeDetailsSpy: jest.SpyInstance;
    let writeLicenseSpy: jest.SpyInstance;
    let removeDetailsSpy: jest.SpyInstance;
    let resetFilesSpy: jest.SpyInstance;
    let ensureWorksExistSpy: jest.SpyInstance;
    let cleanupSpy: jest.SpyInstance;
    let writeCategoryPageSpy: jest.SpyInstance;
    let removeStaleCategoryPagesSpy: jest.SpyInstance;

    const mountDataRepoMock = (overrides: Partial<Record<string, unknown>> = {}) => {
        const dataRepo = {
            dir: '/tmp/data-repo',
            dataDir: '/tmp/data-repo/data',
            getMarkdown: jest.fn().mockResolvedValue(undefined),
            getItem: jest.fn().mockResolvedValue(null),
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getLicense: jest.fn().mockResolvedValue(null),
            getConfig: jest.fn().mockResolvedValue({ content_table: false }),
            readMarkdownTemplate: jest.fn().mockResolvedValue({ header: '', footer: '' }),
            ...overrides,
        };
        dataRepoCreateSpy.mockResolvedValue(dataRepo as unknown as DataRepository);
        return dataRepo;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        cloneFreshRepositoryMock.mockResolvedValue('/tmp/markdown-repo');
        fsMock.readdir.mockResolvedValue([]);

        dataRepoCreateSpy = jest.spyOn(DataRepository, 'create');
        writeReadmeSpy = jest
            .spyOn(MarkdownRepository.prototype, 'writeReadme')
            .mockResolvedValue(undefined);
        writeDetailsSpy = jest
            .spyOn(MarkdownRepository.prototype, 'writeDetails')
            .mockResolvedValue(undefined);
        writeLicenseSpy = jest
            .spyOn(MarkdownRepository.prototype, 'writeLicense')
            .mockResolvedValue(undefined);
        removeDetailsSpy = jest
            .spyOn(MarkdownRepository.prototype, 'removeDetails')
            .mockResolvedValue(undefined);
        resetFilesSpy = jest
            .spyOn(MarkdownRepository.prototype, 'resetFiles')
            .mockResolvedValue(undefined);
        ensureWorksExistSpy = jest
            .spyOn(MarkdownRepository.prototype, 'ensureWorksExist')
            .mockResolvedValue(undefined);
        cleanupSpy = jest
            .spyOn(MarkdownRepository.prototype, 'cleanup')
            .mockResolvedValue(undefined);
        writeCategoryPageSpy = jest
            .spyOn(MarkdownRepository.prototype, 'writeCategoryPage')
            .mockResolvedValue(undefined);
        removeStaleCategoryPagesSpy = jest
            .spyOn(MarkdownRepository.prototype, 'removeStaleCategoryPages')
            .mockResolvedValue(0);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('initialize — repository setup', () => {
        it('creates markdown repo via gitFacade with private flag and personal owner when work has no organization', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(gitFacade.createRepository).toHaveBeenCalledTimes(1);
            const [payload, options] = gitFacade.createRepository.mock.calls[0];
            expect(payload).toEqual({
                name: 'test-work',
                description: 'A test work',
                organization: undefined,
                isPrivate: true,
            });
            expect(options).toEqual({
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
        });

        it('passes the work owner as organization on createRepository when work.organization is truthy', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();
            const work = createWork({ organization: 'acme-org' });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(work, createUser());

            const [payload] = gitFacade.createRepository.mock.calls[0];
            expect(payload.organization).toBe('acme');
        });

        it('throws when the created repository owner/name does not match the work expectation', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.createRepository.mockResolvedValueOnce({
                owner: 'someone-else',
                name: 'test-work',
                fullName: 'someone-else/test-work',
            } as any);
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).rejects.toThrow(
                /Markdown repository was created as someone-else\/test-work/,
            );
        });

        it('clones markdown repo via cloneFreshRepository (NOT cloneOrPull) — retry-safe path', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(cloneFreshRepositoryMock).toHaveBeenCalledTimes(1);
            const [, args] = cloneFreshRepositoryMock.mock.calls[0];
            expect(args).toEqual({
                owner: 'acme',
                repo: 'test-work',
                committer: COMMITTER,
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
        });

        it('clones data repo via cloneOrPull with the data-repo coordinates', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(gitFacade.cloneOrPull).toHaveBeenCalledTimes(1);
            const [cloneOpts, gitOpts] = gitFacade.cloneOrPull.mock.calls[0];
            expect(cloneOpts).toEqual({
                owner: 'acme',
                repo: 'test-work-data',
                committer: COMMITTER,
            });
            expect(gitOpts).toEqual({
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
        });
    });

    describe('initialize — generation_method branches', () => {
        it('RECREATE: switches to default branch then resetFiles (canCreatePR=false ⇒ no PR)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.RECREATE,
                pr_update: { branch: 'feature-x', title: 't', body: 'b' },
            });

            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                '/tmp/markdown-repo',
                'main',
            );
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
            // PR is not created on RECREATE even with pr_update.branch present
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(workOps.updateLastPullRequest).not.toHaveBeenCalled();
        });

        it('RECREATE skips main-branch switch when getMainBranch returns null (still resetFiles)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.getMainBranch.mockResolvedValueOnce(null as any);
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.RECREATE,
            });

            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
        });

        it('RECREATE swallows getMainBranch rejection (logs error, treats as null)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.getMainBranch.mockRejectedValueOnce(new Error('boom'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.RECREATE,
                }),
            ).resolves.toEqual({ filesChanged: expect.any(Number) });
            // The default branch was treated as null → no switchBranch call
            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
        });

        it('RECREATE swallows switchBranch rejection (continues to resetFiles)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.switchBranch.mockRejectedValueOnce(new Error('switch failed'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.RECREATE,
                }),
            ).resolves.toEqual({ filesChanged: expect.any(Number) });
            expect(resetFilesSpy).toHaveBeenCalledTimes(1);
        });

        it('CREATE_UPDATE with pr_update.branch: switches BOTH markdown + data repos to PR branch (force=true)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'feature-y', title: 't', body: 'b' },
            });

            const calls = gitFacade.switchBranch.mock.calls;
            const targets = calls.map((c) => `${c[1]}|${c[2]}|${c[3] === true}`);
            expect(targets).toEqual(
                expect.arrayContaining([
                    `/tmp/markdown-repo|feature-y|true`,
                    `/tmp/data-repo|feature-y|true`,
                ]),
            );
            // Reset files NOT called in CREATE_UPDATE
            expect(resetFilesSpy).not.toHaveBeenCalled();
        });

        it('CREATE_UPDATE: PR branch switch failure clears canCreatePR (no PR even when defaultBranch present)', async () => {
            const gitFacade = createGitFacadeMock();
            // markdown switch resolves; data switch rejects → Promise.all rejects
            gitFacade.switchBranch
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('data switch failed'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'feature-z', title: 't', body: 'b' },
            });

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(workOps.updateLastPullRequest).not.toHaveBeenCalled();
        });

        it('CREATE_UPDATE without pr_update: no branch switch, no resetFiles, no PR', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
            });

            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(resetFilesSpy).not.toHaveBeenCalled();
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        });
    });

    describe('initialize — items / categories / tags', () => {
        it('writes details for slugs whose markdown is non-empty and skips slugs without markdown', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce(['alpha', 'beta', 'gamma']);
            mountDataRepoMock({
                getMarkdown: jest
                    .fn()
                    .mockResolvedValueOnce('# Alpha')
                    .mockResolvedValueOnce(undefined)
                    .mockResolvedValueOnce('# Gamma'),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug,
                    description: '',
                    category: 'misc',
                    source_url: 'https://e.x',
                })),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const written = writeDetailsSpy.mock.calls.map((c) => c[0]);
            expect(written).toEqual(['alpha', 'gamma']);
        });

        it('continues iteration when getItem returns null for a slug (no group entry)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['alpha', 'beta']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
                    slug: 'beta',
                    name: 'Beta',
                    description: '',
                    category: 'tools',
                }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            // Only beta should be added
            expect(builderSpy).toHaveBeenCalledTimes(1);
            expect(builderSpy.mock.calls[0][0]).toMatchObject({ slug: 'beta' });
        });

        it('warn-and-skip an item when getItem rejects (other items still processed)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce(['bad', 'good']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest
                    .fn()
                    .mockRejectedValueOnce(new Error('parse failed'))
                    .mockResolvedValueOnce({
                        slug: 'good',
                        name: 'Good',
                        description: '',
                        category: 'tools',
                    }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).resolves.toEqual({
                filesChanged: expect.any(Number),
            });
            // Push happens at the end — proves iteration completed past the rejection
            expect(gitFacade.push).toHaveBeenCalledTimes(1);
        });

        it('coerces non-Error throw value via String() in the per-item warn message', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce(['oops']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockRejectedValueOnce('string-thrown'),
                getItem: jest.fn().mockResolvedValue(null),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).resolves.toEqual({
                filesChanged: expect.any(Number),
            });
            expect(gitFacade.push).toHaveBeenCalledTimes(1);
        });

        it('normalises array category and registers ad-hoc categories not present in the loaded map', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['multi']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce({
                    slug: 'multi',
                    name: 'Multi',
                    description: '',
                    category: ['tools', 'extras'],
                }),
                // categories list returns no entries — both are ad-hoc registered
                getCategories: jest.fn().mockResolvedValue([]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            // The same item should have been added under each of its two categories
            expect(builderSpy).toHaveBeenCalledTimes(2);
        });

        it('populates each item.tags entry from the loaded tags map (string → tag object)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce({
                    slug: 'x',
                    name: 'X',
                    description: '',
                    category: 'misc',
                    tags: ['hot'],
                }),
                getTags: jest.fn().mockResolvedValue([{ id: 'hot', name: 'Hot' }]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const passedItem = builderSpy.mock.calls[0][0] as { tags?: any };
            expect(passedItem.tags).toEqual([{ id: 'hot', name: 'Hot' }]);
        });

        it('removes detail files listed in options.remove_details (and excludes them from "details" markdown set)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce([]);
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                remove_details: ['gone-1', 'gone-2'],
            });

            const removed = removeDetailsSpy.mock.calls.map((c) => c[0]);
            expect(removed).toEqual(['gone-1', 'gone-2']);
        });

        it('writes LICENSE.md only when DataRepository.getLicense returns truthy', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock({ getLicense: jest.fn().mockResolvedValue('MIT') });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(writeLicenseSpy).toHaveBeenCalledWith('MIT');
        });

        it('skips writeLicense when getLicense returns null', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock({ getLicense: jest.fn().mockResolvedValue(null) });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(writeLicenseSpy).not.toHaveBeenCalled();
        });
    });

    describe('initialize — category resolution', () => {
        const CLOUD = { id: 'cloud-devops-mcp-servers', name: 'Cloud & DevOps MCP Servers' };
        const DATA = {
            id: 'data-access-integration-mcp-servers',
            name: 'Data Access Integration MCP Servers',
        };

        const mountItems = (
            byslug: Record<string, Partial<Record<string, unknown>>>,
            extra: Partial<Record<string, unknown>> = {},
        ) => {
            fsMock.readdir.mockResolvedValueOnce(Object.keys(byslug));
            return mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug,
                    description: '',
                    source_url: 'https://e.x',
                    ...byslug[slug],
                })),
                getCategories: jest.fn().mockResolvedValue([CLOUD, DATA]),
                ...extra,
            });
        };

        it('resolves the id and display-name spellings of a category to ONE section', async () => {
            const subHeaderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addSubHeader');
            mountItems({
                a: { category: 'cloud-devops-mcp-servers' },
                b: { category: 'Cloud & DevOps MCP Servers' },
                c: { category: 'Cloud Devops Mcp Servers' },
                d: { category: '  cloud &  devops mcp servers ' },
                e: { category: 'Data Access Integration MCP Servers' },
            });

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser());

            expect(subHeaderSpy.mock.calls).toEqual([
                ['Cloud & DevOps MCP Servers', 4],
                ['Data Access Integration MCP Servers', 1],
            ]);
        });

        it('lists an item once per category even when it names that category twice', async () => {
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            const subHeaderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addSubHeader');
            mountItems({
                multi: {
                    category: [
                        'cloud-devops-mcp-servers',
                        'Cloud & DevOps MCP Servers',
                        'data-access-integration-mcp-servers',
                    ],
                },
            });

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser());

            expect(builderSpy).toHaveBeenCalledTimes(2);
            expect(subHeaderSpy.mock.calls.map((c) => c[0]).sort()).toEqual([
                'Cloud & DevOps MCP Servers',
                'Data Access Integration MCP Servers',
            ]);
        });

        it('only falls back to an ad-hoc category when nothing matches, and merges its spellings', async () => {
            const subHeaderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addSubHeader');
            mountItems({
                a: { category: 'Brand New Things' },
                b: { category: 'brand-new-things' },
                c: { category: 'cloud-devops-mcp-servers' },
            });

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser());

            expect(subHeaderSpy.mock.calls.sort()).toEqual([
                ['Brand New Things', 2],
                ['Cloud & DevOps MCP Servers', 1],
            ]);
        });

        it('puts items with a missing or empty category under Uncategorized', async () => {
            const subHeaderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addSubHeader');
            mountItems({
                a: { category: undefined },
                b: { category: '' },
                c: { category: [] },
                d: { category: ['  ', null] },
            });

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser());

            expect(subHeaderSpy.mock.calls).toEqual([['Uncategorized', 4]]);
        });

        it('resolves tag spellings to the canonical tags of tags.yml, each tag once', async () => {
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            mountItems(
                {
                    x: {
                        category: 'cloud-devops-mcp-servers',
                        tags: ['Hot Stuff', 'hot-stuff', 'HOT  stuff', 'Other'],
                    },
                },
                { getTags: jest.fn().mockResolvedValue([{ id: 'hot-stuff', name: 'Hot Stuff' }]) },
            );

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser());

            const passedItem = builderSpy.mock.calls[0][0] as { tags?: any };
            expect(passedItem.tags).toEqual([
                { id: 'hot-stuff', name: 'Hot Stuff' },
                { id: 'Other', name: 'Other' },
            ]);
        });
    });

    describe('initialize — README split into category pages', () => {
        const mountDirectory = (extra: Partial<Record<string, unknown>> = {}) => {
            fsMock.readdir.mockResolvedValueOnce(['alpha', 'beta', 'gamma']);
            return mountDataRepoMock({
                getMarkdown: jest
                    .fn()
                    .mockImplementation((slug: string) =>
                        slug === 'beta' ? undefined : `# ${slug}`,
                    ),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug.toUpperCase(),
                    // ~300 bytes per line: the 3-item single-file README is
                    // ~1.2 KB, the split index (with one featured item) ~0.7 KB
                    description: `About ${slug}. ${'Lorem ipsum '.repeat(25)}`,
                    source_url: `https://${slug}.test`,
                    category: slug === 'gamma' ? 'Second Category' : 'first',
                    featured: slug === 'alpha',
                })),
                getCategories: jest.fn().mockResolvedValue([
                    { id: 'first', name: 'First Category' },
                    { id: 'second', name: 'Second Category' },
                ]),
                readMarkdownTemplate: jest
                    .fn()
                    .mockResolvedValue({ header: '# Awesome', footer: '## Footer' }),
                ...extra,
            });
        };

        it('keeps the single-file README when it fits, writes no pages, and sweeps every old page', async () => {
            mountDirectory();

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser());

            const readme = writeReadmeSpy.mock.calls[0][0] as string;
            expect(readme).toContain('## First Category');
            expect(readme).toContain('- [BETA](https://beta.test) - About beta');
            expect(readme).not.toContain('categories/');
            expect(Buffer.byteLength(readme, 'utf8')).toBeGreaterThan(900);
            expect(writeCategoryPageSpy).not.toHaveBeenCalled();
            expect(removeStaleCategoryPagesSpy).toHaveBeenCalledTimes(1);
            expect([...(removeStaleCategoryPagesSpy.mock.calls[0][0] as Set<string>)]).toEqual([]);
        });

        it('over the threshold: README becomes an index and each category gets a page', async () => {
            const gitFacade = createGitFacadeMock();
            mountDirectory();

            const service = new MarkdownGeneratorService(gitFacade, createWorkOpsMock());
            await service.initialize(createWork(), createUser(), {
                readme_split_threshold_bytes: 900,
            });

            const readme = writeReadmeSpy.mock.calls[0][0] as string;
            expect(Buffer.byteLength(readme, 'utf8')).toBeLessThanOrEqual(900);
            expect(readme.startsWith('# Awesome\n')).toBe(true);
            expect(readme.endsWith('## Footer')).toBe(true);
            expect(readme).toContain('- [First Category](categories/first.md) (2)');
            expect(readme).toContain('- [Second Category](categories/second.md) (1)');
            expect(readme).not.toContain('About beta');
            // featured item is shown on the front page
            expect(readme).toContain('## ⭐ Featured');
            expect(readme).toContain('- [ALPHA](https://alpha.test) - About alpha.');
            expect(readme).toContain('([Read more](/details/alpha.md))');

            // "First Category" (2 long items) does not fit one 900-byte page,
            // so it continues on a second page; "Second Category" fits one.
            const pages = writeCategoryPageSpy.mock.calls.map((c) => c[0]);
            expect(pages).toEqual(['first.md', 'first--page-2.md', 'second.md']);
            for (const [, content] of writeCategoryPageSpy.mock.calls) {
                expect(String(content).startsWith(CATEGORY_PAGE_MARKER)).toBe(true);
                expect(Buffer.byteLength(String(content), 'utf8')).toBeLessThanOrEqual(900);
            }
            const firstPage = writeCategoryPageSpy.mock.calls
                .filter((c) => String(c[0]).startsWith('first'))
                .map((c) => c[1] as string)
                .join('');
            expect(firstPage).toContain('([Read more](../details/alpha.md))');
            expect(firstPage).toContain('- [BETA](https://beta.test) - About beta.');
            expect(firstPage).not.toContain('details/beta.md');

            // the sweep keeps exactly the pages written by this run …
            const keep = removeStaleCategoryPagesSpy.mock.calls[0][0] as Set<string>;
            expect([...keep].sort()).toEqual([...pages].sort());
            // … and runs after the writes, before the commit
            const lastWrite = Math.max(...writeCategoryPageSpy.mock.invocationCallOrder);
            const sweep = removeStaleCategoryPagesSpy.mock.invocationCallOrder[0];
            expect(lastWrite).toBeLessThan(sweep);
            expect(sweep).toBeLessThan(gitFacade.addAll.mock.invocationCallOrder[0]);
        });

        it.each([0, -5, Number.NaN])(
            'treats readme_split_threshold_bytes=%p as "use the default" (no split)',
            async (threshold) => {
                mountDirectory();

                const service = new MarkdownGeneratorService(
                    createGitFacadeMock(),
                    createWorkOpsMock(),
                );
                await service.initialize(createWork(), createUser(), {
                    readme_split_threshold_bytes: threshold,
                });

                expect(writeReadmeSpy.mock.calls[0][0]).toContain('## First Category');
                expect(writeCategoryPageSpy).not.toHaveBeenCalled();
            },
        );

        it('when cancelled mid-way: stops writing pages, skips the sweep and never commits', async () => {
            const gitFacade = createGitFacadeMock();
            mountDirectory();
            const ac = new AbortController();
            writeCategoryPageSpy.mockImplementation(async () => {
                ac.abort(new Error('cancelled by test'));
            });

            const service = new MarkdownGeneratorService(gitFacade, createWorkOpsMock());
            await expect(
                service.initialize(createWork(), createUser(), {
                    readme_split_threshold_bytes: 900,
                    signal: ac.signal,
                }),
            ).rejects.toThrow('cancelled by test');

            expect(writeCategoryPageSpy).toHaveBeenCalledTimes(1);
            expect(removeStaleCategoryPagesSpy).not.toHaveBeenCalled();
            expect(gitFacade.addAll).not.toHaveBeenCalled();
            expect(gitFacade.commit).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
        });

        it('never splits when the markdown and data roles are one repository', async () => {
            mountDirectory({ dir: '/tmp/markdown-repo' });

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser(), {
                readme_split_threshold_bytes: 200,
            });

            const readme = writeReadmeSpy.mock.calls[0][0] as string;
            expect(readme).toContain('## First Category');
            expect(readme).toContain('About beta');
            expect(writeCategoryPageSpy).not.toHaveBeenCalled();
        });

        it('links Work.website from the split README, falling back to company_website', async () => {
            mountDirectory({
                getConfig: jest.fn().mockResolvedValue({
                    content_table: false,
                    company_website: 'https://company.test',
                }),
            });
            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork({ website: 'https://site.test' }), createUser(), {
                readme_split_threshold_bytes: 200,
            });
            expect(writeReadmeSpy.mock.calls[0][0]).toContain('[site.test](https://site.test)');

            writeReadmeSpy.mockClear();
            mountDirectory({
                getConfig: jest.fn().mockResolvedValue({
                    content_table: false,
                    company_website: 'https://company.test',
                }),
            });
            await service.initialize(createWork(), createUser(), {
                readme_split_threshold_bytes: 200,
            });
            expect(writeReadmeSpy.mock.calls[0][0]).toContain(
                '[company.test](https://company.test)',
            );
        });

        it('redacts secret-like values from the index README and the category pages, README first', async () => {
            const token = `ghp_${'a1B2'.repeat(9)}`;
            // a featured item carrying a token (so it is on the index README
            // too) plus long fillers that push the single file over 1000 bytes
            fsMock.readdir.mockResolvedValueOnce(['leaky', 'f1', 'f2', 'f3']);
            mountDataRepoMock({
                getItem: jest.fn().mockImplementation((slug: string) =>
                    slug === 'leaky'
                        ? {
                              slug,
                              name: 'Leaky',
                              description: `token ${token}`,
                              source_url: 'https://leaky.test',
                              category: 'misc',
                              featured: true,
                          }
                        : {
                              slug,
                              name: slug,
                              description: 'filler '.repeat(60),
                              source_url: 'https://filler.test',
                              category: 'other',
                          },
                ),
            });

            const service = new MarkdownGeneratorService(
                createGitFacadeMock(),
                createWorkOpsMock(),
            );
            await service.initialize(createWork(), createUser(), {
                readme_split_threshold_bytes: 1000,
            });

            const readme = writeReadmeSpy.mock.calls[0][0] as string;
            expect(readme).toContain('## ⭐ Featured');
            expect(readme).toContain('[redacted secret]');
            expect(readme).not.toContain(token);
            expect(writeCategoryPageSpy).toHaveBeenCalled();
            for (const [, content] of writeCategoryPageSpy.mock.calls) {
                expect(content).not.toContain(token);
            }
            expect(writeReadmeSpy.mock.invocationCallOrder[0]).toBeLessThan(
                Math.min(...writeCategoryPageSpy.mock.invocationCallOrder),
            );
        });
    });

    describe('TaxonomyResolver', () => {
        const entries = [
            { id: 'cloud-devops-mcp-servers', name: 'Cloud & DevOps MCP Servers' },
            { id: 'monitoring', name: 'Monitoring' },
        ];

        it('normalizeTaxonomyKey folds case, accents, & and punctuation into hyphens', () => {
            expect(normalizeTaxonomyKey('Cloud & DevOps MCP Servers')).toBe(
                'cloud-devops-mcp-servers',
            );
            expect(normalizeTaxonomyKey('  Cloud  DevOps, MCP-Servers! ')).toBe(
                'cloud-devops-mcp-servers',
            );
            expect(normalizeTaxonomyKey('Café Tools')).toBe('cafe-tools');
            expect(normalizeTaxonomyKey('数据库 工具')).toBe('数据库-工具');
            expect(normalizeTaxonomyKey(undefined)).toBe('');
        });

        it('matches an exact id first', () => {
            const resolver = new TaxonomyResolver(entries);
            expect(resolver.resolve('monitoring')).toBe(entries[1]);
        });

        it('matches names and ids loosely', () => {
            const resolver = new TaxonomyResolver(entries);
            expect(resolver.resolve('Cloud & Devops Mcp Servers')).toBe(entries[0]);
            expect(resolver.resolve('Cloud DevOps MCP Servers')).toBe(entries[0]);
            expect(resolver.resolve('CLOUD-DEVOPS-MCP-SERVERS')).toBe(entries[0]);
            expect(resolver.resolve('MONITORING')).toBe(entries[1]);
        });

        it('prefers a loose name match over a loose id match of another entry', () => {
            const a = { id: 'x1', name: 'Tools' };
            const b = { id: 'tools', name: 'Utilities' };
            const resolver = new TaxonomyResolver([b, a]);
            // `Tools` (not an exact id) reads like a display name → entry `a`
            expect(resolver.resolve('Tools')).toBe(a);
            // the exact id still wins
            expect(resolver.resolve('tools')).toBe(b);
        });

        it('registers an ad-hoc entry for an unknown value and reuses it for its spellings', () => {
            const resolver = new TaxonomyResolver(entries);
            const first = resolver.resolve('Brand New');
            expect(first).toEqual({ id: 'Brand New', name: 'Brand New' });
            expect(resolver.resolve('brand-new')).toBe(first);
            expect(resolver.resolve('Brand New')).toBe(first);
            expect(resolver.get('Brand New')).toBe(first);
        });

        it('resolves inline objects by id or name, and registers unknown ones as-is', () => {
            const resolver = new TaxonomyResolver(entries);
            expect(resolver.resolve({ id: 'monitoring', name: 'Stale' })).toBe(entries[1]);
            expect(resolver.resolve({ id: 'Monitoring', name: 'Other' })).toBe(entries[1]);
            const inline = { id: 'new', name: 'New One' };
            expect(resolver.resolve(inline)).toBe(inline);
            expect(resolver.resolve('New One')).toBe(inline);
        });

        it('ignores malformed entries (missing / empty id) from the yml file', () => {
            const resolver = new TaxonomyResolver([
                null,
                { name: 'No Id' },
                { id: '', name: 'Empty' },
                entries[1],
            ] as never);
            expect(resolver.resolve('monitoring')).toBe(entries[1]);
            expect(resolver.resolve('No Id')).toEqual({ id: 'No Id', name: 'No Id' });
        });
    });

    describe('initialize — README + commit/push/PR', () => {
        it('passes content_table=true through to ReadmeBuilder.enableToC()', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const enableToCSpy = jest.spyOn(ReadmeBuilder.prototype, 'enableToC');
            mountDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ content_table: true }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(enableToCSpy).toHaveBeenCalledTimes(1);
        });

        it('skips ReadmeBuilder.enableToC when content_table is false', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const enableToCSpy = jest.spyOn(ReadmeBuilder.prototype, 'enableToC');
            mountDataRepoMock({
                getConfig: jest.fn().mockResolvedValue({ content_table: false }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(enableToCSpy).not.toHaveBeenCalled();
        });

        it('addAll → commit("sync README.md", committer) → push order is preserved', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(gitFacade.addAll).toHaveBeenCalledWith('github', '/tmp/markdown-repo');
            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/markdown-repo',
                'sync README.md',
                COMMITTER,
            );
            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/markdown-repo' },
                {
                    userId: 'user-1',
                    providerId: 'github',
                    workId: 'dir-1',
                },
            );
            const addOrder = gitFacade.addAll.mock.invocationCallOrder[0];
            const commitOrder = gitFacade.commit.mock.invocationCallOrder[0];
            const pushOrder = gitFacade.push.mock.invocationCallOrder[0];
            expect(addOrder).toBeLessThan(commitOrder);
            expect(commitOrder).toBeLessThan(pushOrder);
        });

        it('writes README.md from ReadmeBuilder.build() output', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();
            const buildSpy = jest
                .spyOn(ReadmeBuilder.prototype, 'build')
                .mockReturnValue('# README');

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            expect(buildSpy).toHaveBeenCalled();
            expect(writeReadmeSpy).toHaveBeenCalledWith('# README');
        });

        it('CREATE_UPDATE + canCreatePR + defaultBranch: opens PR and persists lastPullRequest', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'pr-branch', title: 'My PR', body: 'PR body' },
            });

            expect(gitFacade.createPullRequest).toHaveBeenCalledWith(
                {
                    owner: 'acme',
                    repo: 'test-work',
                    base: 'main',
                    head: 'pr-branch',
                    title: 'My PR',
                    body: 'PR body',
                },
                {
                    userId: 'user-1',
                    providerId: 'github',
                    workId: 'dir-1',
                },
            );
            expect(workOps.updateLastPullRequest).toHaveBeenCalledWith('dir-1', {
                main: {
                    branch: 'pr-branch',
                    title: 'My PR',
                    body: 'PR body',
                    number: 42,
                    url: 'https://pr/42',
                },
            });
        });

        /**
         * Quality gates (audit W3 M3) — the markdown sync is one of the
         * non-worker `createPullRequest` callers. The render is committed and
         * pushed either way; the gate only decides whether it may be proposed
         * for merge.
         */
        describe('pull-request quality gate', () => {
            const allowingGate = () => ({
                evaluate: jest.fn().mockResolvedValue({
                    allowed: true,
                    policy: 'required',
                    gateStatus: 'green',
                    results: [],
                }),
            });
            const refusingGate = () => ({
                evaluate: jest.fn().mockResolvedValue({
                    allowed: false,
                    policy: 'required',
                    gateStatus: 'red',
                    results: [],
                    reason: 'Quality gate red — failing required checks: build (red).',
                }),
            });

            it('gate passes → the PR is opened, judged against the markdown checkout', async () => {
                const gitFacade = createGitFacadeMock();
                const workOps = createWorkOpsMock();
                mountDataRepoMock();
                const gate = allowingGate();

                const service = new MarkdownGeneratorService(gitFacade, workOps, gate as never);
                await service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: { branch: 'pr-branch', title: 'My PR', body: 'PR body' },
                });

                expect(gate.evaluate).toHaveBeenCalledWith(
                    expect.objectContaining({ cwd: '/tmp/markdown-repo' }),
                );
                expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
                expect(workOps.updateLastPullRequest).toHaveBeenCalled();
            });

            it('gate fails → NO PR, no lastPullRequest write, but the push still happened', async () => {
                const gitFacade = createGitFacadeMock();
                const workOps = createWorkOpsMock();
                mountDataRepoMock();

                const service = new MarkdownGeneratorService(
                    gitFacade,
                    workOps,
                    refusingGate() as never,
                );
                await service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: { branch: 'pr-branch', title: 'My PR', body: 'PR body' },
                });

                expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
                // A PR that was never opened must not be recorded as the
                // Work's last pull request.
                expect(workOps.updateLastPullRequest).not.toHaveBeenCalled();
                expect(gitFacade.push).toHaveBeenCalled();
            });

            it('no gate wired → unchanged pre-gate behaviour', async () => {
                const gitFacade = createGitFacadeMock();
                const workOps = createWorkOpsMock();
                mountDataRepoMock();

                const service = new MarkdownGeneratorService(gitFacade, workOps);
                await service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: { branch: 'pr-branch', title: 'My PR', body: 'PR body' },
                });

                expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
                expect(workOps.updateLastPullRequest).toHaveBeenCalled();
            });
        });

        it('createPullRequest rejection is swallowed; no updateLastPullRequest, no service throw', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.createPullRequest.mockRejectedValueOnce(new Error('upstream 500'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), {
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: { branch: 'feat', title: 't', body: 'b' },
                }),
            ).resolves.toEqual({ filesChanged: expect.any(Number) });
            expect(workOps.updateLastPullRequest).not.toHaveBeenCalled();
        });

        it('does NOT open a PR when canCreatePR is true but defaultBranch resolved to null', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.getMainBranch.mockResolvedValueOnce(null as any);
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser(), {
                generation_method: GenerationMethod.CREATE_UPDATE,
                pr_update: { branch: 'feat', title: 't', body: 'b' },
            });

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        });

        it('rethrows when an inner step (e.g. addAll) rejects — error path logs + propagates', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.addAll.mockRejectedValueOnce(new Error('addAll failed'));
            const workOps = createWorkOpsMock();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.initialize(createWork(), createUser())).rejects.toThrow(
                'addAll failed',
            );
        });
    });

    describe('initialize — generation cancellation', () => {
        it('throws GenerationCancelledError immediately when signal already aborted', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const ac = new AbortController();
            ac.abort();
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), { signal: ac.signal }),
            ).rejects.toThrow(/cancelled/i);
            // No git operations should have happened
            expect(gitFacade.createRepository).not.toHaveBeenCalled();
        });

        it('uses signal.reason if provided as Error during cancellation check', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const ac = new AbortController();
            const reason = new Error('user-cancelled');
            ac.abort(reason);
            mountDataRepoMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.initialize(createWork(), createUser(), { signal: ac.signal }),
            ).rejects.toBe(reason);
        });

        it('produces a generic AbortError when isGenerationCancelledError-style helper is exercised', () => {
            const err = createGenerationCancelledError();
            expect(err.name).toBe('AbortError');
            expect(err.message).toMatch(/cancelled/i);
        });
    });

    describe('removeItemDetail', () => {
        it('clones via cloneOrPull (not cloneFreshRepository) and calls removeDetails(slug)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeItemDetail(createWork(), createUser(), 'item-x');

            expect(cloneFreshRepositoryMock).not.toHaveBeenCalled();
            expect(gitFacade.cloneOrPull).toHaveBeenCalledTimes(1);
            const [cloneOpts, gitOpts] = gitFacade.cloneOrPull.mock.calls[0];
            expect(cloneOpts).toEqual({
                owner: 'acme',
                repo: 'test-work',
                committer: COMMITTER,
            });
            expect(gitOpts).toEqual({
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
            expect(removeDetailsSpy).toHaveBeenCalledWith('item-x');
        });

        it('switches to PR branch (force=true) when branch arg is provided BEFORE removing the detail', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeItemDetail(createWork(), createUser(), 'item-x', 'pr-feature');

            expect(gitFacade.switchBranch).toHaveBeenCalledWith(
                'github',
                expect.any(String),
                'pr-feature',
                true,
            );
            const switchOrder = gitFacade.switchBranch.mock.invocationCallOrder[0];
            const removeOrder = removeDetailsSpy.mock.invocationCallOrder[0];
            expect(switchOrder).toBeLessThan(removeOrder);
        });

        it('swallows switchBranch rejection but STILL calls removeDetails', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.switchBranch.mockRejectedValueOnce(new Error('cannot checkout'));
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(
                service.removeItemDetail(createWork(), createUser(), 'item-x', 'pr'),
            ).resolves.toBeUndefined();
            expect(removeDetailsSpy).toHaveBeenCalledWith('item-x');
        });

        it('does NOT call switchBranch when branch arg is omitted', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeItemDetail(createWork(), createUser(), 'item-x');

            expect(gitFacade.switchBranch).not.toHaveBeenCalled();
            expect(removeDetailsSpy).toHaveBeenCalledWith('item-x');
        });
    });

    describe('removeRepository', () => {
        it('deletes the remote repo, then cleans the local dir derived from getLocalDir()', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.removeRepository(createWork(), createUser());

            expect(gitFacade.deleteRepository).toHaveBeenCalledWith('acme', 'test-work', {
                userId: 'user-1',
                providerId: 'github',
                workId: 'dir-1',
            });
            expect(gitFacade.getLocalDir).toHaveBeenCalledWith('github', 'acme', 'test-work');
            expect(cleanupSpy).toHaveBeenCalledTimes(1);
            const deleteOrder = gitFacade.deleteRepository.mock.invocationCallOrder[0];
            const cleanupOrder = cleanupSpy.mock.invocationCallOrder[0];
            expect(deleteOrder).toBeLessThan(cleanupOrder);
        });

        it('rethrows when deleteRepository rejects (cleanup is NOT attempted)', async () => {
            const gitFacade = createGitFacadeMock();
            gitFacade.deleteRepository.mockRejectedValueOnce(new Error('403 forbidden'));
            const workOps = createWorkOpsMock();

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await expect(service.removeRepository(createWork(), createUser())).rejects.toThrow(
                '403 forbidden',
            );
            expect(cleanupSpy).not.toHaveBeenCalled();
        });
    });

    describe('cleanup', () => {
        it('returns the markdown-repository cleanup() result on the dir derived from getLocalDir()', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            cleanupSpy.mockResolvedValueOnce('ok' as any);

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            const result = await service.cleanup(createWork());

            expect(gitFacade.getLocalDir).toHaveBeenCalledWith('github', 'acme', 'test-work');
            expect(cleanupSpy).toHaveBeenCalledTimes(1);
            expect(result).toBe('ok');
        });
    });

    describe('private — generateReadme + sortCategoriesByPriority', () => {
        const callPrivate = (
            service: MarkdownGeneratorService,
            method: 'generateReadme' | 'sortCategoriesByPriority',
            ...args: unknown[]
        ): unknown =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (service as any)[method](...args);

        it('sorts featured-bearing categories before non-featured (regardless of priority)', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                'no-featured': [{ slug: 'a', name: 'A', featured: false }],
                'with-featured': [{ slug: 'b', name: 'B', featured: true }],
            };
            const categories = new Map<string, any>([
                ['no-featured', { id: 'no-featured', name: 'No Featured', priority: 1 }],
                ['with-featured', { id: 'with-featured', name: 'With Featured', priority: 99 }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['with-featured', 'no-featured']);
        });

        it('within the same featured-bucket, sorts by ascending priority when both have priority', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                low: [{ slug: 'a', name: 'A' }],
                high: [{ slug: 'b', name: 'B' }],
            };
            const categories = new Map<string, any>([
                ['low', { id: 'low', name: 'Low', priority: 10 }],
                ['high', { id: 'high', name: 'High', priority: 1 }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['high', 'low']);
        });

        it('A-has-priority / B-has-no-priority → A wins (returns -1)', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                noprio: [{ slug: 'a', name: 'A' }],
                prio: [{ slug: 'b', name: 'B' }],
            };
            const categories = new Map<string, any>([
                ['noprio', { id: 'noprio', name: 'No prio' }],
                ['prio', { id: 'prio', name: 'Prio', priority: 5 }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['prio', 'noprio']);
        });

        it('falls back to alphabetical name when both lack priority and have equal featured count', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                bee: [{ slug: 'a', name: 'A' }],
                ant: [{ slug: 'b', name: 'B' }],
            };
            const categories = new Map<string, any>([
                ['bee', { id: 'bee', name: 'Bee' }],
                ['ant', { id: 'ant', name: 'Ant' }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['ant', 'bee']);
        });

        it('when both have no priority but different featured counts, the higher featured count wins', () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const groups = {
                one: [{ slug: 'a', featured: true }],
                two: [
                    { slug: 'b', featured: true },
                    { slug: 'c', featured: true },
                ],
            };
            const categories = new Map<string, any>([
                ['one', { id: 'one', name: 'One' }],
                ['two', { id: 'two', name: 'Two' }],
            ]);

            const result = callPrivate(service, 'sortCategoriesByPriority', groups, categories);
            expect(result).toEqual(['two', 'one']);
        });

        it('within a category: featured-true items precede featured-false (stable across order)', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['a', 'b']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockImplementation((slug: string) =>
                    slug === 'a'
                        ? {
                              slug: 'a',
                              name: 'A',
                              description: '',
                              category: 'misc',
                              featured: false,
                          }
                        : {
                              slug: 'b',
                              name: 'B',
                              description: '',
                              category: 'misc',
                              featured: true,
                          },
                ),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const orderedSlugs = builderSpy.mock.calls.map((c) => (c[0] as any).slug);
            expect(orderedSlugs).toEqual(['b', 'a']);
        });

        it('within a category, equal-featured items sort by explicit ascending order, then alphabetical name', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['c', 'a', 'b']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockImplementation((slug: string) => {
                    const map: Record<string, any> = {
                        a: { slug: 'a', name: 'AA', description: '', category: 'misc', order: 5 },
                        b: { slug: 'b', name: 'BB', description: '', category: 'misc', order: 5 },
                        c: { slug: 'c', name: 'CC', description: '', category: 'misc', order: 1 },
                    };
                    return map[slug];
                }),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const orderedSlugs = builderSpy.mock.calls.map((c) => (c[0] as any).slug);
            expect(orderedSlugs).toEqual(['c', 'a', 'b']);
        });

        it('passes hasDetails:true to addItem when markdowns Set contains the slug', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x', 'y']);
            mountDataRepoMock({
                getMarkdown: jest
                    .fn()
                    .mockResolvedValueOnce('# X')
                    .mockResolvedValueOnce(undefined),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug,
                    description: '',
                    category: 'misc',
                })),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const calls = builderSpy.mock.calls;
            const xCall = calls.find((c) => (c[0] as any).slug === 'x');
            const yCall = calls.find((c) => (c[0] as any).slug === 'y');
            expect(xCall![1]).toEqual({ hasDetails: true });
            expect(yCall![1]).toEqual({ hasDetails: false });
        });
    });

    describe('private — populate (via initialize tags path)', () => {
        it('returns the cached value when a tag id is already in the map', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValueOnce({
                    slug: 'x',
                    name: 'X',
                    description: '',
                    category: 'misc',
                    // pass an object that already exists in tag map by id
                    tags: [{ id: 'hot', name: 'Stale' }],
                }),
                getTags: jest.fn().mockResolvedValue([{ id: 'hot', name: 'Hot' }]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const passedItem = builderSpy.mock.calls[0][0] as { tags?: any };
            // The cached tag (Hot) wins over the inline-passed object (Stale).
            expect(passedItem.tags).toEqual([{ id: 'hot', name: 'Hot' }]);
        });

        it('when a tag string is not in the map, registers a freshly-built {id,name} entry and reuses it', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const builderSpy = jest.spyOn(ReadmeBuilder.prototype, 'addItem');
            fsMock.readdir.mockResolvedValueOnce(['x', 'y']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockImplementation((slug: string) => ({
                    slug,
                    name: slug,
                    description: '',
                    category: 'misc',
                    tags: ['shiny'],
                })),
                getTags: jest.fn().mockResolvedValue([]),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            await service.initialize(createWork(), createUser());

            const xTags = (builderSpy.mock.calls[0][0] as any).tags;
            const yTags = (builderSpy.mock.calls[1][0] as any).tags;
            expect(xTags).toEqual([{ id: 'shiny', name: 'shiny' }]);
            // Same instance reused on subsequent population
            expect(yTags[0]).toBe(xTags[0]);
        });
    });

    // EW-628 Phase 2 — syncFromDataRepo is the public render-only entry
    // the new DataSyncService (Phase 3) calls from both webhook and poller
    // paths. It delegates to initialize() and returns timing + SHA stats
    // (G5 wires the real SHA capture; G3 already consumes the result).
    describe('syncFromDataRepo — EW-628 render-only entry', () => {
        it('delegates to initialize() with the caller-supplied signal and returns a non-negative durationMs', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce([]);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValue(undefined),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            const initializeSpy = jest.spyOn(service, 'initialize');
            const work = createWork();
            const user = createUser();
            const ac = new AbortController();

            const result = await service.syncFromDataRepo(work, user, { signal: ac.signal });

            expect(initializeSpy).toHaveBeenCalledTimes(1);
            expect(initializeSpy).toHaveBeenCalledWith(work, user, { signal: ac.signal });
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(result.filesChanged).toBeGreaterThanOrEqual(0);
        });

        it('propagates AbortSignal — pre-aborted signal throws and skips downstream git calls', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            const service = new MarkdownGeneratorService(gitFacade, workOps);

            const ac = new AbortController();
            ac.abort();

            await expect(
                service.syncFromDataRepo(createWork(), createUser(), { signal: ac.signal }),
            ).rejects.toThrow();

            expect(gitFacade.createRepository).not.toHaveBeenCalled();
            expect(cloneFreshRepositoryMock).not.toHaveBeenCalled();
        });

        it('default options object — no signal, no expectedSourceSha — still returns a SyncFromDataRepoResult', async () => {
            const gitFacade = createGitFacadeMock();
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce([]);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValue(undefined),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            const result = await service.syncFromDataRepo(createWork(), createUser());

            expect(result).toEqual(
                expect.objectContaining({
                    durationMs: expect.any(Number),
                    filesChanged: expect.any(Number),
                }),
            );
        });

        // EW-628 G5 — real SHA capture + filesChanged from MarkdownRepository
        // write counter. The before-sha comes off `work.lastSyncedDataRepoSha`
        // (so it represents the SHA the previous sync rendered against), and
        // the after-sha is fetched from the git provider AFTER `initialize`
        // returns (so we record the SHA we actually rendered, not whatever
        // races into HEAD mid-flight).
        it('G5: returns beforeSha = work.lastSyncedDataRepoSha and afterSha = provider HEAD', async () => {
            const gitFacade = createGitFacadeMock();
            (gitFacade.getRepository as jest.Mock).mockResolvedValue({
                defaultBranch: 'main',
            });
            (gitFacade.getLatestCommit as jest.Mock).mockResolvedValue({
                sha: 'bbbbbbbb',
                message: 'latest',
                author: { name: 'A', email: 'a@b' },
                date: '2026-05-16T00:00:00Z',
            });
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce(['slug-1']);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue('# slug-1\n'),
                getItem: jest.fn().mockResolvedValue({ id: 'slug-1', tags: [], category: 'cat' }),
            });
            // The write methods are stubbed by the outer beforeEach so the
            // actual `writeCount++` lines never run. Spy on getWriteCount
            // directly to return a representative count — this still verifies
            // that initialize's returned `filesChanged` is forwarded to
            // the SyncFromDataRepoResult.
            jest.spyOn(MarkdownRepository.prototype, 'getWriteCount').mockReturnValue(3);

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            const work = createWork({ lastSyncedDataRepoSha: 'aaaaaaa' });

            const result = await service.syncFromDataRepo(work, createUser());

            expect(result.beforeSha).toBe('aaaaaaa');
            expect(result.afterSha).toBe('bbbbbbbb');
            expect(result.filesChanged).toBe(3);
            expect(gitFacade.getRepository).toHaveBeenCalledWith(
                'acme',
                'test-work-data',
                expect.objectContaining({ workId: 'dir-1', providerId: 'github' }),
            );
            expect(gitFacade.getLatestCommit).toHaveBeenCalledWith(
                'acme',
                'test-work-data',
                'main',
                expect.objectContaining({ workId: 'dir-1', providerId: 'github' }),
            );
        });

        it('G5: afterSha falls back to undefined (not throw) when the provider SHA fetch fails', async () => {
            const gitFacade = createGitFacadeMock();
            (gitFacade.getRepository as jest.Mock).mockResolvedValue({ defaultBranch: 'main' });
            (gitFacade.getLatestCommit as jest.Mock).mockRejectedValue(
                new Error('GitHub rate-limited'),
            );
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce([]);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValue(undefined),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            const result = await service.syncFromDataRepo(createWork(), createUser());

            expect(result.afterSha).toBeUndefined();
            // The activity row still records duration + filesChanged, so the
            // sync degrades gracefully rather than failing the run.
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('G5: beforeSha is undefined on a Work that has never been synced before', async () => {
            const gitFacade = createGitFacadeMock();
            (gitFacade.getRepository as jest.Mock).mockResolvedValue({ defaultBranch: 'main' });
            (gitFacade.getLatestCommit as jest.Mock).mockResolvedValue({
                sha: 'first',
                message: 'first',
                author: { name: 'A', email: 'a@b' },
                date: '2026-05-16T00:00:00Z',
            });
            const workOps = createWorkOpsMock();
            fsMock.readdir.mockResolvedValueOnce([]);
            mountDataRepoMock({
                getMarkdown: jest.fn().mockResolvedValue(undefined),
                getItem: jest.fn().mockResolvedValue(undefined),
            });

            const service = new MarkdownGeneratorService(gitFacade, workOps);
            const work = createWork({ lastSyncedDataRepoSha: null });

            const result = await service.syncFromDataRepo(work, createUser());

            expect(result.beforeSha).toBeUndefined();
            expect(result.afterSha).toBe('first');
        });
    });
});
