/**
 * Under api Jest the agent's `@src/notifications` imports (reached through the missions
 * barrel) resolve to the API's notifications files, whose `AuthModule` loads better-auth's
 * ESM through this one file. Nothing here builds an auth runtime.
 */
jest.mock('../../auth/providers/auth-runtime.instance', () => ({
    createAuthRuntimeInstance: jest.fn(),
}));
/** The purge removes the sandbox's uploaded files through the API's storage backend. */
const deleteAllByOwner = jest.fn(async () => ({ deleted: 0 }));
jest.mock('../../uploads/storage-backend.factory', () => ({
    getActiveStorageBackend: jest.fn(async () => ({ deleteAllByOwner })),
}));

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import {
    AgentBudgetRepository,
    AgentMembershipRepository,
    AgentRepository,
    DatabaseModule,
    DemoGithubRepoRepository,
    DemoUsageCounterRepository,
    UserRepository,
    WorkKnowledgeCitationRepository,
    WorkKnowledgeDocumentRepository,
    WorkKnowledgeTagRepository,
    WorkKnowledgeUploadRepository,
} from '@ever-works/agent/database';
import {
    Agent,
    AuthSession,
    Organization,
    OrganizationMember,
    Tenant,
    User,
} from '@ever-works/agent/entities';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    AgentFileService,
    AgentTemplatesService,
    AgentsService,
    OnboardingRoleSeedingService,
} from '@ever-works/agent/agents';
import { DomainEventsModule } from '@ever-works/agent/domain-events';
import { EverWorksGitProvider } from '@ever-works/agent/ever-works-providers';
import { AiFacadeService, GitFacadeService } from '@ever-works/agent/facades';
import { GoalsService } from '@ever-works/agent/goals';
import { MissionsService } from '@ever-works/agent/missions';
import { NotificationService } from '@ever-works/agent/notifications';
import { RecordAccessPolicy, RecordVisibilityService } from '@ever-works/agent/record-visibility';
import {
    AnonymousUserCleanupService,
    KnowledgeBaseService,
    WorkLifecycleService,
    WorkOwnershipService,
} from '@ever-works/agent/services';
import {
    TaskApproverRepository,
    TaskAssigneeRepository,
    TaskBlockRepository,
    TaskChatMessageRepository,
    TaskChatService,
    TaskKbMentionRepository,
    TaskNotificationService,
    TaskRelationRepository,
    TaskRepository,
    TaskReviewerRepository,
    TasksService,
    TaskTransitionService,
    TaskWatcherRepository,
    UserTaskCounterRepository,
} from '@ever-works/agent/tasks-domain';
import { TeamsService } from '@ever-works/agent/teams';
import { TemplateCatalogService } from '@ever-works/agent/template-catalog';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
// Not exported by a barrel: MissionsModule provides it to itself.
import { MissionWorkRepository } from '../../../../../packages/agent/src/database/repositories/mission-work.repository';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';
import { OrganizationService } from '../../organizations/organization.service';
import { ScopeContextService } from '../../scope/scope-context.service';
import { ScopeStampingSubscriber } from '../../scope/scope-stamping.subscriber';
import { TenantBootstrapService } from '../../scope/tenant-bootstrap.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';
import { DemoSandboxPurgeService } from '../demo-sandbox-purge.service';
import { DemoSandboxSweeperService } from '../demo-sandbox-sweeper.service';
import {
    DemoSandboxSeederService,
    type DemoSeedSummary,
} from '../seed/demo-sandbox-seeder.service';

/**
 * Platform demo mode — an expired sandbox leaves NOTHING behind (design §5.2.5 step 2).
 *
 * Two sandboxes are seeded by the real `DemoSandboxSeederService` (real domain services on
 * in-memory SQLite, the schema the demo runs on): Organization + Tenant, Teams, Agents,
 * Works, Missions, Goals with their log, Tasks with their threads and history, knowledge
 * notes, the recorded agent runs + logs, the Agent chat (conversation, messages,
 * participants), activity entries and domain events, plus a session each. One expires and
 * the sweeper runs. Afterwards every table of the schema holds exactly the rows it held
 * before the expired sandbox was seeded: zero rows carry its tenant, organization or user
 * id, and the other sandbox's rows are all still there.
 *
 * What seeding must never reach (AI, git facade, Ever Works Git) is a refusing double; the
 * generation / deploy / DNS collaborators the Work services require are inert doubles.
 */

const LIFECYCLE_HOOKS = new Set([
    'onModuleInit',
    'onApplicationBootstrap',
    'onModuleDestroy',
    'beforeApplicationShutdown',
    'onApplicationShutdown',
]);

/** Every method of `type` as a refusing spy. */
function refusing<T>(type: abstract new (...args: never[]) => T): T {
    const double = Object.create(type.prototype) as Record<string, unknown>;
    for (let proto = type.prototype; proto && proto !== Object.prototype; ) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor' || LIFECYCLE_HOOKS.has(name)) continue;
            if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value !== 'function') continue;
            double[name] = jest.fn(() => {
                throw new Error(`${type.name}.${name} called`);
            });
        }
        proto = Object.getPrototypeOf(proto);
    }
    return double as T;
}

const INERT_COLLABORATORS = new Set([
    'DataGeneratorService',
    'MarkdownGeneratorService',
    'WebsiteGeneratorService',
    'WebsiteUpdateService',
    'DeployFacadeService',
    'WorkWebsiteRepositoryStateService',
    'EverWorksDeployQuotaService',
    'EverWorksDnsService',
    'ZeroFrictionFunnelService',
    'TitlerService',
    'GoalEvaluationService',
]);

/** Answers every method with `undefined` (never thenable, no lifecycle hooks). */
function inert(): object {
    return new Proxy(
        {},
        {
            get: (_target, prop) =>
                typeof prop === 'symbol' || prop === 'then' || LIFECYCLE_HOOKS.has(prop)
                    ? undefined
                    : () => undefined,
        },
    );
}

/** The ledger is the record of what was deleted; it outlives the sandbox by design. */
const KEPT_TABLES = new Set(['demo_github_repos']);

const PROJECT_WORKS_ENV = 'EVER_WORKS_PROJECT_WORKS_ENABLED';

type Snapshot = Map<string, Set<string>>;

describe('Demo sandbox purge (real seeded sandbox)', () => {
    const ORIGINAL_ENV = { ...process.env };
    let moduleRef: TestingModule;
    let dataSource: DataSource;
    let users: UserRepository;
    let seeder: DemoSandboxSeederService;
    let sweeper: DemoSandboxSweeperService;
    const git = { getRepositoryId: jest.fn(async () => null), deleteRepository: jest.fn() };

    beforeAll(async () => {
        process.env[PROJECT_WORKS_ENV] = 'true';
        process.env.DEMO = 'true';
        process.env.DEMO_GITHUB_ORG = 'ever-works-cloud';

        moduleRef = await Test.createTestingModule({
            // NODE_ENV=test: the real DatabaseModule opens in-memory SQLite and synchronizes.
            imports: [DatabaseModule, DomainEventsModule, EventEmitterModule.forRoot()],
            providers: [
                ScopeContextService,
                ScopeStampingSubscriber,
                UsernameAllocatorService,
                TenantBootstrapService,
                OrganizationService,
                OrganizationMembershipService,
                ActivityLogService,
                RecordAccessPolicy,
                RecordVisibilityService,
                TeamsService,
                AgentRepository,
                AgentMembershipRepository,
                AgentBudgetRepository,
                AgentsService,
                AgentFileService,
                AgentTemplatesService,
                OnboardingRoleSeedingService,
                TemplateCatalogService,
                WorkOwnershipService,
                WorkLifecycleService,
                MissionWorkRepository,
                MissionsService,
                GoalsService,
                TaskRepository,
                TaskAssigneeRepository,
                TaskReviewerRepository,
                TaskApproverRepository,
                TaskBlockRepository,
                TaskRelationRepository,
                UserTaskCounterRepository,
                TaskChatMessageRepository,
                TaskKbMentionRepository,
                TaskWatcherRepository,
                NotificationService,
                TaskNotificationService,
                TaskTransitionService,
                TasksService,
                TaskChatService,
                WorkKnowledgeDocumentRepository,
                WorkKnowledgeUploadRepository,
                WorkKnowledgeTagRepository,
                WorkKnowledgeCitationRepository,
                KnowledgeBaseService,
                { provide: AiFacadeService, useValue: refusing(AiFacadeService) },
                { provide: GitFacadeService, useValue: refusing(GitFacadeService) },
                { provide: EverWorksGitProvider, useValue: refusing(EverWorksGitProvider) },
                DemoSandboxSeederService,
                // The purge path: the Work delete path, the anonymous-user purge, the purge.
                AnonymousUserCleanupService,
                DemoSandboxPurgeService,
                DistributedTaskLockService,
            ],
        })
            .useMocker((token) => {
                const name = typeof token === 'function' ? token.name : String(token);
                return INERT_COLLABORATORS.has(name) ? inert() : undefined;
            })
            .compile();
        await moduleRef.init();

        dataSource = moduleRef.get(DataSource);
        users = moduleRef.get(UserRepository);
        seeder = moduleRef.get(DemoSandboxSeederService);
        sweeper = new DemoSandboxSweeperService(
            users,
            moduleRef.get(DemoGithubRepoRepository),
            git as unknown as EverWorksGitProvider,
            moduleRef.get(DemoSandboxPurgeService),
            moduleRef.get(DistributedTaskLockService),
            moduleRef.get(DemoUsageCounterRepository),
        );
    });

    afterAll(async () => {
        await moduleRef?.close();
        process.env = { ...ORIGINAL_ENV };
    });

    /** A demo user and its session, exactly as `DemoSandboxService.createSandbox` makes them. */
    async function createSandbox(): Promise<{ user: User; seed: DemoSeedSummary }> {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 3_600_000);
        const user = await users.create({
            username: `demo-${randomBytes(4).toString('hex')}`,
            displayName: 'Demo User',
            email: null,
            password: null,
            isAnonymous: true,
            anonymousExpiresAt: expiresAt,
            registrationProvider: 'demo',
            emailVerified: false,
            isActive: true,
            onboardingCompletedAt: now,
            onboardingState: {
                ...ONBOARDING_DEFAULT_STATE,
                storage: { choice: 'ever-works-git' },
                deploy: { choice: 'ever-works' },
            },
        });
        await dataSource.getRepository(AuthSession).save({
            id: randomUUID(),
            userId: user.id,
            token: null,
            tokenHash: randomBytes(16).toString('hex'),
            expiresAt,
        });
        const seed = await seeder.seed(user);
        return { user: (await users.findById(user.id)) as User, seed };
    }

    /** Every row of every table, by primary key. */
    async function snapshot(): Promise<Snapshot> {
        const tables: Snapshot = new Map();
        for (const meta of dataSource.entityMetadatas) {
            if (meta.tableType === 'view' || KEPT_TABLES.has(meta.tableName)) continue;
            const keys = meta.primaryColumns.map((column) => column.databaseName);
            if (keys.length === 0) continue;
            const rows: Array<Record<string, unknown>> = await dataSource.query(
                `SELECT ${keys.map((key) => `"${key}"`).join(', ')} FROM "${meta.tableName}"`,
            );
            tables.set(
                meta.tableName,
                new Set(rows.map((row) => JSON.stringify(keys.map((key) => row[key])))),
            );
        }
        return tables;
    }

    /** Rows of each table that carry the sandbox's tenant, organization or user id. */
    async function sandboxRows(
        user: User,
        tenantId: string,
        organizationId: string,
    ): Promise<Record<string, number>> {
        const counts: Record<string, number> = {};
        for (const meta of dataSource.entityMetadatas) {
            if (meta.tableType === 'view' || KEPT_TABLES.has(meta.tableName)) continue;
            const columns = new Set(meta.columns.map((column) => column.databaseName));
            const where: string[] = [];
            const params: string[] = [];
            for (const [column, value] of [
                ['tenantId', tenantId],
                ['organizationId', organizationId],
                ['userId', user.id],
            ] as const) {
                if (columns.has(column)) {
                    where.push(`"${column}" = ?`);
                    params.push(value);
                }
            }
            if (meta.tableName === 'users') {
                where.push('"id" = ?');
                params.push(user.id);
            }
            if (meta.tableName === 'tenants') {
                where.push('"id" = ?');
                params.push(tenantId);
            }
            if (meta.tableName === 'organizations') {
                where.push('"id" = ?');
                params.push(organizationId);
            }
            if (where.length === 0) continue;
            const [{ count }] = await dataSource.query(
                `SELECT COUNT(*) AS count FROM "${meta.tableName}" WHERE ${where.join(' OR ')}`,
                params,
            );
            if (Number(count) > 0) counts[meta.tableName] = Number(count);
        }
        return counts;
    }

    it('removes every row of the expired sandbox and none of the other one', async () => {
        const kept = await createSandbox();
        const before = await snapshot();
        const expired = await createSandbox();
        const tenantId = expired.user.tenantId as string;
        const organizationId = expired.seed.organizationId;
        expect(tenantId).toBeTruthy();
        expect(tenantId).not.toBe(kept.user.tenantId);

        // Positive control: the seed really wrote the sandbox into each of these tables, so
        // "none left" below is about rows that existed.
        const seeded = await sandboxRows(expired.user, tenantId, organizationId);
        for (const table of [
            'users',
            'tenants',
            'organizations',
            'session',
            'works',
            'teams',
            'team_members',
            'agents',
            'missions',
            'mission_works',
            'mission_goals',
            'goals',
            'goal_events',
            'tasks',
            'task_chat_messages',
            'work_knowledge_documents',
            'agent_runs',
            'agent_run_logs',
            'conversations',
            'conversation_messages',
            'conversation_participants',
            'activity_log',
            'domain_events',
        ]) {
            expect([table, (seeded[table] ?? 0) > 0]).toEqual([table, true]);
        }

        await users.update(expired.user.id, { anonymousExpiresAt: new Date(Date.now() - 1_000) });
        const summary = await sweeper.sweep(new Date());

        expect(summary).toEqual({ sandboxes: 1, reposDeleted: 0, reposSkipped: 0, failures: 0 });
        expect(await sandboxRows(expired.user, tenantId, organizationId)).toEqual({});

        // Every table holds exactly what it held before the expired sandbox was seeded: the
        // other sandbox is untouched, and nothing of the expired one is left anywhere, not
        // even in a table that has no tenant, organization or user column.
        const after = await snapshot();
        const differences: string[] = [];
        for (const [table, rows] of after) {
            const previous = before.get(table) ?? new Set<string>();
            const added = [...rows].filter((row) => !previous.has(row));
            const removed = [...previous].filter((row) => !rows.has(row));
            if (added.length > 0) differences.push(`${table}: ${added.length} row(s) left behind`);
            if (removed.length > 0)
                differences.push(`${table}: ${removed.length} row(s) of the other sandbox removed`);
        }
        expect(differences).toEqual([]);
        expect(await users.findById(kept.user.id)).toMatchObject({ id: kept.user.id });
        expect(deleteAllByOwner).toHaveBeenCalledWith(expired.user.id);
        expect(deleteAllByOwner).not.toHaveBeenCalledWith(kept.user.id);
        expect(git.deleteRepository).not.toHaveBeenCalled();
    });

    /**
     * R42 c: the second sole-member check runs right before the row sweep. A member who joined
     * while the sandbox's Works and files were being removed is seen before step 3 could delete
     * their `organization_members` row (which carries the sandbox's Organization and Tenant), and
     * the purge refuses with the workspace and that member intact, for an operator.
     */
    it('refuses, keeping the workspace and the member, when someone joins after the first check', async () => {
        const { user, seed } = await createSandbox();
        const tenantId = user.tenantId as string;
        const suffix = randomBytes(4).toString('hex');
        const operator = await users.create({
            username: `operator-${suffix}`,
            displayName: 'Operator',
            email: `operator-${suffix}@example.test`,
            password: null,
            isAnonymous: false,
            registrationProvider: 'local',
            emailVerified: true,
            isActive: true,
        });
        // Step 2 (the sandbox's files) runs after the first check and before the row sweep. The
        // purge swallows a failure there, so the join's own outcome is kept to assert on.
        let joined: unknown = 'not attempted';
        deleteAllByOwner.mockImplementationOnce(async () => {
            try {
                await dataSource.getRepository(OrganizationMember).insert({
                    organizationId: seed.organizationId,
                    tenantId,
                    userId: operator.id,
                    role: 'member',
                    joinedAt: new Date(),
                });
                joined = true;
            } catch (error) {
                joined = error;
            }
            return { deleted: 0 };
        });

        const outcome = await moduleRef
            .get(DemoSandboxPurgeService)
            .purge(user)
            .then(
                (summary) => summary,
                (error: unknown) => error,
            );

        expect(joined).toBe(true);
        expect(outcome).toEqual(
            new Error(`Sandbox ${user.id}'s workspace has another member; left for an operator`),
        );
        expect(deleteAllByOwner).toHaveBeenCalledWith(user.id);
        expect(
            await dataSource
                .getRepository(OrganizationMember)
                .countBy({ organizationId: seed.organizationId, userId: operator.id }),
        ).toBe(1);
        expect(
            await dataSource.getRepository(Organization).countBy({ id: seed.organizationId }),
        ).toBe(1);
        expect(await dataSource.getRepository(Tenant).countBy({ id: tenantId })).toBe(1);
        expect(await users.findById(user.id)).toMatchObject({ id: user.id });
        // The rows step 3 would have swept are still there (the seeded Agents, for one).
        expect(await dataSource.getRepository(Agent).countBy({ userId: user.id })).toBeGreaterThan(
            0,
        );
    });
});
