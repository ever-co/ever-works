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
import type { User } from '../../entities/user.entity';
import type { CreateWorkDto } from '../../dto/create-work.dto';
import { DemoFeatureDisabledError } from '../../demo';
import { EverWorksGitProvider } from '../../ever-works-providers/ever-works-git.provider';
import type { EverWorksGitHttpFetch } from '../../ever-works-providers/ever-works-git.provider';
import { WorkLifecycleService } from '../work-lifecycle.service';

/**
 * Platform demo mode — a demo sandbox's Works (Task 8):
 *
 *   - storage is Ever Works Git whatever the request says, so the repository is
 *     a private `demo-` repository in the shared customer org;
 *   - no deploy provider is stored, so nothing about the Work can deploy;
 *   - at most `DEMO_MAX_WORKS_PER_SANDBOX` (3) Works with a repository — the
 *     seeded draft and Project Works have none and do not count.
 *
 * The Works live in a real (SQLite) `works` table, so "has a repository" is the
 * stored `sourceRepository` column, not a fake's opinion of it. GitHub is the
 * real `EverWorksGitProvider` with its fetch injected.
 */

const ORG = 'ever-works-cloud';

const demoUser = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'demo-1a2b3c4d',
    email: 'demo-1a2b3c4d@demo.ever.works',
    registrationProvider: 'demo',
} as User;

const otherUser = {
    id: '22222222-2222-4222-8222-222222222222',
    username: 'operator',
    email: 'operator@ever.works',
    registrationProvider: 'local',
} as User;

/**
 * The real provider, its GitHub calls going to `fetchImpl`. It records into a ledger double:
 * on a demo instance with no repository ledger bound it refuses every create (ruling R22).
 */
class FetchInjectedEverWorksGit extends EverWorksGitProvider {
    /** The demo topic calls (`PUT …/topics`, Task 10 R27), kept out of `fetchImpl`'s create count. */
    readonly topicCalls: string[] = [];

    constructor(private readonly fetchImpl: EverWorksGitHttpFetch) {
        super({ record: jest.fn().mockResolvedValue(undefined) });
    }

    override createRepository(options: Parameters<EverWorksGitProvider['createRepository']>[0]) {
        const routed = (async (url: string, init?: RequestInit) => {
            if (init?.method === 'PUT' && url.endsWith('/topics')) {
                this.topicCalls.push(url);
                return new Response(JSON.stringify({ names: ['ever-works-demo'] }), {
                    status: 200,
                });
            }
            return this.fetchImpl(url, init);
        }) as EverWorksGitHttpFetch;
        return super.createRepository({ ...options, fetchImpl: routed });
    }
}

/** GitHub answering `POST /orgs/{org}/repos` with 201 for whatever name was asked. */
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

describe('WorkLifecycleService — demo Works', () => {
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
        // The owning User rows are not under test; `works.userId` carries an FK.
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
        process.env.EVER_WORKS_PROJECT_WORKS_ENABLED = 'true';
        delete process.env.DEMO_MAX_WORKS_PER_SANDBOX;
        delete process.env.DEMO_REPO_PREFIX;
        delete process.env.DEPLOY_EVER_WORKS_ENABLED;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    function makeService() {
        const fetchImpl = githubCreates();
        const deployFacade = {
            isHiddenProvider: jest.fn().mockReturnValue(false),
            deploy: jest.fn(),
        };
        const quota = { assertWithinQuota: jest.fn().mockResolvedValue(undefined) };
        const gitFacade = { createRepository: jest.fn(), getRepository: jest.fn() };
        const templateCatalog = {
            getWebsiteTemplateIdForNewWork: jest.fn().mockResolvedValue(null),
        };
        const service = new WorkLifecycleService(
            works,
            { findById: jest.fn().mockResolvedValue({ onboardingState: null }) } as never,
            { getItems: jest.fn().mockResolvedValue([]) } as never, // dataGenerator
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            deployFacade as never,
            templateCatalog as never,
            {} as never,
            quota as never,
            new FetchInjectedEverWorksGit(fetchImpl as unknown as EverWorksGitHttpFetch),
            {} as never, // everWorksDns
            { emit: jest.fn() } as never,
            { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) } as never,
            {} as never, // organizationRepository
            gitFacade as never,
        );
        return { service, fetchImpl, deployFacade, quota, gitFacade };
    }

    function dto(slug: string, overrides: Partial<CreateWorkDto> = {}): CreateWorkDto {
        return {
            slug,
            name: slug,
            description: `The ${slug} directory`,
            organization: false,
            storageProvider: 'user-github',
            deployProvider: 'vercel',
            ...overrides,
        } as CreateWorkDto;
    }

    /** A Work as `createWork` would leave it with a repository, stored for `user`. */
    async function storeRepositoryWork(user: User, slug: string): Promise<void> {
        await works.create(
            {
                slug,
                name: slug,
                description: `The ${slug} directory`,
                userId: user.id,
                owner: ORG,
                organization: true,
                storageProvider: 'ever-works-git',
                sourceRepository: {
                    url: `https://github.com/${ORG}/${user.username}-${slug}`,
                    owner: ORG,
                    repo: `${user.username}-${slug}`,
                    type: 'data_repo',
                    importedAt: new Date(),
                },
            },
            user,
        );
    }

    /** The sandbox the seeder leaves: a Project Work and a draft directory Work, neither with a repository. */
    async function seedSandbox(service: WorkLifecycleService): Promise<void> {
        await service.createProjectWork(demoUser, { name: 'Launch', slug: 'launch-the-website' });
        const draft = await service.createDraftWork(demoUser, {
            name: 'Awesome AI Coding Tools',
            slug: 'awesome-ai-coding-tools',
            description: 'A curated directory of AI coding assistants',
        });
        await works.update(draft.id, { storageProvider: 'ever-works-git' });
    }

    describe('storage and deploy', () => {
        it('stores Ever Works Git and a demo- repository whatever the request asked for', async () => {
            const { service, fetchImpl, quota } = makeService();

            const result = await service.createWork(
                dto('my-tools', { storageProvider: 'user-github', gitProvider: 'gitlab' }),
                demoUser,
            );

            const stored = await works.findById(result!.work.id);
            expect(stored!.storageProvider).toBe('ever-works-git');
            expect(stored!.gitProvider).toBe('github');
            expect(stored!.owner).toBe(ORG);
            expect(stored!.organization).toBe(true);
            expect(stored!.getDataRepo()).toBe('demo-1a2b3c4d-my-tools');
            expect(stored!.getRepoOwner('data')).toBe(ORG);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.github.com/orgs/${ORG}/repos`);
            expect(quota.assertWithinQuota).not.toHaveBeenCalled();
        });

        it('names the website repository after the demo repository, so it keeps the prefix', async () => {
            const { service } = makeService();

            const result = await service.createWork(dto('my-tools'), demoUser);

            const stored = await works.findById(result!.work.id);
            // Without this every sandbox's `<slug>-website` would be ONE repository in
            // the shared org (the seeded draft has the same slug for every visitor).
            expect(stored!.getWebsiteRepo()).toBe('demo-1a2b3c4d-my-tools-website');
            expect(stored!.getRepoOwner('website')).toBe(ORG);
        });

        it('stores no deploy provider, whatever the request asked for', async () => {
            const { service, deployFacade } = makeService();

            for (const deployProvider of ['vercel', 'ever-works', 'k8s']) {
                const result = await service.createWork(
                    dto(`tools-${deployProvider}`, { deployProvider }),
                    demoUser,
                );
                const stored = await works.findById(result!.work.id);
                expect(stored!.deployProvider).toBeNull();
            }
            expect(deployFacade.deploy).not.toHaveBeenCalled();
        });

        it('leaves another account on a demo instance with the storage it asked for', async () => {
            const { service, fetchImpl } = makeService();

            const result = await service.createWork(dto('my-tools'), otherUser);

            const stored = await works.findById(result!.work.id);
            expect(stored!.storageProvider).toBe('user-github');
            expect(stored!.deployProvider).toBe('vercel');
            expect(fetchImpl).not.toHaveBeenCalled();
        });
    });

    describe('the Works cap', () => {
        it('refuses a 4th repository-backed Work; the seeded draft and Project Works do not count', async () => {
            const { service, fetchImpl } = makeService();
            await seedSandbox(service);
            for (const slug of ['one', 'two', 'three']) {
                await storeRepositoryWork(demoUser, slug);
            }
            const before = await works.countAll({ userId: demoUser.id });

            const result = service.createWork(dto('four'), demoUser);

            await expect(result).rejects.toBeInstanceOf(DemoFeatureDisabledError);
            await expect(result).rejects.toMatchObject({
                feature: 'more than 3 generated Works',
                code: 'DEMO_DISABLED',
            });
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(await works.countAll({ userId: demoUser.id })).toBe(before);
        });

        it('allows the 3rd repository-backed Work beside the seeded draft and Project Works', async () => {
            const { service, fetchImpl } = makeService();
            await seedSandbox(service);
            await storeRepositoryWork(demoUser, 'one');
            await storeRepositoryWork(demoUser, 'two');

            const result = await service.createWork(dto('three'), demoUser);

            expect(result!.status).toBe('success');
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        });

        it('counts only the sandbox’s own Works', async () => {
            const { service } = makeService();
            for (const slug of ['one', 'two', 'three']) {
                await storeRepositoryWork(otherUser, slug);
            }

            const result = await service.createWork(dto('mine'), demoUser);

            expect(result!.status).toBe('success');
        });

        // The demo API is one replica (SQLite): the count, the GitHub create and the insert
        // of one sandbox run one at a time, so parallel creates cannot all see room.
        it.each([2, 5])(
            'lets exactly one of %i parallel creates through at 2 repository-backed Works',
            async (parallel) => {
                const { service, fetchImpl } = makeService();
                await storeRepositoryWork(demoUser, 'one');
                await storeRepositoryWork(demoUser, 'two');

                const results = await Promise.allSettled(
                    Array.from({ length: parallel }, (_, i) =>
                        service.createWork(dto(`parallel-${i}`), demoUser),
                    ),
                );

                expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
                const refused = results.filter(
                    (r): r is PromiseRejectedResult => r.status === 'rejected',
                );
                expect(refused).toHaveLength(parallel - 1);
                for (const r of refused) {
                    expect(r.reason).toBeInstanceOf(DemoFeatureDisabledError);
                    expect(r.reason).toMatchObject({ feature: 'more than 3 generated Works' });
                }
                expect(fetchImpl).toHaveBeenCalledTimes(1);
                expect(await works.countRepositoryBackedWorks(demoUser.id)).toBe(3);
            },
        );

        it('follows DEMO_MAX_WORKS_PER_SANDBOX', async () => {
            process.env.DEMO_MAX_WORKS_PER_SANDBOX = '1';
            const { service } = makeService();
            await storeRepositoryWork(demoUser, 'one');

            await expect(service.createWork(dto('two'), demoUser)).rejects.toMatchObject({
                feature: 'more than 1 generated Works',
            });
        });
    });

    describe('with the demo off', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it('keeps the requested storage and deploy provider and has no cap', async () => {
            const { service, fetchImpl } = makeService();
            for (const slug of ['one', 'two', 'three']) {
                await storeRepositoryWork(demoUser, slug);
            }

            const result = await service.createWork(dto('four'), demoUser);

            const stored = await works.findById(result!.work.id);
            expect(stored!.storageProvider).toBe('user-github');
            expect(stored!.deployProvider).toBe('vercel');
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it('registers only the work and data roles for an Ever Works Git Work, as before', async () => {
            const { service } = makeService();

            const result = await service.createWork(
                dto('my-tools', { storageProvider: 'ever-works-git' }),
                demoUser,
            );

            const stored = await works.findById(result!.work.id);
            expect(Object.keys(stored!.sourceRepository!.relatedRepositories!).sort()).toEqual([
                'data',
                'work',
            ]);
            expect(stored!.getWebsiteRepo()).toBe('my-tools-website');
        });
    });
});
