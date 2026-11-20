import { Injectable } from '@nestjs/common';
import { OnboardingRoleSeedingService } from '@ever-works/agent/agents';
import { UserRepository, WorkRepository, type OwnershipScope } from '@ever-works/agent/database';
import {
    GoalOutcome,
    GoalStatus,
    MissionType,
    TaskStatus,
    type User,
} from '@ever-works/agent/entities';
import { GoalsService } from '@ever-works/agent/goals';
import { MissionsService } from '@ever-works/agent/missions';
import { KnowledgeBaseService, WorkLifecycleService } from '@ever-works/agent/services';
import { TaskChatService, TasksService } from '@ever-works/agent/tasks-domain';
import { TeamsService } from '@ever-works/agent/teams';
import { OrganizationService } from '../../organizations/organization.service';
import { ScopeContextService } from '../../scope/scope-context.service';
import { DEMO_SANDBOX_FIXTURE, type DemoSandboxFixture } from './demo-sandbox.fixture';

/** What the seeder created for one demo sandbox. */
export type DemoSeedSummary = {
    organizationId: string;
    projectWorkId: string;
    directoryWorkId: string;
    recordedGoalId: string | null;
};

/** The ownership every row of the sandbox is stamped with. */
type SandboxScope = OwnershipScope & { organizationId: string };

/**
 * The storage the draft directory Work records: when the visitor presses Generate, the
 * repository is provisioned on Ever Works Git (a `demo-` repository), never at seed time.
 */
const DIRECTORY_WORK_STORAGE = 'ever-works-git';

/**
 * Platform demo mode — seeds a fresh demo sandbox's workspace (design §5.2.3) from
 * {@link DEMO_SANDBOX_FIXTURE}: an Organization the visitor administers, two Teams, the
 * onboarding starter-kit Agents, a Project Work with its Missions, Goals, Tasks and threads,
 * organization knowledge notes, and a draft directory Work ready for Generate.
 *
 * Everything goes through the domain services, so their checks, events and activity rows
 * hold; nothing calls an AI model or GitHub. The services do not share one transaction: when a
 * step fails, `DemoSandboxService` expires the sandbox and the demo sweeper removes what was
 * written.
 */
@Injectable()
export class DemoSandboxSeederService {
    constructor(
        private readonly organizations: OrganizationService,
        private readonly scopeContext: ScopeContextService,
        private readonly users: UserRepository,
        private readonly works: WorkRepository,
        private readonly teams: TeamsService,
        private readonly starterKit: OnboardingRoleSeedingService,
        private readonly workLifecycle: WorkLifecycleService,
        private readonly missions: MissionsService,
        private readonly goals: GoalsService,
        private readonly tasks: TasksService,
        private readonly taskChat: TaskChatService,
        private readonly knowledge: KnowledgeBaseService,
    ) {}

    async seed(user: User): Promise<DemoSeedSummary> {
        const fixture = DEMO_SANDBOX_FIXTURE;
        // Lazily creates the visitor's own Tenant (its owner administers every Organization
        // in it) and makes the Organization the scope the visitor lands on. The slug carries
        // the demo username, so no `-2, -3, …` counter is scanned across sandboxes.
        const organization = await this.organizations.createOrganization(
            user.id,
            fixture.organization.name,
            `${fixture.organization.slugPrefix}-${user.username}`,
        );
        // Re-read: creating the Organization linked the user to its Tenant.
        const owner = await this.users.findById(user.id);
        if (!owner) {
            throw new Error(`Demo user ${user.id} disappeared while its sandbox was seeded`);
        }
        const scope: SandboxScope = {
            tenantId: organization.tenantId,
            organizationId: organization.id,
        };
        // Services that stamp the ambient scope (Works, Agents) need it set, as the
        // company-template importer does; every service that takes a scope gets it too.
        return this.scopeContext.runWith(scope, () => this.seedOrganization(owner, scope, fixture));
    }

    private async seedOrganization(
        owner: User,
        scope: SandboxScope,
        fixture: DemoSandboxFixture,
    ): Promise<DemoSeedSummary> {
        const agentIds = await this.seedAgents(owner.id, fixture);
        const teamIds = await this.seedTeams(owner.id, scope.organizationId, fixture, agentIds);

        const projectWork = await this.workLifecycle.createProjectWork(owner, {
            name: fixture.projectWork.name,
            slug: fixture.projectWork.slug,
            description: fixture.projectWork.description,
        });
        const missionIds = await this.seedMissions(
            owner.id,
            scope,
            projectWork.id,
            teamIds,
            fixture,
        );
        const goalIds = await this.seedGoals(owner.id, scope, projectWork.id, missionIds, fixture);
        await this.seedTasks(owner.id, scope, projectWork.id, goalIds, agentIds, fixture);
        await this.seedKnowledge(owner.id, scope.organizationId, fixture);
        const directoryWorkId = await this.seedDirectoryWork(owner, fixture);

        return {
            organizationId: scope.organizationId,
            projectWorkId: projectWork.id,
            directoryWorkId,
            recordedGoalId: null,
        };
    }

    /** The starter kit, as onboarding activates it. Returns agent id by template slug. */
    private async seedAgents(
        userId: string,
        fixture: DemoSandboxFixture,
    ): Promise<Map<string, string>> {
        const kit = await this.starterKit.seed(userId, fixture.starterKit.roles, {
            maxAgents: fixture.starterKit.maxAgents,
        });
        // The kit reports a template it could not create instead of throwing; for a fresh
        // demo user that is a fault, not a sandbox to hand out half-built.
        const missing = kit.agents.filter((entry) => entry.outcome !== 'created');
        if (missing.length > 0) {
            throw new Error(
                `Starter-kit agents not created: ${missing.map((entry) => entry.slug).join(', ')}`,
            );
        }
        return new Map(kit.agents.map((entry) => [entry.slug, entry.agentId as string]));
    }

    private async seedTeams(
        userId: string,
        organizationId: string,
        fixture: DemoSandboxFixture,
        agentIds: ReadonlyMap<string, string>,
    ): Promise<Map<string, string>> {
        const teamIds = new Map<string, string>();
        for (const entry of fixture.teams) {
            const roster = entry.agentSlugs.map((slug) => agentId(agentIds, slug));
            const team = await this.teams.create(userId, organizationId, {
                name: entry.name,
                slug: entry.slug,
                description: entry.description,
                managerAgentId: roster[0] ?? null,
            });
            for (const [index, memberId] of roster.entries()) {
                await this.teams.addMember(userId, organizationId, team.id, {
                    memberType: 'agent',
                    memberId,
                    role: index === 0 ? 'lead' : 'member',
                });
            }
            teamIds.set(entry.key, team.id);
        }
        return teamIds;
    }

    private async seedMissions(
        userId: string,
        scope: SandboxScope,
        projectWorkId: string,
        teamIds: ReadonlyMap<string, string>,
        fixture: DemoSandboxFixture,
    ): Promise<Map<string, string>> {
        const missionIds = new Map<string, string>();
        for (const entry of fixture.missions) {
            const mission = await this.missions.create(
                userId,
                {
                    title: entry.title,
                    description: entry.description,
                    type: MissionType.ONE_SHOT,
                    teamIds: [lookup(teamIds, entry.teamKey, 'team')],
                },
                scope,
            );
            await this.missions.attachWork(
                userId,
                mission.id,
                projectWorkId,
                entry.relation,
                scope,
            );
            missionIds.set(entry.key, mission.id);
        }
        return missionIds;
    }

    /** Each Goal is created as a draft, linked, then moved to the state the fixture names. */
    private async seedGoals(
        userId: string,
        scope: SandboxScope,
        projectWorkId: string,
        missionIds: ReadonlyMap<string, string>,
        fixture: DemoSandboxFixture,
    ): Promise<Map<string, { goalId: string; missionId: string }>> {
        const goalIds = new Map<string, { goalId: string; missionId: string }>();
        const missionsWithPrimary = new Set<string>();
        for (const entry of fixture.goals) {
            const missionId = lookup(missionIds, entry.missionKey, 'mission');
            const goal = await this.goals.create(
                userId,
                {
                    title: entry.title,
                    description: entry.description,
                    goalKind: 'delivery',
                    dodCriteria: entry.definitionOfDone.map((criterion) => ({ ...criterion })),
                    workId: projectWorkId,
                },
                scope,
            );
            // The first Goal of a Mission is its primary one.
            const isPrimary = !missionsWithPrimary.has(missionId);
            missionsWithPrimary.add(missionId);
            await this.goals.linkToMission(userId, missionId, goal.id, isPrimary, scope);

            if (entry.status !== GoalStatus.DRAFT) {
                await this.goals.activate(userId, goal.id, scope);
            }
            if (entry.status === GoalStatus.COMPLETED) {
                // A person recording the outcome completes the Goal (spec FR-13).
                await this.goals.update(userId, goal.id, { outcome: GoalOutcome.ACHIEVED }, scope);
            }
            goalIds.set(entry.key, { goalId: goal.id, missionId });
        }
        return goalIds;
    }

    /**
     * Tasks start in `todo` and walk to their state through the ordinary transitions (the
     * sync walk, which starts no agent run), so each one carries its history; then the
     * thread gets its comments.
     */
    private async seedTasks(
        userId: string,
        scope: SandboxScope,
        projectWorkId: string,
        goalIds: ReadonlyMap<string, { goalId: string; missionId: string }>,
        agentIds: ReadonlyMap<string, string>,
        fixture: DemoSandboxFixture,
    ): Promise<void> {
        for (const entry of fixture.tasks) {
            const { goalId, missionId } = lookup(goalIds, entry.goalKey, 'goal');
            const assignee = entry.agentSlug ? agentId(agentIds, entry.agentSlug) : null;
            const task = await this.tasks.create(
                userId,
                {
                    title: entry.title,
                    description: entry.description,
                    status: TaskStatus.TODO,
                    priority: entry.priority,
                    workId: projectWorkId,
                    missionId,
                    goalId,
                    agentId: assignee,
                    createdByType: 'user',
                    createdById: userId,
                },
                scope,
            );
            if (entry.status !== TaskStatus.TODO) {
                await this.tasks.syncTransition(userId, task.id, entry.status, {}, scope);
            }
            for (const comment of entry.comments) {
                if (comment.by === 'agent' && !assignee) {
                    throw new Error(
                        `Demo fixture: "${entry.title}" has an agent comment but no agent`,
                    );
                }
                await this.taskChat.post(
                    userId,
                    {
                        taskId: task.id,
                        authorType: comment.by === 'agent' ? 'agent' : 'user',
                        authorId: comment.by === 'agent' ? assignee : userId,
                        body: comment.body,
                    },
                    {},
                    scope,
                );
            }
        }
    }

    private async seedKnowledge(
        userId: string,
        organizationId: string,
        fixture: DemoSandboxFixture,
    ): Promise<void> {
        for (const note of fixture.knowledgeNotes) {
            await this.knowledge.createOrgDocument(organizationId, userId, {
                path: note.path,
                title: note.title,
                class: note.class,
                body: note.body,
            });
        }
    }

    /**
     * The row-only draft path: no repository is provisioned now (`createDraftWork` makes
     * none). It takes no storage choice, so the one a later Generate provisions on is set
     * on the row afterwards; the draft has no repository for it to disagree with.
     */
    private async seedDirectoryWork(owner: User, fixture: DemoSandboxFixture): Promise<string> {
        const work = await this.workLifecycle.createDraftWork(owner, {
            name: fixture.directoryWork.name,
            slug: fixture.directoryWork.slug,
            description: fixture.directoryWork.prompt,
        });
        await this.works.update(work.id, { storageProvider: DIRECTORY_WORK_STORAGE });
        return work.id;
    }
}

function lookup<T>(ids: ReadonlyMap<string, T>, key: string, kind: string): T {
    const id = ids.get(key);
    if (id === undefined) {
        throw new Error(`Demo fixture: unknown ${kind} "${key}"`);
    }
    return id;
}

function agentId(agentIds: ReadonlyMap<string, string>, slug: string): string {
    return lookup(agentIds, slug, 'starter-kit agent');
}
