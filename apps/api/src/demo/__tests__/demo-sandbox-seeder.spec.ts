/**
 * Under api Jest the agent's `@src/notifications` imports (reached through the missions
 * barrel) resolve to the API's notifications files, whose `AuthModule` loads better-auth's
 * ESM through this one file. Nothing here builds an auth runtime.
 */
jest.mock('../../auth/providers/auth-runtime.instance', () => ({
    createAuthRuntimeInstance: jest.fn(),
}));

import { randomBytes } from 'node:crypto';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, In, IsNull } from 'typeorm';
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
    Goal,
    GoalOutcome,
    GoalStatus,
    Mission,
    MissionGoal,
    MissionWork,
    Organization,
    Task,
    TaskChatMessage,
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
    AgentTemplatesService,
    AgentsService,
    OnboardingRoleSeedingService,
} from '@ever-works/agent/agents';
import { DomainEventsModule } from '@ever-works/agent/domain-events';
import { EverWorksGitProvider } from '@ever-works/agent/ever-works-providers';
import { AiFacadeService, GitFacadeService } from '@ever-works/agent/facades';
import { GoalsService } from '@ever-works/agent/goals';
import { MissionsService } from '@ever-works/agent/missions';
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
    TaskRelationRepository,
    TaskRepository,
    TaskReviewerRepository,
    TasksService,
    TaskTransitionService,
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
import { DEMO_SANDBOX_FIXTURE } from '../seed/demo-sandbox.fixture';
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

    async function seedTimed(user: User): Promise<{ summary: DemoSeedSummary; ms: number }> {
        const started = performance.now();
        const summary = await seeder.seed(user);
        return { summary, ms: performance.now() - started };
    }

    const timings: number[] = [];
    let first: { user: User; summary: DemoSeedSummary };
    let second: { user: User; summary: DemoSeedSummary };

    beforeAll(async () => {
        const firstUser = await createDemoUser();
        const a = await seedTimed(firstUser);
        const secondUser = await createDemoUser();
        const b = await seedTimed(secondUser);
        timings.push(a.ms, b.ms);
        first = { user: firstUser, summary: a.summary };
        second = { user: secondUser, summary: b.summary };
    });

    const rows = <T extends object>(entity: new () => T) => dataSource.getRepository<T>(entity);

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

        it('creates the eight Tasks across the Goals, each with one or two comments', async () => {
            const tasks = await rows(Task).findBy({ userId: first.user.id });
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
            expect(created).toBe(8);
            // todo → in_progress (×5), in_progress → done (×4).
            expect(moved).toBe(9);
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

        it('leaves the recorded goal to the recorded-examples seeder', () => {
            expect(first.summary.recordedGoalId).toBeNull();
        });
    });

    it('calls no AI and no GitHub, and generates, deploys, titles and evaluates nothing', () => {
        expect(calledMethods(ai.spies)).toEqual([]);
        expect(calledMethods(git.spies)).toEqual([]);
        // No repository is provisioned at seed time (ruling R2): Generate does that later.
        expect(calledMethods(everWorksGit.spies)).toEqual([]);
        expect(inertCalls).toEqual([]);
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
            for (const entity of [Work, Agent, Mission, Goal, Task] as const) {
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
        expect(await rows(Task).countBy({ organizationId: first.summary.organizationId })).toBe(8);
        expect(await rows(Task).countBy({ organizationId: second.summary.organizationId })).toBe(8);
    });

    it('seeds a sandbox in under 3 s', () => {
        // Both seeds above, the first included (it pays for the cold paths).
        expect(timings).toHaveLength(2);
        for (const ms of timings) {
            expect(ms).toBeLessThan(3000);
        }
    });
});
