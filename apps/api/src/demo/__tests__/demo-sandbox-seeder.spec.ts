/**
 * Under api Jest the agent's `@src/notifications` imports (reached through the missions
 * barrel) resolve to the API's notifications files, whose `AuthModule` loads better-auth's
 * ESM through this one file. Nothing here builds an auth runtime.
 */
jest.mock('../../auth/providers/auth-runtime.instance', () => ({
    createAuthRuntimeInstance: jest.fn(),
}));

import { randomBytes } from 'node:crypto';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { Between, DataSource, In, IsNull } from 'typeorm';
import {
    AgentBudgetRepository,
    AgentMembershipRepository,
    AgentRepository,
    DatabaseModule,
    UserRepository,
    WorkKnowledgeCitationRepository,
    WorkKnowledgeDocumentRepository,
    WorkKnowledgeTagRepository,
    WorkKnowledgeUploadRepository,
} from '@ever-works/agent/database';
import {
    ActivityActionType,
    ActivityLog,
    Agent,
    AgentStatus,
    AgentRun,
    AgentRunLog,
    Conversation,
    ConversationMessage,
    ConversationParticipant,
    DomainEvent,
    Goal,
    GoalEvent,
    GoalMetricSample,
    GoalOutcome,
    GoalStatus,
    Mission,
    MissionGoal,
    MissionStatus,
    MissionType,
    MissionWork,
    Organization,
    Task,
    TaskChatMessage,
    TaskPriority,
    TaskStatus,
    Team,
    TeamMember,
    Tenant,
    User,
    Work,
    WorkKnowledgeDocument,
} from '@ever-works/agent/entities';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    AgentFileService,
    AgentRunRepository,
    AgentScheduleDispatcherService,
    AgentTemplatesService,
    AgentsService,
    OnboardingRoleSeedingService,
    QUEUED_REASON_CONCURRENCY,
} from '@ever-works/agent/agents';
import { config } from '@ever-works/agent/config';
import { ConversationRepository } from '@ever-works/agent/database';
import { DomainEventsModule } from '@ever-works/agent/domain-events';
import { EverWorksGitProvider } from '@ever-works/agent/ever-works-providers';
import { AiFacadeService, GitFacadeService } from '@ever-works/agent/facades';
import {
    GOAL_ITERATION_LABEL,
    GoalEvaluationService,
    GoalOrchestratorService,
    GoalsService,
} from '@ever-works/agent/goals';
import {
    MISSION_TASK_LABEL,
    MissionsService,
    MissionTickService,
} from '@ever-works/agent/missions';
import { NotificationService } from '@ever-works/agent/notifications';
import { RecordAccessPolicy, RecordVisibilityService } from '@ever-works/agent/record-visibility';
import {
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
import { loadDemoRecordedFixture } from '../seed/demo-recorded-seeder';
import {
    DemoSandboxSeederService,
    type DemoSeedSummary,
} from '../seed/demo-sandbox-seeder.service';

/**
 * Platform demo mode — the sandbox seeder (design §5.2.3), driven through the REAL domain
 * services on in-memory SQLite: Organization (with its lazy Tenant), Teams, the onboarding
 * starter kit, Works, Missions, Goals, Tasks with their threads, organization knowledge.
 *
 * Doubles stand in only for what seeding must never reach: the AI facade, the git facade and
 * Ever Works Git (every method refuses and is recorded), plus the generation / deploy / DNS /
 * titling / evaluation collaborators the services require but seeding does not use (recorded
 * too, so a call shows up as a failure rather than as a silent no-op).
 */

const LIFECYCLE_HOOKS = new Set([
    'onModuleInit',
    'onApplicationBootstrap',
    'onModuleDestroy',
    'beforeApplicationShutdown',
    'onApplicationShutdown',
]);

type MethodSpies = Record<string, jest.Mock>;

/** Every method of `type` as a refusing spy: a call is exactly the failure under test. */
function refusingSpies<T>(type: abstract new (...args: never[]) => T): {
    double: T;
    spies: MethodSpies;
} {
    const double = Object.create(type.prototype) as Record<string, unknown>;
    const spies: MethodSpies = {};
    for (let proto = type.prototype; proto && proto !== Object.prototype; ) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor' || LIFECYCLE_HOOKS.has(name) || spies[name]) continue;
            if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value !== 'function') continue;
            spies[name] = jest.fn(() => {
                throw new Error(`${type.name}.${name} called while seeding a demo sandbox`);
            });
            double[name] = spies[name];
        }
        proto = Object.getPrototypeOf(proto);
    }
    return { double: double as T, spies };
}

function calledMethods(spies: MethodSpies): string[] {
    return Object.entries(spies)
        .filter(([, spy]) => spy.mock.calls.length > 0)
        .map(([name]) => name);
}

/** Required collaborators seeding never uses: any call on them is recorded. */
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

function inertDouble(name: string, calls: string[]): object {
    const methods = new Map<string, jest.Mock>();
    return new Proxy(
        {},
        {
            get: (_target, prop) => {
                if (typeof prop === 'symbol' || prop === 'then' || LIFECYCLE_HOOKS.has(prop)) {
                    return undefined;
                }
                let method = methods.get(prop);
                if (!method) {
                    method = jest.fn(() => {
                        calls.push(`${name}.${prop}`);
                        return undefined;
                    });
                    methods.set(prop, method);
                }
                return method;
            },
        },
    );
}

const PROJECT_WORKS_ENV = 'EVER_WORKS_PROJECT_WORKS_ENABLED';

/** The only model id the recorded runs and chat replies name (design §5.2.3: a free model). */
const RECORDED_MODEL = 'google/gemma-4-31b-it:free';

const hasLabel = (task: Task, label: string): boolean => (task.labels ?? []).includes(label);

/** A Task the Task-6 fixture filed by hand: neither a Goal iteration nor a Mission's plan. */
const isHandFiled = (task: Task): boolean =>
    !hasLabel(task, GOAL_ITERATION_LABEL) && !hasLabel(task, MISSION_TASK_LABEL);

const MINUTE = 60_000;

describe('DemoSandboxSeederService', () => {
    let moduleRef: TestingModule;
    let dataSource: DataSource;
    let users: UserRepository;
    let seeder: DemoSandboxSeederService;
    let membership: OrganizationMembershipService;
    const ai = refusingSpies(AiFacadeService);
    const git = refusingSpies(GitFacadeService);
    const everWorksGit = refusingSpies(EverWorksGitProvider);
    const inertCalls: string[] = [];
    let savedProjectWorks: string | undefined;

    beforeAll(async () => {
        savedProjectWorks = process.env[PROJECT_WORKS_ENV];
        // The demo env turns Project Works on (design §5.2.3).
        process.env[PROJECT_WORKS_ENV] = 'true';

        moduleRef = await Test.createTestingModule({
            // NODE_ENV=test: the real DatabaseModule opens in-memory SQLite and synchronizes.
            imports: [DatabaseModule, DomainEventsModule, EventEmitterModule.forRoot()],
            providers: [
                // API side: the Organization create path and the ambient scope.
                ScopeContextService,
                ScopeStampingSubscriber,
                UsernameAllocatorService,
                TenantBootstrapService,
                OrganizationService,
                OrganizationMembershipService,
                // Agent side: the domain services the seeder drives, and theirs.
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
                // The in-app notification path a transition takes in production, so its
                // events (if any) are emitted here too.
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
                // What seeding must never reach. Provided outright, so optional injections
                // receive the spies too.
                { provide: AiFacadeService, useValue: ai.double },
                { provide: GitFacadeService, useValue: git.double },
                { provide: EverWorksGitProvider, useValue: everWorksGit.double },
                DemoSandboxSeederService,
            ],
        })
            .useMocker((token) => {
                const name = typeof token === 'function' ? token.name : String(token);
                // `undefined` leaves every other token unresolved: an optional one stays
                // absent, a required one fails the compile and names itself.
                return INERT_COLLABORATORS.has(name) ? inertDouble(name, inertCalls) : undefined;
            })
            .compile();
        await moduleRef.init();

        dataSource = moduleRef.get(DataSource);
        users = moduleRef.get(UserRepository);
        seeder = moduleRef.get(DemoSandboxSeederService);
        membership = moduleRef.get(OrganizationMembershipService);
    });

    afterAll(async () => {
        await moduleRef?.close();
        if (savedProjectWorks === undefined) delete process.env[PROJECT_WORKS_ENV];
        else process.env[PROJECT_WORKS_ENV] = savedProjectWorks;
    });

    /** A demo user exactly as `DemoSandboxService.createSandbox` makes one. */
    async function createDemoUser(): Promise<User> {
        const now = new Date();
        return users.create({
            username: `demo-${randomBytes(4).toString('hex')}`,
            displayName: 'Demo User',
            email: null,
            password: null,
            isAnonymous: true,
            anonymousExpiresAt: new Date(now.getTime() + 24 * 3_600_000),
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
    }

    /** One seeded sandbox: its user, what the seeder answered, and when the seed ran. */
    type Seeded = { user: User; summary: DemoSeedSummary; startedAt: Date; endedAt: Date };

    async function seedTimed(user: User): Promise<Seeded & { ms: number }> {
        const startedAt = new Date();
        const started = performance.now();
        const summary = await seeder.seed(user);
        const ms = performance.now() - started;
        return { user, summary, ms, startedAt, endedAt: new Date() };
    }

    const timings: number[] = [];
    /** Every in-process event emitted while the two sandboxes were seeded. */
    const emitted: string[] = [];
    let probeHeard = false;
    /** The outbox rows (`domain_events`) the first sandbox's seed wrote: what the relay publishes. */
    let firstDomainEvents: DomainEvent[];
    let first: Seeded;
    let second: Seeded;

    const lastOutboxSeq = async (): Promise<number> =>
        Number(
            (await rows(DomainEvent).find({ order: { outboxSeq: 'DESC' }, take: 1 }))[0]
                ?.outboxSeq ?? 0,
        );

    beforeAll(async () => {
        const record = (event: string | string[]) =>
            emitted.push(Array.isArray(event) ? event.join('.') : String(event));
        const emitter = moduleRef.get(EventEmitter2);
        emitter.onAny(record);
        // The recorder hears this module's emitter (the one the services were given).
        emitter.emit('demo-seeder-spec.probe');
        probeHeard = emitted.splice(0).includes('demo-seeder-spec.probe');

        const firstUser = await createDemoUser();
        const before = await lastOutboxSeq();
        const a = await seedTimed(firstUser);
        const after = await lastOutboxSeq();
        const secondUser = await createDemoUser();
        const b = await seedTimed(secondUser);
        // Fire-and-forget work a seed started (notifications, unblock cascades) lands too.
        await new Promise((resolve) => setImmediate(resolve));
        emitter.offAny(record);

        timings.push(a.ms, b.ms);
        first = a;
        second = b;
        firstDomainEvents = await rows(DomainEvent).find({
            where: { outboxSeq: Between(before + 1, after) },
            order: { outboxSeq: 'ASC' },
        });
    });

    const rows = <T extends object>(entity: new () => T) => dataSource.getRepository<T>(entity);

    /** What the recorded-examples seeder left in one sandbox, read back from the database. */
    async function recordedRows(sandbox: Seeded) {
        const userId = sandbox.user.id;
        const goal = await rows(Goal).findOneByOrFail({
            userId,
            title: 'Publish the launch blog post',
        });
        const mission = await rows(Mission).findOneByOrFail({
            userId,
            title: 'Ship the launch site',
        });
        const tasks = await rows(Task).find({ where: { userId }, order: { title: 'ASC' } });
        const runs = await rows(AgentRun).find({ where: { userId }, order: { startedAt: 'ASC' } });
        const runIds = runs.map((run) => run.id);
        const logs =
            runIds.length > 0
                ? await rows(AgentRunLog).find({
                      where: { runId: In(runIds) },
                      order: { createdAt: 'ASC' },
                  })
                : [];
        const conversations = await rows(Conversation).findBy({ userId });
        const conversationIds = conversations.map((conversation) => conversation.id);
        const messages =
            conversationIds.length > 0
                ? await rows(ConversationMessage).find({
                      where: { conversationId: In(conversationIds) },
                      order: { createdAt: 'ASC' },
                  })
                : [];
        const participants =
            conversationIds.length > 0
                ? await rows(ConversationParticipant).findBy({
                      conversationId: In(conversationIds),
                  })
                : [];
        // Recorded entries are dated minutes before the sandbox was created; every row a
        // domain service wrote while seeding is dated at or after it (to the second on SQLite).
        const activity = (await rows(ActivityLog).findBy({ userId })).filter(
            (entry) => entry.createdAt.getTime() < sandbox.startedAt.getTime() - MINUTE,
        );
        return {
            goal,
            mission,
            iterationTasks: tasks.filter(
                (task) => task.goalId === goal.id && hasLabel(task, GOAL_ITERATION_LABEL),
            ),
            planTasks: tasks.filter(
                (task) => task.missionId === mission.id && hasLabel(task, MISSION_TASK_LABEL),
            ),
            runs,
            logs,
            goalEvents: await rows(GoalEvent).find({
                where: { goalId: goal.id },
                order: { createdAt: 'ASC' },
            }),
            conversations,
            messages,
            participants,
            activity,
        };
    }

    describe('one sandbox', () => {
        it('creates one Organization the visitor administers, on its own Tenant, and lands on it', async () => {
            const user = await users.findById(first.user.id);
            expect(user?.tenantId).toBeTruthy();
            const tenant = await rows(Tenant).findOneByOrFail({ id: user!.tenantId! });
            expect(tenant.ownerUserId).toBe(first.user.id);

            const organizations = await rows(Organization).findBy({ tenantId: tenant.id });
            expect(organizations).toHaveLength(1);
            const [organization] = organizations;
            expect(organization.id).toBe(first.summary.organizationId);
            expect(organization.displayName).toBe('Acme Labs (Demo)');
            expect(organization.slug).toBe(`acme-labs-${first.user.username}`);
            expect(await membership.isRoleAdmin(organization.id, first.user.id)).toBe(true);
            expect(user?.lastScopeOrganizationId).toBe(organization.id);
        });

        it('creates the two Teams with their starter-kit agents on the roster', async () => {
            const teams = await rows(Team).find({
                where: { organizationId: first.summary.organizationId },
                order: { name: 'ASC' },
            });
            expect(teams.map((team) => team.name)).toEqual(['Growth', 'Product']);
            const members = await rows(TeamMember).findBy({ teamId: In(teams.map((t) => t.id)) });
            expect(members).toHaveLength(4);
            expect(members.every((member) => member.memberType === 'agent')).toBe(true);
        });

        it('activates at least four starter-kit agents, all in the Organization', async () => {
            const agents = await rows(Agent).findBy({ userId: first.user.id });
            expect(agents.length).toBeGreaterThanOrEqual(4);
            expect(agents.map((agent) => agent.name)).toEqual(
                expect.arrayContaining([
                    'Content Marketer',
                    'Social Scheduler',
                    'SEO Auditor',
                    'Competitive Analyst',
                ]),
            );
            for (const agent of agents) {
                expect(agent.organizationId).toBe(first.summary.organizationId);
                // R42 a: active, so "Run now" runs them; with no heartbeat, so nothing else does.
                expect([agent.name, agent.status]).toEqual([agent.name, AgentStatus.ACTIVE]);
                expect([agent.heartbeatCadence ?? null, agent.nextHeartbeatAt ?? null]).toEqual([
                    null,
                    null,
                ]);
            }
        });

        it('creates the Project Work and the draft directory Work, without a repository', async () => {
            const works = await rows(Work).find({
                where: { userId: first.user.id },
                order: { kind: 'ASC' },
            });
            // `default` is the directory kind `createDraftWork` gives every draft Work
            // (contracts `WORK_KINDS`: it behaves exactly like `directory`).
            expect(works.map((work) => work.kind)).toEqual(['default', 'project']);
            const [directory, project] = works;

            expect(project.id).toBe(first.summary.projectWorkId);
            expect(project.name).toBe('Launch the Acme website');
            expect(project.status).toBe('active');
            expect(project.sourceRepository ?? null).toBeNull();

            expect(directory.id).toBe(first.summary.directoryWorkId);
            expect(directory.name).toBe('Awesome AI Coding Tools');
            expect(directory.status).toBe('draft');
            expect(directory.sourceRepository ?? null).toBeNull();
            expect(directory.storageProvider).toBe('ever-works-git');
            expect(directory.description).toBe(
                'A curated directory of AI coding assistants, code-review bots and agentic IDEs, with pricing and open-source status',
            );

            const tenantId = (await users.findById(first.user.id))?.tenantId;
            for (const work of works) {
                expect(work.organizationId).toBe(first.summary.organizationId);
                expect(work.tenantId).toBe(tenantId);
            }
        });

        it('creates the two Missions, attached to the Project Work', async () => {
            const missions = await rows(Mission).find({
                where: { userId: first.user.id },
                order: { title: 'ASC' },
            });
            expect(missions.map((mission) => mission.title)).toEqual([
                'Grow newsletter signups',
                'Ship the launch site',
            ]);
            expect(missions.every((m) => m.organizationId === first.summary.organizationId)).toBe(
                true,
            );
            const links = await rows(MissionWork).findBy({
                missionId: In(missions.map((m) => m.id)),
            });
            expect(links).toHaveLength(2);
            expect(links.every((link) => link.workId === first.summary.projectWorkId)).toBe(true);
        });

        it('creates the three Goals in their states, linked to their Missions and the Work', async () => {
            const goals = await rows(Goal).findBy({ userId: first.user.id });
            const byTitle = new Map(goals.map((goal) => [goal.title, goal]));
            expect(goals).toHaveLength(3);
            expect(byTitle.get('Publish the launch blog post')?.status).toBe(GoalStatus.COMPLETED);
            expect(byTitle.get('Publish the launch blog post')?.outcome).toBe(GoalOutcome.ACHIEVED);
            expect(byTitle.get('Collect 100 newsletter signups')?.status).toBe(GoalStatus.ACTIVE);
            expect(byTitle.get('Add a pricing page')?.status).toBe(GoalStatus.DRAFT);
            for (const goal of goals) {
                expect(goal.workId).toBe(first.summary.projectWorkId);
                expect(goal.organizationId).toBe(first.summary.organizationId);
            }
            const links = await rows(MissionGoal).findBy({ goalId: In(goals.map((g) => g.id)) });
            expect(links).toHaveLength(3);
        });

        it('creates the eight hand-filed Tasks across the Goals, each with one or two comments', async () => {
            // The recorded examples add the Goal's iterations and the Mission's plan (below).
            const tasks = (await rows(Task).findBy({ userId: first.user.id })).filter(isHandFiled);
            expect(tasks).toHaveLength(8);
            const goals = await rows(Goal).findBy({ userId: first.user.id });
            const goalTitle = new Map(goals.map((goal) => [goal.id, goal.title]));
            const perGoal = new Map<string, number>();
            for (const task of tasks) {
                const title = goalTitle.get(task.goalId ?? '') ?? 'none';
                perGoal.set(title, (perGoal.get(title) ?? 0) + 1);
                expect(task.workId).toBe(first.summary.projectWorkId);
                expect(task.missionId).toBeTruthy();
                expect(task.organizationId).toBe(first.summary.organizationId);
            }
            expect(Object.fromEntries(perGoal)).toEqual({
                'Publish the launch blog post': 3,
                'Collect 100 newsletter signups': 3,
                'Add a pricing page': 2,
            });

            const statuses = tasks.map((task) => task.status).sort();
            expect(statuses).toEqual(
                [
                    TaskStatus.DONE,
                    TaskStatus.DONE,
                    TaskStatus.DONE,
                    TaskStatus.DONE,
                    TaskStatus.IN_PROGRESS,
                    TaskStatus.TODO,
                    TaskStatus.TODO,
                    TaskStatus.TODO,
                ].sort(),
            );
            for (const task of tasks.filter((t) => t.status === TaskStatus.DONE)) {
                expect(task.completedAt).toBeInstanceOf(Date);
            }

            const comments = await rows(TaskChatMessage).findBy({
                taskId: In(tasks.map((task) => task.id)),
            });
            for (const task of tasks) {
                const count = comments.filter((comment) => comment.taskId === task.id).length;
                expect(count).toBeGreaterThanOrEqual(1);
                expect(count).toBeLessThanOrEqual(2);
            }
        });

        it('records the Task history in the activity log', async () => {
            const created = await rows(ActivityLog).countBy({
                userId: first.user.id,
                actionType: ActivityActionType.TASK_CREATED,
            });
            const moved = await rows(ActivityLog).countBy({
                userId: first.user.id,
                actionType: ActivityActionType.TASK_TRANSITIONED,
            });
            // 8 hand-filed Tasks, 2 Goal iterations, 3 planned by the Mission.
            expect(created).toBe(13);
            // Hand-filed: todo → in_progress (×5), in_progress → done (×4). Recorded: both
            // iterations walk todo → in_progress → done (×4), the approved planned Task
            // backlog → todo → in_progress → done (×3); the other two stay in backlog.
            expect(moved).toBe(16);
        });

        it('writes three short knowledge notes to the Organization', async () => {
            const notes = await rows(WorkKnowledgeDocument).findBy({
                organizationId: first.summary.organizationId,
                workId: IsNull(),
            });
            expect(notes.map((note) => note.title).sort()).toEqual([
                'Launch checklist',
                'Target audience',
                'Voice and tone',
            ]);
        });
    });

    describe('recorded examples', () => {
        const fixture = loadDemoRecordedFixture();

        it('answers the completed Goal "Publish the launch blog post" as the recorded Goal', async () => {
            const { goal } = await recordedRows(first);
            expect(first.summary.recordedGoalId).toBe(goal.id);
            expect(goal.status).toBe(GoalStatus.COMPLETED);
        });

        it('gives that Goal two done iterations, each with one completed run on a free model at no cost', async () => {
            const { goal, iterationTasks, runs } = await recordedRows(first);
            expect(iterationTasks.map((task) => task.title)).toEqual([
                '[Goal] Publish the launch blog post — iteration 1',
                '[Goal] Publish the launch blog post — iteration 2',
            ]);
            for (const task of iterationTasks) {
                expect(task.status).toBe(TaskStatus.DONE);
                expect(task.completedAt).toBeInstanceOf(Date);
                expect(task.workId).toBe(first.summary.projectWorkId);
                expect(task.agentId).toBeTruthy();
                expect(task.organizationId).toBe(first.summary.organizationId);

                const taskRuns = runs.filter((run) => run.taskId === task.id);
                expect(taskRuns).toHaveLength(1);
                const [run] = taskRuns;
                expect(run.status).toBe('completed');
                expect(run.triggerKind).toBe('task');
                expect(run.agentId).toBe(task.agentId);
                expect(run.workId).toBe(first.summary.projectWorkId);
                expect(run.modelRouting?.model).toBe(RECORDED_MODEL);
                expect(run.modelRouting?.model.endsWith(':free')).toBe(true);
                expect(run.costCents).toBe(0);
                expect(run.summary?.trim()).toBeTruthy();
                expect(run.finishedAt!.getTime()).toBeGreaterThan(run.startedAt!.getTime());
                expect(run.durationMs).toBe(run.finishedAt!.getTime() - run.startedAt!.getTime());
                expect(run.organizationId).toBe(first.summary.organizationId);
                // The board's run chip reads the Task's latest-run denorm.
                expect([task.latestRunId, task.latestRunStatus]).toEqual([run.id, 'completed']);
            }
            // The loop that ran them is finished: never `running`, so never advanced again.
            expect(goal.iteration).toBe(2);
            expect(goal.loopStatus).toBe('done');
            expect(goal.spentCents).toBe(0);
        });

        it('gives every recorded run a transcript of messages and tool calls', async () => {
            const { runs, logs } = await recordedRows(first);
            expect(runs).toHaveLength(3);
            for (const run of runs) {
                const transcript = logs.filter((log) => log.runId === run.id);
                expect(transcript.length).toBeGreaterThanOrEqual(4);
                const steps = new Set(transcript.map((log) => log.step));
                expect(steps).toEqual(
                    new Set(['user-message', 'assistant-message', 'tool-invocation']),
                );
                for (const log of transcript) {
                    expect(log.message.trim()).toBeTruthy();
                    expect(log.organizationId).toBe(first.summary.organizationId);
                    if (log.step === 'tool-invocation') {
                        expect(typeof log.metadata?.toolName).toBe('string');
                        expect(typeof log.metadata?.argsPreview).toBe('string');
                    }
                }
            }
        });

        it("logs the Goal loop's routing, dispatches, Definition-of-Done ticks and completion", async () => {
            const { goalEvents, iterationTasks, runs } = await recordedRows(first);
            expect(goalEvents.map((event) => [event.kind, event.iteration])).toEqual([
                ['route', 1],
                ['dispatch', 1],
                ['dod', 1],
                ['route', 2],
                ['dispatch', 2],
                ['dod', 2],
                ['complete', 2],
            ]);
            const dispatches = goalEvents.filter((event) => event.kind === 'dispatch');
            expect(dispatches.map((event) => event.taskId)).toEqual(
                iterationTasks.map((task) => task.id),
            );
            expect(dispatches.map((event) => event.metadata?.runId)).toEqual(
                iterationTasks.map((task) => runs.find((run) => run.taskId === task.id)?.id),
            );
            // The lines the orchestrator writes when a person ticks a criterion.
            expect(
                goalEvents.filter((event) => event.kind === 'dod').map((e) => e.message),
            ).toEqual([
                'Criterion "Draft approved by the team" → done — 1 done, 0 waived, 1 open.',
                'Criterion "Post is live on the Acme blog" → done — 2 done, 0 waived, 0 open.',
            ]);
            for (const event of goalEvents) {
                expect(event.organizationId).toBe(first.summary.organizationId);
            }
        });

        it("files the Mission's plan from the fixture, with one finished run", async () => {
            const { mission, planTasks, runs } = await recordedRows(first);
            expect(planTasks.map((task) => [task.title, task.status]).sort()).toEqual(
                fixture.mission.plan.map((entry) => [entry.title, entry.status]).sort(),
            );
            expect(planTasks).toHaveLength(3);
            for (const task of planTasks) {
                expect(task.missionId).toBe(mission.id);
                expect(task.workId).toBe(first.summary.projectWorkId);
            }
            const planRuns = runs.filter((run) => planTasks.some((task) => task.id === run.taskId));
            expect(planRuns).toHaveLength(1);
            expect(planRuns[0].status).toBe('completed');
            expect(planRuns[0].modelRouting?.model).toBe(RECORDED_MODEL);
            expect(planRuns[0].costCents).toBe(0);
        });

        it('opens one Agent chat with four sent messages, the Agent answering the visitor', async () => {
            const { conversations, messages, participants } = await recordedRows(first);
            expect(conversations).toHaveLength(1);
            const [conversation] = conversations;
            expect(conversation.kind).toBe('direct');
            expect(conversation.titleSource).toBe('user');
            expect(conversation.organizationId).toBe(first.summary.organizationId);
            const agent = await rows(Agent).findOneByOrFail({ id: conversation.agentId! });
            expect(agent.userId).toBe(first.user.id);

            expect(messages.map((message) => [message.role, message.authorType])).toEqual([
                ['user', 'user'],
                ['assistant', 'agent'],
                ['user', 'user'],
                ['assistant', 'agent'],
            ]);
            for (const [index, message] of messages.entries()) {
                expect(message.status).toBe('sent');
                expect(message.content.trim()).toBeTruthy();
                if (message.role === 'assistant') {
                    expect(message.authorId).toBe(agent.id);
                    expect(message.model).toBe(RECORDED_MODEL);
                    expect(message.replyToMessageId).toBe(messages[index - 1].id);
                } else {
                    expect(message.authorId).toBe(first.user.id);
                }
            }
            expect(conversation.lastMessageAt?.getTime()).toBe(
                messages[messages.length - 1].createdAt.getTime(),
            );
            expect(
                participants.map((participant) => [
                    participant.participantType,
                    participant.participantId,
                    participant.role,
                ]),
            ).toEqual(
                expect.arrayContaining([
                    ['user', first.user.id, 'owner'],
                    ['agent', agent.id, 'member'],
                ]),
            );
            expect(participants).toHaveLength(2);
        });

        it('writes ten activity-log entries about the recorded work', async () => {
            const { activity, runs, goal, mission } = await recordedRows(first);
            expect(activity).toHaveLength(10);
            expect(activity.map((entry) => entry.actionType).sort()).toEqual(
                [
                    ActivityActionType.GOAL_LOOP_STARTED,
                    ActivityActionType.GOAL_ITERATION_DISPATCHED,
                    ActivityActionType.GOAL_ITERATION_DISPATCHED,
                    ActivityActionType.GOAL_DOD_UPDATED,
                    ActivityActionType.GOAL_DOD_UPDATED,
                    ActivityActionType.GOAL_LOOP_COMPLETED,
                    ActivityActionType.AGENT_RUN_COMPLETED,
                    ActivityActionType.AGENT_RUN_COMPLETED,
                    ActivityActionType.AGENT_RUN_COMPLETED,
                    ActivityActionType.MISSION_TICK,
                ].sort(),
            );
            const runIds = new Set(runs.map((run) => run.id));
            for (const entry of activity) {
                expect(entry.organizationId).toBe(first.summary.organizationId);
                expect(entry.summary.trim()).toBeTruthy();
                if (entry.details?.runId) expect(runIds.has(entry.details.runId)).toBe(true);
                if (entry.details?.goalId) expect(entry.details.goalId).toBe(goal.id);
                if (entry.details?.missionId) expect(entry.details.missionId).toBe(mission.id);
            }
            // What an Agent did is the Agent's, as the Live Feed derives it in production.
            const finished = activity.filter(
                (entry) => entry.actionType === ActivityActionType.AGENT_RUN_COMPLETED,
            );
            for (const entry of finished) {
                expect(entry.actorKind).toBe('agent');
                expect(entry.actorAgentId).toBe(entry.details?.agentId);
                expect(entry.actorLabel).toBeTruthy();
            }
        });

        it('dates every recorded row before the sandbox was created', async () => {
            const recorded = await recordedRows(first);
            const stamps: Array<[string, Date | null | undefined]> = [
                ...recorded.runs.flatMap((run) => [
                    ['run.createdAt', run.createdAt] as [string, Date],
                    ['run.startedAt', run.startedAt] as [string, Date],
                    ['run.finishedAt', run.finishedAt] as [string, Date],
                ]),
                ...recorded.logs.map((log) => ['log', log.createdAt] as [string, Date]),
                ...recorded.goalEvents.map((e) => ['goalEvent', e.createdAt] as [string, Date]),
                ...[...recorded.iterationTasks, ...recorded.planTasks].flatMap((task) => [
                    ['task.createdAt', task.createdAt] as [string, Date],
                    ...(task.status === TaskStatus.DONE
                        ? [['task.completedAt', task.completedAt] as [string, Date]]
                        : []),
                ]),
                ...recorded.conversations.flatMap((conversation) => [
                    ['conversation.createdAt', conversation.createdAt] as [string, Date],
                    ['conversation.lastMessageAt', conversation.lastMessageAt] as [string, Date],
                ]),
                ...recorded.messages.map((m) => ['message', m.createdAt] as [string, Date]),
                ...recorded.activity.map((a) => ['activity', a.createdAt] as [string, Date]),
                ['goal.loopStartedAt', recorded.goal.loopStartedAt],
            ];
            expect(stamps.length).toBeGreaterThan(40);
            const createdAt = first.startedAt.getTime();
            for (const [name, stamp] of stamps) {
                expect([name, stamp instanceof Date]).toEqual([name, true]);
                // In the past ("2 hours ago"), relative to the sandbox, and not by days.
                expect([name, stamp!.getTime() < createdAt]).toEqual([name, true]);
                expect([name, stamp!.getTime() > createdAt - 24 * 60 * MINUTE]).toEqual([
                    name,
                    true,
                ]);
            }
        });

        it('gives each sandbox its own recorded rows, ids generated per sandbox', async () => {
            const [a, b] = [await recordedRows(first), await recordedRows(second)];
            expect(second.summary.recordedGoalId).toBe(b.goal.id);
            expect(first.summary.recordedGoalId).not.toBe(second.summary.recordedGoalId);
            expect(a.runs).toHaveLength(3);
            expect(b.runs).toHaveLength(3);
            const firstRunIds = new Set(a.runs.map((run) => run.id));
            expect(b.runs.filter((run) => firstRunIds.has(run.id))).toEqual([]);
            expect(a.conversations[0].id).not.toBe(b.conversations[0].id);
            for (const run of b.runs) {
                expect(run.organizationId).toBe(second.summary.organizationId);
                expect(run.tenantId).toBe((await users.findById(second.user.id))?.tenantId);
            }
        });
    });

    it('calls no AI and no GitHub, and generates, deploys, titles and evaluates nothing', () => {
        expect(calledMethods(ai.spies)).toEqual([]);
        expect(calledMethods(git.spies)).toEqual([]);
        // No repository is provisioned at seed time (ruling R2): Generate does that later.
        expect(calledMethods(everWorksGit.spies)).toEqual([]);
        expect(inertCalls).toEqual([]);
    });

    it('emits no in-process event while seeding, so no listener runs', () => {
        // With the production notification path wired: a transition notifies the Task's
        // watchers, and a seeded Task has none.
        expect(probeHeard).toBe(true);
        expect(emitted).toEqual([]);
    });

    it('records exactly these domain events, all in the sandbox, for the relay to publish', async () => {
        const counts: Record<string, number> = {};
        for (const event of firstDomainEvents) {
            counts[event.type] = (counts[event.type] ?? 0) + 1;
        }
        // The relay emits each as `domain.<type>`; only `domain.work.*` has a listener
        // (Ever Connect's apps mirror, for Organizations linked to Ever Platform).
        expect(counts).toEqual({
            'organization.created': 1,
            'agent.created': 4,
            'agent.updated': 4,
            // R42 a: each starter-kit Agent activated (draft → active).
            'agent.status_changed': 4,
            'team.created': 2,
            'team.member.added': 4,
            'team.resource.added': 2,
            'work.created': 2,
            'mission.created': 2,
            'mission.work.linked': 2,
            'mission.goal.linked': 3,
            'goal.created': 3,
            'goal.updated': 3,
            'goal.status_changed': 3,
            // 8 hand-filed + the recorded Goal's 2 iterations + the Mission's 3 planned Tasks,
            // each through `TasksService` (the recorded runs, logs, Goal events, chat and
            // activity entries are plain rows and record no event).
            'task.created': 13,
            'task.transitioned': 16,
            'task.comment.created': 11,
            'kb.document.created': 3,
        });
        const tenantId = (await users.findById(first.user.id))?.tenantId;
        expect(
            firstDomainEvents.map((event) => [event.type, event.tenantId, event.organizationId]),
        ).toEqual(
            firstDomainEvents.map((event) => [event.type, tenantId, first.summary.organizationId]),
        );
    });

    it('gives two sandboxes no Organization or Tenant in common', async () => {
        const [userA, userB] = await Promise.all([
            users.findById(first.user.id),
            users.findById(second.user.id),
        ]);
        expect(first.summary.organizationId).not.toBe(second.summary.organizationId);
        expect(userA?.tenantId).toBeTruthy();
        expect(userB?.tenantId).toBeTruthy();
        expect(userA?.tenantId).not.toBe(userB?.tenantId);

        for (const [user, summary] of [
            [userA!, first.summary],
            [userB!, second.summary],
        ] as const) {
            for (const entity of [
                Work,
                Agent,
                Mission,
                Goal,
                Task,
                AgentRun,
                Conversation,
            ] as const) {
                const owned = await rows<{
                    organizationId?: string | null;
                    tenantId?: string | null;
                }>(entity as never).findBy({ userId: user.id } as never);
                expect(owned.length).toBeGreaterThan(0);
                for (const row of owned) {
                    expect(row.organizationId).toBe(summary.organizationId);
                    expect(row.tenantId).toBe(user.tenantId);
                }
            }
        }
        expect(await rows(Task).countBy({ organizationId: first.summary.organizationId })).toBe(13);
        expect(await rows(Task).countBy({ organizationId: second.summary.organizationId })).toBe(
            13,
        );
    });

    it('seeds a sandbox in under 3 s', () => {
        // Both seeds above, the first included (it pays for the cold paths).
        expect(timings).toHaveLength(2);
        for (const ms of timings) {
            expect(ms).toBeLessThan(3000);
        }
    });

    /**
     * Last on purpose: it runs the real selectors over everything both seeds wrote, adds (and
     * removes) control runs, and lets the Goal evaluator's tick evaluate the ACTIVE fixture Goal.
     */
    describe('nothing picks the recorded rows up', () => {
        let recorded: Array<Awaited<ReturnType<typeof recordedRows>>>;
        const DAY = 24 * 60 * MINUTE;

        beforeAll(async () => {
            recorded = [await recordedRows(first), await recordedRows(second)];
        });

        it('no run sweeper, dispatch-gate drain, retention pass or admission count selects a recorded run', async () => {
            const runs = new AgentRunRepository(rows(AgentRun));
            const recordedIds = new Set(
                recorded.flatMap((sandbox) => sandbox.runs.map((r) => r.id)),
            );
            expect(recordedIds.size).toBe(6);
            const agentId = recorded[0].runs[0].agentId;
            const old = new Date(Date.now() - 200 * DAY);
            // Positive controls, so an empty answer below is not a query that selects nothing:
            // a run parked by the dispatch gate, a live terminal whose heartbeat stopped, and a
            // finished run past log retention.
            const controls = await rows(AgentRun).save([
                rows(AgentRun).create({
                    agentId,
                    userId: first.user.id,
                    triggerKind: 'task',
                    status: 'queued',
                    queuedReason: QUEUED_REASON_CONCURRENCY,
                    workId: first.summary.projectWorkId,
                    createdAt: old,
                }),
                rows(AgentRun).create({
                    agentId,
                    userId: first.user.id,
                    triggerKind: 'manual',
                    status: 'running',
                    terminalState: 'attached',
                    startedAt: old,
                    lastHeartbeatAt: old,
                    createdAt: old,
                }),
                rows(AgentRun).create({
                    agentId,
                    userId: first.user.id,
                    triggerKind: 'manual',
                    status: 'completed',
                    startedAt: old,
                    finishedAt: old,
                    createdAt: old,
                }),
            ]);
            const [parked, quiet, expired] = controls.map((run) => run.id);
            const ids = (selected: Array<{ id: string }>) => selected.map((run) => run.id).sort();
            try {
                const farFuture = new Date(Date.now() + 365 * DAY);
                // `AgentRunSweeperService`: stuck runs, runs queued too long, quiet terminals.
                expect(ids(await runs.findStuckNonTerminal(farFuture, 1000))).toEqual(
                    [parked, quiet].sort(),
                );
                expect(ids(await runs.findQueuedTooLong(farFuture, 1000))).toEqual([parked]);
                expect(ids(await runs.findStaleTerminalRuns(farFuture, 1000))).toEqual([quiet]);
                // `RunDispatchGateService`'s drain of the Work the recorded runs belong to.
                const drained = await runs.findOldestQueuedForConcurrency(
                    first.summary.projectWorkId,
                    QUEUED_REASON_CONCURRENCY,
                );
                expect(drained?.id).toBe(parked);
                // The nightly retention pass deletes the timeline of runs past the window.
                const cutoff = new Date(Date.now() - config.agents.getRunLogRetentionDays() * DAY);
                expect(await runs.findLogRetentionCandidates(cutoff, 1000)).toEqual([expired]);
                // Admission and chat dedup: a recorded run is never "in flight".
                for (const sandbox of recorded) {
                    for (const run of sandbox.runs) {
                        expect(
                            await runs.findInFlightForTaskAgent(run.taskId!, run.agentId),
                        ).toBeNull();
                        const inFlight = await runs.findInFlightForAgent(run.agentId);
                        expect(recordedIds.has(inFlight?.id ?? '')).toBe(false);
                    }
                }
                expect(await runs.countInFlightForUser(second.user.id)).toBe(0);
            } finally {
                await rows(AgentRun).delete(controls.map((run) => run.id));
            }
        });

        it('the Goal loop advances no recorded Goal and the Goal evaluator selects none', async () => {
            const goalIds = recorded.map((sandbox) => sandbox.goal.id);
            // Required repositories only: with no Tasks runtime bound it could not dispatch
            // even a Goal it did select (it would log a refusal instead).
            const orchestrator = new GoalOrchestratorService(
                rows(Goal),
                rows(GoalEvent),
                rows(Task),
                rows(AgentRun),
            );
            // Positive control: a Goal whose loop is `running`, so an empty answer for the
            // recorded Goals is not a selector that selects nothing.
            const running = await rows(Goal).save(
                rows(Goal).create({
                    userId: first.user.id,
                    title: 'Control: a running Goal loop',
                    window: 'total',
                    status: GoalStatus.ACTIVE,
                    loopStatus: 'running',
                    dodCriteria: [{ id: 'open', text: 'Still open', status: 'open' }],
                }),
            );
            try {
                const advanced = await orchestrator.advanceDue(1000);
                // Only a `running` loop is advanced: the control is, the recorded `done` loops
                // are not.
                expect(advanced.dueCount).toBe(1);
                expect(advanced.results.map((result) => result.goalId)).toEqual([running.id]);
            } finally {
                await rows(GoalEvent).delete({ goalId: running.id });
                await rows(Goal).delete({ id: running.id });
            }

            const refusingMetrics = new Proxy(
                {},
                {
                    get: (_target, prop) =>
                        prop === 'then'
                            ? undefined
                            : () => {
                                  throw new Error(`metrics.${String(prop)} read while evaluating`);
                              },
                },
            );
            const evaluator = new GoalEvaluationService(
                rows(Goal),
                rows(GoalMetricSample),
                refusingMetrics as never,
            );
            const evaluated = await evaluator.evaluateDue(1000);
            // Positive control: activating the ACTIVE fixture Goal scheduled a check, so the
            // tick does select something.
            expect(evaluated.dueCount).toBeGreaterThan(0);
            const evaluatedIds = evaluated.entries.map((entry) => entry.goalId);
            for (const goalId of goalIds) {
                expect(evaluatedIds).not.toContain(goalId);
            }
            for (const goal of await rows(Goal).findBy({ id: In(goalIds) })) {
                expect([goal.status, goal.loopStatus, goal.iteration]).toEqual([
                    GoalStatus.COMPLETED,
                    'done',
                    2,
                ]);
            }
        });

        it('no Task scan, Mission tick or heartbeat selects a seeded Task, Mission or Agent', async () => {
            const tasks = moduleRef.get(TaskRepository);
            const agents = moduleRef.get(AgentRepository);
            const sandboxTaskIds = new Set(
                (await rows(Task).findBy({ userId: In([first.user.id, second.user.id]) })).map(
                    (task) => task.id,
                ),
            );
            // The planned Tasks not yet run wait for approval in `backlog`, never in `todo`.
            for (const sandbox of recorded) {
                expect(
                    sandbox.planTasks
                        .filter((task) => task.status !== TaskStatus.DONE)
                        .map((task) => task.status),
                ).toEqual([TaskStatus.BACKLOG, TaskStatus.BACKLOG]);
            }
            const old = new Date(Date.now() - 200 * DAY);
            const farFuture = new Date(Date.now() + 365 * DAY);
            const controlTask = (slug: string, extra: Partial<Task>) =>
                rows(Task).create({
                    userId: first.user.id,
                    slug: `${slug}-${randomBytes(4).toString('hex')}`,
                    title: `Control: ${slug}`,
                    status: TaskStatus.TODO,
                    priority: TaskPriority.P2,
                    agentId: recorded[0].runs[0].agentId,
                    createdByType: 'user',
                    createdById: first.user.id,
                    ...extra,
                });
            // Positive controls, one per scan: a never-run `todo` Task (the fan-out's), a
            // one-shot whose time has come (the schedule scan's), a due recurring template.
            const [fanout, scheduled, recurring] = await rows(Task).save([
                controlTask('control-fanout', {}),
                controlTask('control-scheduled', { scheduledAt: old }),
                controlTask('control-recurring', {
                    isRecurring: true,
                    recurrenceCron: '0 9 * * *',
                    nextOccurrenceAt: old,
                }),
            ]);
            const controlMission = await rows(Mission).save(
                rows(Mission).create({
                    userId: first.user.id,
                    title: 'Control: a scheduled Mission',
                    description: 'Control',
                    type: MissionType.SCHEDULED,
                    status: MissionStatus.ACTIVE,
                    schedule: null,
                }),
            );
            const sandboxAgents = await rows(Agent).findBy({
                userId: In([first.user.id, second.user.id]),
            });
            const heartbeatAgent = sandboxAgents[0];
            const ids = (selected: Array<{ id: string }>) => selected.map((row) => row.id);
            try {
                // `TaskGraphFanoutService.dispatchUnblocked` (off by default; this is what it
                // would start), `TaskRecurrenceDispatcherService`'s schedule and recurrence
                // scans: each selects its control and no Task of either sandbox.
                expect(ids(await tasks.findFanoutCandidates(1000))).toEqual([fanout.id]);
                expect(ids(await tasks.findDueScheduledTasks(1000, farFuture))).toEqual([
                    scheduled.id,
                ]);
                expect(ids(await tasks.findDueRecurringTemplates(1000, farFuture))).toEqual([
                    recurring.id,
                ]);
                for (const id of [fanout.id, scheduled.id, recurring.id]) {
                    expect(sandboxTaskIds.has(id)).toBe(false);
                }

                // `MissionTickService.tickDue` (the Mission cron): ACTIVE + SCHEDULED Missions
                // only. The seeded Missions are one-shot; the control (no cron set) is
                // evaluated and stops at the cron check, before anything is generated.
                const refusing = new Proxy(
                    {},
                    {
                        get: (_target, prop) =>
                            prop === 'then'
                                ? undefined
                                : () => {
                                      throw new Error(`mission tick called ${String(prop)}`);
                                  },
                    },
                ) as never;
                const tick = await new MissionTickService(
                    rows(Mission),
                    refusing,
                    refusing,
                    refusing,
                ).tickDue();
                expect(tick.entries.map((entry) => [entry.missionId, entry.outcome])).toEqual([
                    [controlMission.id, 'cron-no-match'],
                ]);

                // `AgentScheduleDispatcherService.dispatchDue` (heartbeats): no seeded Agent
                // has a heartbeat scheduled (the starter kit's Agents are active, with no
                // cadence and no next beat), however far ahead the tick looks...
                expect(sandboxAgents.length).toBeGreaterThanOrEqual(8);
                for (const agent of sandboxAgents) {
                    expect([agent.heartbeatCadence ?? null, agent.nextHeartbeatAt ?? null]).toEqual(
                        [null, null],
                    );
                }
                const dueAgents = ids(await agents.findDueForHeartbeat(1000, farFuture));
                for (const agent of sandboxAgents) {
                    expect(dueAgents).not.toContain(agent.id);
                }
                // ...and an active one with a cadence and a due beat would be selected
                // (positive control on a copy of a seeded Agent's columns, put back after).
                await rows(Agent).update(
                    { id: heartbeatAgent.id },
                    {
                        status: AgentStatus.ACTIVE,
                        heartbeatPausedAt: null,
                        heartbeatCadence: 'hourly',
                        nextHeartbeatAt: old,
                    },
                );
                expect(ids(await agents.findDueForHeartbeat(1000, farFuture))).toEqual([
                    heartbeatAgent.id,
                ]);
            } finally {
                await rows(Agent).update(
                    { id: heartbeatAgent.id },
                    {
                        status: heartbeatAgent.status,
                        heartbeatPausedAt: heartbeatAgent.heartbeatPausedAt ?? null,
                        heartbeatCadence: heartbeatAgent.heartbeatCadence ?? null,
                        nextHeartbeatAt: heartbeatAgent.nextHeartbeatAt ?? null,
                    },
                );
                await rows(Mission).delete({ id: controlMission.id });
                await rows(Task).delete([fanout.id, scheduled.id, recurring.id]);
            }
        });

        it('no recorded chat message is waiting for, or getting, an Agent reply', async () => {
            const conversationRows = moduleRef.get(ConversationRepository);
            const runs = new AgentRunRepository(rows(AgentRun));
            // The messages were written as rows, not sent: no reply run was dispatched.
            expect(await rows(AgentRun).countBy({ triggerKind: 'conversation' })).toBe(0);
            for (const sandbox of recorded) {
                const [conversation] = sandbox.conversations;
                expect(
                    await conversationRows.findUnsettledMessages(
                        conversation.id,
                        ['sending', 'failed'],
                        [],
                        50,
                    ),
                ).toEqual([]);
                expect(
                    await runs.findInFlightForConversationAgent(
                        conversation.id,
                        conversation.agentId!,
                    ),
                ).toBeNull();
                // The thread ends on the Agent's answer: nothing the visitor wrote is open.
                expect(sandbox.messages[sandbox.messages.length - 1].authorType).toBe('agent');
            }
        });
    });

    /**
     * R42 a, last: it dispatches a run (put back after). "Run now" on an Agent page goes through
     * `AgentScheduleDispatcherService.dispatchOne`, which answers `skipped: inactive` for a draft
     * Agent: a seeded starter-kit Agent must be active for the visitor's click to do anything.
     */
    it('"Run now" on a seeded Agent dispatches a run instead of answering skipped: inactive', async () => {
        const [agent] = await rows(Agent).find({
            where: { userId: first.user.id },
            order: { name: 'ASC' },
            take: 1,
        });
        const before = { status: agent.status, nextHeartbeatAt: agent.nextHeartbeatAt ?? null };
        const enqueue = jest.fn(async () => ({ runId: 'trigger-run-1' }));
        const dispatcher = new AgentScheduleDispatcherService(
            moduleRef.get(AgentRepository),
            new AgentRunRepository(rows(AgentRun)),
        );
        let runId: string | undefined;
        try {
            const outcome = await dispatcher.dispatchOne({ enqueue } as never, agent.id);

            expect(outcome).toEqual({ outcome: 'dispatched', runId: expect.any(String) });
            runId = (outcome as { runId: string }).runId;
            expect(enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ agentId: agent.id, userId: first.user.id, runId }),
            );
        } finally {
            if (runId) await rows(AgentRun).delete({ id: runId });
            await rows(Agent).update({ id: agent.id }, before);
        }
    });
});
