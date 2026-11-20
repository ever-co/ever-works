/**
 * The sandbox seeder's domain modules pull the whole agent graph (and better-auth's ESM
 * through `OrganizationsModule`). This spec is about the demo's own providers, so they stand
 * in as empty modules and the seeder is overridden below. `demo.module.wiring.spec.ts`
 * resolves the seeder against the real modules; `demo-sandbox-seeder.spec.ts` drives the
 * real services.
 */
jest.mock('../../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));
jest.mock('@ever-works/agent/agents', () => ({
    AgentsModule: class AgentsModule {},
    OnboardingRoleSeedingService: class OnboardingRoleSeedingService {},
}));
jest.mock('@ever-works/agent/teams', () => ({
    AgentTeamsModule: class AgentTeamsModule {},
    TeamsService: class TeamsService {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkModule: class WorkModule {},
    KnowledgeBaseModule: class KnowledgeBaseModule {},
    WorkLifecycleService: class WorkLifecycleService {},
    KnowledgeBaseService: class KnowledgeBaseService {},
    AnonymousUserCleanupService: class AnonymousUserCleanupService {},
}));
jest.mock('@ever-works/agent/missions', () => ({
    MissionsModule: class MissionsModule {},
    MissionsService: class MissionsService {},
}));
jest.mock('@ever-works/agent/goals', () => ({
    GoalsModule: class GoalsModule {},
    GoalsService: class GoalsService {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksDomainModule: class TasksDomainModule {},
    TasksService: class TasksService {},
    TaskChatService: class TaskChatService {},
}));

import {
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    Injectable,
    Module,
    Optional,
    Patch,
    Post,
    type INestApplication,
    type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
    DatabaseModule,
    DemoGithubRepoRepository,
    DemoUsageCounterRepository,
    ENTITIES,
    UserRepository,
} from '@ever-works/agent/database';
import { CacheEntry, DemoGithubRepo, DemoUsageCounter, User } from '@ever-works/agent/entities';
import {
    DEMO_AI_QUOTA,
    DEMO_REPO_LEDGER,
    type DemoAiQuotaPort,
    type DemoRepoLedgerPort,
} from '@ever-works/agent/demo';
import { DemoModule } from '../demo.module';
import { DemoSandboxSeederService } from '../seed/demo-sandbox-seeder.service';
import { DemoAiQuotaService } from '../demo-ai-quota.service';
import { DemoController } from '../demo.controller';
import { DemoErrorFilter } from '../demo-error.filter';
import { DemoRestrictionsGuard } from '../demo-restrictions.guard';
import { DemoRepoLedgerService } from '../demo-repo-ledger.service';
import { DemoSandboxPurgeService } from '../demo-sandbox-purge.service';
import { DemoSandboxSweeperService } from '../demo-sandbox-sweeper.service';

/**
 * Platform demo mode — `DemoModule.register()` against a REAL Nest container.
 *
 * On a demo instance the AI facade refuses every call unless `DEMO_AI_QUOTA`
 * is bound (ruling R10), and the facade is constructed in modules that import
 * nothing from the demo. So the binding must be GLOBAL: a consumer in an
 * unrelated module, injecting the token exactly as `AiFacadeService` does,
 * has to receive the DB-backed service. With `DEMO` off the module is empty.
 */

/** Injects the token the way `AiFacadeService` and `PluginValidationService` do. */
@Injectable()
class QuotaConsumer {
    constructor(@Optional() @Inject(DEMO_AI_QUOTA) readonly quota?: DemoAiQuotaPort) {}
}

/**
 * Injects the ledger the way `EverWorksGitProvider` (agent `WorkModule`) and
 * `GitFacadeService` (agent `FacadesModule`) do: from modules that import nothing from the demo.
 */
@Injectable()
class LedgerConsumer {
    constructor(@Optional() @Inject(DEMO_REPO_LEDGER) readonly ledger?: DemoRepoLedgerPort) {}
}

/** A module that imports nothing from the demo, like the agent `FacadesModule`. */
@Module({ providers: [QuotaConsumer, LedgerConsumer] })
class UnrelatedModule {}

/** `DatabaseModule`, reduced to the repositories the demo's own providers read, on in-memory SQLite. */
@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        }),
        TypeOrmModule.forFeature([DemoUsageCounter, User, DemoGithubRepo, CacheEntry]),
    ],
    providers: [DemoUsageCounterRepository, UserRepository, DemoGithubRepoRepository],
    exports: [TypeOrmModule, DemoUsageCounterRepository, UserRepository, DemoGithubRepoRepository],
})
class InMemoryDatabaseModule {}

/**
 * Stand-ins at the real paths of the routes rulings R37 and R38 block: they only answer, so a
 * request that reaches one went through every global guard. `demo-restrictions.routes.spec.ts`
 * pins the paths against the real controllers.
 */
@Controller('api/works/:workId/invitations')
class WorkInvitationsStandIn {
    @Post()
    create() {
        return { invited: true };
    }
}

@Controller('api/organizations/:orgId/shared-view')
class SharedViewStandIn {
    @Get()
    read() {
        return { exists: true };
    }

    @Post()
    enable() {
        return { status: 'active' };
    }

    @Post('regenerate')
    @HttpCode(200)
    regenerate() {
        return { rotated: true };
    }

    @Patch()
    update() {
        return { updated: true };
    }

    @Delete()
    @HttpCode(204)
    remove() {
        return undefined;
    }
}

@Module({ controllers: [WorkInvitationsStandIn, SharedViewStandIn] })
class TransferAndShareRoutesModule {}

const ENV_KEYS = [
    'DEMO',
    'DEMO_GITHUB_ORG',
    'STORAGE_EVER_WORKS_GIT_ENABLED',
    'EVER_WORKS_CUSTOMERS_GITHUB_ORG',
    'EVER_WORKS_PROJECT_WORKS_ENABLED',
];

describe('DemoModule', () => {
    const saved: Record<string, string | undefined> = {};
    let moduleRef: TestingModule | undefined;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(async () => {
        await moduleRef?.close();
        moduleRef = undefined;
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    async function compile(extra: Type[] = []): Promise<TestingModule> {
        moduleRef = await Test.createTestingModule({
            imports: [ScheduleModule.forRoot(), DemoModule.register(), UnrelatedModule, ...extra],
        })
            .overrideModule(DatabaseModule)
            .useModule(InMemoryDatabaseModule)
            .overrideProvider(DemoSandboxSeederService)
            .useValue({ seed: jest.fn() })
            // The purge drives the Work and anonymous-user services of the agent `WorkModule`
            // (stubbed above); `demo.module.wiring.spec.ts` resolves it against the real one.
            .overrideProvider(DemoSandboxPurgeService)
            .useValue({ purge: jest.fn(), generationsInFlight: jest.fn() })
            .compile();
        return moduleRef;
    }

    describe('with DEMO off', () => {
        it('registers nothing: no provider, no filter, not global', () => {
            const dynamic = DemoModule.register();

            expect(dynamic.module).toBe(DemoModule);
            expect(dynamic.providers ?? []).toEqual([]);
            expect(dynamic.imports ?? []).toEqual([]);
            expect(dynamic.exports ?? []).toEqual([]);
            expect(dynamic.controllers ?? []).toEqual([]);
            expect(dynamic.global).not.toBe(true);
        });

        it('leaves DEMO_AI_QUOTA unbound for every consumer', async () => {
            const ref = await compile();
            await ref.init();

            expect(ref.get(QuotaConsumer, { strict: false }).quota).toBeUndefined();
        });

        it('leaves DEMO_REPO_LEDGER unbound for every consumer', async () => {
            const ref = await compile();
            await ref.init();

            expect(ref.get(LedgerConsumer, { strict: false }).ledger).toBeUndefined();
        });

        it('registers no sweeper and no cron job', async () => {
            const ref = await compile();
            await ref.init();

            expect(DemoModule.register().providers ?? []).not.toContain(DemoSandboxSweeperService);
            expect(ref.get(SchedulerRegistry).getCronJobs().size).toBe(0);
            expect(() => ref.get(DemoSandboxSweeperService, { strict: false })).toThrow();
        });
    });

    describe('with DEMO on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
            // The boot check requires Project Works on a demo instance (sandbox seed).
            process.env.EVER_WORKS_PROJECT_WORKS_ENABLED = 'true';
        });

        it('binds DEMO_AI_QUOTA globally to the DB-backed service', async () => {
            const ref = await compile();
            await ref.init();

            const service = ref.get(DemoAiQuotaService, { strict: false });
            expect(service).toBeInstanceOf(DemoAiQuotaService);
            expect(ref.get(DEMO_AI_QUOTA, { strict: false })).toBe(service);
            // A module that imports nothing from the demo still receives it.
            expect(ref.get(QuotaConsumer, { strict: false }).quota).toBe(service);
        });

        it('counts a call in the real usage-counter table', async () => {
            const ref = await compile();
            await ref.init();
            const users = ref.get<Repository<User>>(getRepositoryToken(User), { strict: false });
            const sandbox = await users.save(
                users.create({
                    username: 'demo-0a1b2c3d',
                    slug: 'demo-0a1b2c3d',
                    isAnonymous: true,
                    registrationProvider: 'demo',
                    anonymousExpiresAt: new Date('2026-11-21T08:00:00.000Z'),
                } as Partial<User>),
            );

            await ref
                .get(DemoAiQuotaService, { strict: false })
                .consume(sandbox.id, new Date('2026-11-20T08:30:10.000Z'));

            const rows = await ref
                .get<Repository<DemoUsageCounter>>(getRepositoryToken(DemoUsageCounter), {
                    strict: false,
                })
                .find({ order: { key: 'ASC' } });
            expect(rows.map((row) => [row.key, row.count])).toEqual([
                ['ai:day:2026-11-20', 1],
                ['ai:min:2026-11-20T08:30', 1],
                [`ai:sandbox:${sandbox.id}`, 1],
            ]);
        });

        it('binds DEMO_REPO_LEDGER globally to the DB-backed ledger (ruling R22)', async () => {
            const ref = await compile();
            await ref.init();

            const service = ref.get(DemoRepoLedgerService, { strict: false });
            expect(service).toBeInstanceOf(DemoRepoLedgerService);
            expect(ref.get(DEMO_REPO_LEDGER, { strict: false })).toBe(service);
            // A module that imports nothing from the demo still receives it.
            expect(ref.get(LedgerConsumer, { strict: false }).ledger).toBe(service);
        });

        it('records a repository in the real demo_github_repos table', async () => {
            const ref = await compile();
            await ref.init();

            await ref.get(LedgerConsumer, { strict: false }).ledger!.record({
                sandboxUserId: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
                owner: 'ever-works-cloud',
                name: 'demo-0a1b2c3d-awesome-ai-coding-tools',
                githubId: 812345678,
            });

            const rows = await ref
                .get<Repository<DemoGithubRepo>>(getRepositoryToken(DemoGithubRepo), {
                    strict: false,
                })
                .find();
            expect(rows).toEqual([
                expect.objectContaining({
                    sandboxUserId: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
                    owner: 'ever-works-cloud',
                    name: 'demo-0a1b2c3d-awesome-ai-coding-tools',
                    githubId: 812345678,
                    deletedAt: null,
                    attempts: 0,
                }),
            ]);
        });

        it('schedules the sweeper every 15 minutes', async () => {
            const ref = await compile();
            await ref.init();

            expect(ref.get(DemoSandboxSweeperService, { strict: false })).toBeInstanceOf(
                DemoSandboxSweeperService,
            );
            const job = ref.get(SchedulerRegistry).getCronJob('demo-sandbox-sweeper');
            expect(String(job.cronTime.source)).toBe('*/15 * * * *');
            expect(ref.get(SchedulerRegistry).getCronJobs().size).toBe(1);
        });

        it('registers DemoErrorFilter as a global filter', () => {
            const providers = DemoModule.register().providers ?? [];

            expect(providers).toContainEqual({ provide: APP_FILTER, useClass: DemoErrorFilter });
        });

        it('registers DemoRestrictionsGuard as a global guard', () => {
            const providers = DemoModule.register().providers ?? [];

            expect(providers).toContainEqual({
                provide: APP_GUARD,
                useClass: DemoRestrictionsGuard,
            });
        });

        it('registers the POST /api/auth/demo controller', () => {
            expect(DemoModule.register().controllers).toEqual([DemoController]);
        });

        it('refuses to start when the demo org does not match the git org', async () => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
            process.env.DEMO_GITHUB_ORG = 'ever-works-demo';
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = 'ever-works-cloud';
            const ref = await compile();

            await expect(ref.init()).rejects.toThrow(/DEMO_GITHUB_ORG/);
            // `close()` awaits the failed initialisation and rethrows it; that is expected here.
            moduleRef = undefined;
            await ref.close().catch(() => undefined);
        });
    });

    /**
     * Rulings R37 (no Work ownership transfer) and R38 (no public share link) end to end over
     * HTTP: the module's real global guard and filter in front of stand-ins at the real paths.
     * As in the API, the caller is on the request before any global guard runs (here a
     * middleware stands in for `AuthSessionGuard`).
     */
    describe('over HTTP, the routes R37 and R38 block', () => {
        const DEMO_ID = '00000000-0000-4000-8000-0000000000d1';
        const OPERATOR_ID = '00000000-0000-4000-8000-0000000000a1';
        const BLOCKED = [
            {
                method: 'post',
                path: '/api/works/w-1/invitations',
                body: { role: 'owner-claim', metadata: { expectedProviderUsername: 'someone' } },
                status: 201,
                feature: 'Work invitations and transfer',
            },
            {
                method: 'post',
                path: '/api/organizations/o-1/shared-view',
                body: {},
                status: 201,
                feature: 'public share link',
            },
            {
                method: 'post',
                path: '/api/organizations/o-1/shared-view/regenerate',
                body: {},
                status: 200,
                feature: 'public share link',
            },
            {
                method: 'patch',
                path: '/api/organizations/o-1/shared-view',
                body: { status: 'active', searchIndexable: true },
                status: 200,
                feature: 'public share link',
            },
        ];
        const STAYS_OPEN = [
            {
                method: 'patch',
                path: '/api/organizations/o-1/shared-view',
                body: { status: 'paused' },
                status: 200,
            },
            {
                method: 'delete',
                path: '/api/organizations/o-1/shared-view',
                body: undefined,
                status: 204,
            },
            {
                method: 'get',
                path: '/api/organizations/o-1/shared-view',
                body: undefined,
                status: 200,
            },
        ];
        let app: INestApplication | undefined;

        afterEach(async () => {
            await app?.close();
            app = undefined;
        });

        async function serve(): Promise<INestApplication> {
            const ref = await compile([TransferAndShareRoutesModule]);
            moduleRef = undefined; // the application closes it
            app = ref.createNestApplication();
            app.use(
                (
                    req: { headers: Record<string, unknown>; user?: unknown },
                    _res: unknown,
                    next: () => void,
                ) => {
                    const userId = req.headers['x-test-user'];
                    if (typeof userId === 'string') req.user = { userId };
                    next();
                },
            );
            await app.init();
            return app;
        }

        function send(
            server: INestApplication,
            call: { method: string; path: string; body?: unknown },
            userId: string,
        ): request.Test {
            const agent = request(server.getHttpServer()) as unknown as Record<
                string,
                (path: string) => request.Test
            >;
            const pending = agent[call.method](call.path).set('x-test-user', userId);
            return call.body === undefined ? pending : pending.send(call.body as object);
        }

        async function seedAccounts(server: INestApplication): Promise<void> {
            const users = server.get<Repository<User>>(getRepositoryToken(User));
            await users.save(
                users.create({
                    id: DEMO_ID,
                    username: 'demo-0a1b2c3d',
                    registrationProvider: 'demo',
                    isAnonymous: true,
                }),
            );
            await users.save(
                users.create({
                    id: OPERATOR_ID,
                    username: 'operator',
                    registrationProvider: 'local',
                }),
            );
        }

        function demoOn(): void {
            process.env.DEMO = 'true';
            process.env.EVER_WORKS_PROJECT_WORKS_ENABLED = 'true';
        }

        it('with DEMO on, a demo sandbox gets 403 DEMO_DISABLED, and can still turn sharing off', async () => {
            demoOn();
            const server = await serve();
            await seedAccounts(server);

            for (const call of BLOCKED) {
                const response = await send(server, call, DEMO_ID);
                expect([call.method, call.path, response.status, response.body]).toEqual([
                    call.method,
                    call.path,
                    403,
                    {
                        statusCode: 403,
                        code: 'DEMO_DISABLED',
                        message: `Not available in the demo: ${call.feature}`,
                    },
                ]);
            }
            for (const call of STAYS_OPEN) {
                const response = await send(server, call, DEMO_ID);
                expect([call.method, call.path, response.status]).toEqual([
                    call.method,
                    call.path,
                    call.status,
                ]);
            }
        });

        it("with DEMO on, an operator's identical requests reach the routes unchanged", async () => {
            demoOn();
            const server = await serve();
            await seedAccounts(server);

            for (const call of [...BLOCKED, ...STAYS_OPEN]) {
                const response = await send(server, call, OPERATOR_ID);
                expect([call.method, call.path, response.status]).toEqual([
                    call.method,
                    call.path,
                    call.status,
                ]);
            }
        });

        it('with DEMO off, the same requests from the same sandbox account reach the routes unchanged', async () => {
            const server = await serve();

            for (const call of [...BLOCKED, ...STAYS_OPEN]) {
                const response = await send(server, call, DEMO_ID);
                expect([call.method, call.path, response.status]).toEqual([
                    call.method,
                    call.path,
                    call.status,
                ]);
            }
        });
    });
});
