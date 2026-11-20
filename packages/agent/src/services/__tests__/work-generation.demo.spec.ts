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

import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkRepository } from '../../database/repositories/work.repository';
import { Work } from '../../entities/work.entity';
import { GenerateStatusType } from '../../entities/types';
import type { User } from '../../entities/user.entity';
import type { CreateItemsGeneratorDto } from '../../items-generator/dto/create-items-generator.dto';
import type { CreateWorkDto } from '../../dto/create-work.dto';
import { DemoFeatureDisabledError } from '../../demo';
import { EverWorksGitProvider } from '../../ever-works-providers/ever-works-git.provider';
import type { EverWorksGitHttpFetch } from '../../ever-works-providers/ever-works-git.provider';
import { WorkGenerationService } from '../work-generation.service';
import { WorkLifecycleService } from '../work-lifecycle.service';

/**
 * Platform demo mode, controller ruling R2 — Generate on the seeded draft
 * directory Work.
 *
 * The seeder creates that Work with `storageProvider: 'ever-works-git'` and NO
 * repository (no GitHub call at seed time). Before this change, Generate sent it
 * straight to the data generator, whose `gitFacade.createRepository` would make
 * `<slug>-data` under whatever account the platform token belongs to — not a
 * `demo-` repository in the customer org, and the same name for every sandbox.
 * Now Generate first provisions the Work's repository through
 * `EverWorksGitProvider` (same naming and persistence as `createWork`), so the
 * data generator finds an existing org repository to write into.
 *
 * Real pieces: the SQLite `works` table, `WorkLifecycleService` and
 * `EverWorksGitProvider` (its HTTP faked through the provider's fetch
 * injection). The generators are fakes that record the Work they were handed.
 */

const ORG = 'ever-works-cloud';
const DEMO_REPO = 'demo-1a2b3c4d-awesome-ai-coding-tools';

const demoUser = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'demo-1a2b3c4d',
    email: 'demo-1a2b3c4d@demo.ever.works',
    registrationProvider: 'demo',
} as User;

/** An operator account (not a sandbox) acting on the sandbox's Work. */
const operator = {
    id: '33333333-3333-4333-8333-333333333333',
    username: 'operator',
    email: 'operator@ever.works',
    registrationProvider: 'local',
} as User;

class FetchInjectedEverWorksGit extends EverWorksGitProvider {
    constructor(private readonly fetchImpl: EverWorksGitHttpFetch) {
        super();
    }

    override createRepository(options: Parameters<EverWorksGitProvider['createRepository']>[0]) {
        return super.createRepository({ ...options, fetchImpl: this.fetchImpl });
    }
}

function githubCreates(): jest.Mock {
    return jest.fn(async (_url: string, init: RequestInit) => {
        const { name } = JSON.parse(init.body as string) as { name: string };
        return new Response(
            JSON.stringify({
                name,
                owner: { login: ORG },
                full_name: `${ORG}/${name}`,
                html_url: `https://github.com/${ORG}/${name}`,
                clone_url: `https://github.com/${ORG}/${name}.git`,
                private: true,
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
        );
    });
}

describe('WorkGenerationService.generateItems — the seeded demo draft Work (R2)', () => {
    const ORIGINAL_ENV = { ...process.env };
    let dataSource: DataSource;
    let works: WorkRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        works = new WorkRepository(dataSource.getRepository(Work));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(Work).clear();
        process.env.DEMO = 'true';
        process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
        process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = 'ghp_test';
        process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = ORG;
        delete process.env.DEMO_MAX_WORKS_PER_SANDBOX;
        delete process.env.DEMO_REPO_PREFIX;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.restoreAllMocks();
    });

    function build() {
        const fetchImpl = githubCreates();
        // The Work owner's account, read when the requester is someone else (the cap is the
        // owner's, not the requester's).
        const users = {
            findById: jest.fn(async (id: string) => (id === demoUser.id ? demoUser : null)),
        };
        const lifecycle = new WorkLifecycleService(
            works,
            users as never,
            { getItems: jest.fn().mockResolvedValue([]) } as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { isHiddenProvider: jest.fn().mockReturnValue(false) } as never, // deployFacade
            { getWebsiteTemplateIdForNewWork: jest.fn().mockResolvedValue(null) } as never,
            {} as never,
            { assertWithinQuota: jest.fn() } as never,
            new FetchInjectedEverWorksGit(fetchImpl as unknown as EverWorksGitHttpFetch),
            {} as never,
            { emit: jest.fn() } as never,
            { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) } as never,
            {} as never,
            {} as never, // gitFacade: only the Repository Work create path reads it
        );

        /** What each generator was handed, as the Work it would write the repositories of. */
        const seen: { data?: Work; website?: Work } = {};
        const dataGenerator = {
            initialize: jest.fn(async (work: Work, _user: User, _dto: CreateItemsGeneratorDto) => {
                seen.data = work;
                return {
                    success: true,
                    prUpdate: null,
                    stats: { newItemsCount: 2, updatedItemsCount: 0, totalItemsCount: 2 },
                    warnings: [],
                    hasExistingItems: false,
                };
            }),
        };
        const websiteGenerator = {
            initialize: jest.fn(async (work: Work) => {
                seen.website = work;
            }),
        };
        const history = {
            createEntry: jest.fn(async () => ({ id: 'history-1', startedAt: new Date() })),
            updateEntry: jest.fn().mockResolvedValue(undefined),
            appendLogs: jest.fn().mockResolvedValue(undefined),
        };
        const service = new WorkGenerationService(
            dataGenerator as never,
            { initialize: jest.fn().mockResolvedValue(undefined) } as never, // markdownGenerator
            websiteGenerator as never,
            {} as never, // websiteUpdateService
            {} as never, // itemSubmissionService
            works,
            { emit: jest.fn() } as never, // eventEmitter
            history as never,
            {
                ensureCanEdit: jest.fn(async (workId: string) => ({
                    work: await works.findByIdForAccess(workId),
                })),
            } as never,
            {} as never, // workScheduleService
            {} as never, // workImportService
            {} as never, // userRepository
            {} as never, // screenshotFacade
            {} as never, // aiFacade
            {} as never, // contentExtractorFacade
            {
                validateSelectedProviders: jest.fn().mockResolvedValue(undefined),
                validateFormSchemaPlugins: jest.fn().mockResolvedValue(undefined),
                processFormConfig: jest.fn().mockResolvedValue({ config: {}, pluginConfig: {} }),
            } as never,
            { enablePluginForWork: jest.fn().mockResolvedValue(undefined) } as never,
            { isPluginEnabledForScope: jest.fn().mockResolvedValue(true) } as never,
            undefined, // generationDispatcher
            undefined, // notificationService
            undefined, // runtimeBindingStamper
            undefined, // workMemory
            lifecycle,
        );
        return {
            service,
            fetchImpl,
            dataGenerator,
            websiteGenerator,
            history,
            seen,
            lifecycle,
        };
    }

    /** The seeder's draft: `createDraftWork`, then `storageProvider: 'ever-works-git'` on the row. */
    async function seedDraft(lifecycle: WorkLifecycleService): Promise<string> {
        const draft = await lifecycle.createDraftWork(demoUser, {
            name: 'Awesome AI Coding Tools',
            slug: 'awesome-ai-coding-tools',
            description: 'A curated directory of AI coding assistants',
        });
        await works.update(draft.id, { storageProvider: 'ever-works-git' });
        return draft.id;
    }

    async function storeRepositoryWork(slug: string): Promise<void> {
        await works.create(
            {
                slug,
                name: slug,
                description: `The ${slug} directory`,
                userId: demoUser.id,
                owner: ORG,
                organization: true,
                storageProvider: 'ever-works-git',
                sourceRepository: {
                    url: `https://github.com/${ORG}/demo-1a2b3c4d-${slug}`,
                    owner: ORG,
                    repo: `demo-1a2b3c4d-${slug}`,
                    type: 'data_repo',
                    importedAt: new Date(),
                },
            },
            demoUser,
        );
    }

    const generate = (service: WorkGenerationService, workId: string) =>
        service.generateItems(
            workId,
            {
                name: 'Awesome AI Coding Tools',
                prompt: 'AI coding tools',
            } as CreateItemsGeneratorDto,
            demoUser,
            true,
        );

    it('provisions exactly one demo- repository through EverWorksGitProvider and stores it on the Work', async () => {
        const { service, fetchImpl, lifecycle } = build();
        const workId = await seedDraft(lifecycle);
        expect((await works.findById(workId))!.sourceRepository).toBeFalsy();

        await generate(service, workId);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`https://api.github.com/orgs/${ORG}/repos`);
        expect(JSON.parse(init.body as string)).toMatchObject({ name: DEMO_REPO, private: true });

        const stored = (await works.findById(workId))!;
        expect(stored.owner).toBe(ORG);
        expect(stored.organization).toBe(true);
        expect(stored.sourceRepository).toMatchObject({
            owner: ORG,
            repo: DEMO_REPO,
            type: 'data_repo',
            relatedRepositories: {
                work: { owner: ORG, repo: DEMO_REPO },
                data: { owner: ORG, repo: DEMO_REPO },
                website: { owner: ORG, repo: `${DEMO_REPO}-website` },
            },
        });
    });

    it('hands the generators the org repository, not the user-GitHub <slug>-data path', async () => {
        const { service, lifecycle, seen } = build();
        const workId = await seedDraft(lifecycle);

        await generate(service, workId);

        // The data generator creates/clones `getRepoOwner()/getDataRepo()` with
        // `organization` set: an EXISTING repository in the org, which the git
        // provider answers idempotently. Before, these were `<username>` and
        // `awesome-ai-coding-tools-data` with no organization — a personal repo.
        expect(seen.data!.getRepoOwner('data')).toBe(ORG);
        expect(seen.data!.getDataRepo()).toBe(DEMO_REPO);
        expect(seen.data!.organization).toBe(true);
        expect(seen.data!.storageProvider).toBe('ever-works-git');
        expect(seen.website!.getRepoOwner('website')).toBe(ORG);
        expect(seen.website!.getWebsiteRepo()).toBe(`${DEMO_REPO}-website`);
        expect(seen.website!.organization).toBe(true);
    });

    // No deploy facade sits on the generation path (data → markdown → website); what keeps a
    // demo Work from deploying is that it stores no deploy provider and that the deploy
    // routes are refused to demo users (Task 7).
    it('completes, leaving the Work with no deploy provider', async () => {
        const { service, lifecycle, history } = build();
        const workId = await seedDraft(lifecycle);

        await generate(service, workId);

        const stored = (await works.findById(workId))!;
        expect(stored.generateStatus?.status).toBe(GenerateStatusType.GENERATED);
        expect(history.updateEntry).toHaveBeenCalledWith(
            'history-1',
            expect.objectContaining({ status: GenerateStatusType.GENERATED }),
        );
        expect(stored.deployProvider).toBeNull();
    });

    it('does not provision again on the next Generate', async () => {
        const { service, fetchImpl, lifecycle } = build();
        const workId = await seedDraft(lifecycle);

        await generate(service, workId);
        await generate(service, workId);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((await works.findById(workId))!.getDataRepo()).toBe(DEMO_REPO);
    });

    it('locks the run to the standard pipeline whatever the request named', async () => {
        const { service, lifecycle, dataGenerator } = build();
        const workId = await seedDraft(lifecycle);

        await service.generateItems(
            workId,
            {
                name: 'Awesome AI Coding Tools',
                prompt: 'AI coding tools',
                providers: { pipeline: 'agent-pipeline' },
            } as CreateItemsGeneratorDto,
            demoUser,
            true,
        );

        const dto = dataGenerator.initialize.mock.calls[0][2] as CreateItemsGeneratorDto;
        expect(dto.providers!.pipeline).toBe('standard-pipeline');
    });

    it('names the standard pipeline on a request that names no providers at all', async () => {
        const { service, lifecycle, dataGenerator } = build();
        const workId = await seedDraft(lifecycle);

        await generate(service, workId);

        const dto = dataGenerator.initialize.mock.calls[0][2] as CreateItemsGeneratorDto;
        expect(dto.providers).toEqual({ pipeline: 'standard-pipeline' });
    });

    it('holds the owner to the cap when someone else presses Generate', async () => {
        const { service, fetchImpl, lifecycle } = build();
        const workId = await seedDraft(lifecycle);
        for (const slug of ['one', 'two', 'three']) {
            await storeRepositoryWork(slug);
        }

        const result = service.generateItems(
            workId,
            {
                name: 'Awesome AI Coding Tools',
                prompt: 'AI coding tools',
            } as CreateItemsGeneratorDto,
            operator,
            true,
        );

        await expect(result).rejects.toMatchObject({ feature: 'more than 3 generated Works' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    describe('concurrent requests of one sandbox (one API replica)', () => {
        it('a create and a Generate at 2 repository-backed Works: one wins, one GitHub create', async () => {
            const { service, fetchImpl, lifecycle } = build();
            const workId = await seedDraft(lifecycle);
            await storeRepositoryWork('one');
            await storeRepositoryWork('two');

            const results = await Promise.allSettled([
                lifecycle.createWork(
                    {
                        slug: 'tools',
                        name: 'Tools',
                        description: 'Tools',
                        organization: false,
                    } as CreateWorkDto,
                    demoUser,
                ),
                generate(service, workId),
            ]);

            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            const refused = results.filter((r) => r.status === 'rejected');
            expect(refused).toHaveLength(1);
            expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
                DemoFeatureDisabledError,
            );
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(await works.countRepositoryBackedWorks(demoUser.id)).toBe(3);
        });

        it('two Generates of the same draft: one repository', async () => {
            const { service, fetchImpl, lifecycle } = build();
            const workId = await seedDraft(lifecycle);

            await Promise.all([generate(service, workId), generate(service, workId)]);

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect((await works.findById(workId))!.getDataRepo()).toBe(DEMO_REPO);
        });
    });

    it('refuses Generate once the sandbox has 3 repository-backed Works, before any repo or run', async () => {
        const { service, fetchImpl, lifecycle, dataGenerator, history } = build();
        const workId = await seedDraft(lifecycle);
        for (const slug of ['one', 'two', 'three']) {
            await storeRepositoryWork(slug);
        }

        const result = generate(service, workId);

        await expect(result).rejects.toBeInstanceOf(DemoFeatureDisabledError);
        await expect(result).rejects.toMatchObject({ feature: 'more than 3 generated Works' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(history.createEntry).not.toHaveBeenCalled();
        expect(dataGenerator.initialize).not.toHaveBeenCalled();
        expect((await works.findById(workId))!.sourceRepository).toBeFalsy();
    });

    it('generates as before with the demo off: no provisioning', async () => {
        delete process.env.DEMO;
        const { service, fetchImpl, lifecycle, seen, dataGenerator } = build();
        const workId = await seedDraft(lifecycle);

        await generate(service, workId);

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(seen.data!.sourceRepository).toBeFalsy();
        // ...and the request is left as sent: no providers named, none added.
        const dto = dataGenerator.initialize.mock.calls[0][2] as CreateItemsGeneratorDto;
        expect(dto.providers).toBeUndefined();
    });
});
