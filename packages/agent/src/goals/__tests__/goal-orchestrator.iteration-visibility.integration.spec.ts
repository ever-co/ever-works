import type { DataSource, Repository } from 'typeorm';
import { TaskRepository } from '../../database/repositories/task.repository';
import {
    createDomainEventsDataSource,
    resetDomainEventsTables,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { AgentRun } from '../../entities/agent-run.entity';
import { Goal } from '../../entities/goal.entity';
import { GoalEvent } from '../../entities/goal-event.entity';
import { Task } from '../../entities/task.entity';
import { Team } from '../../entities/team.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import { RecordVisibilityService } from '../../record-visibility/record-visibility.service';
import { TasksService } from '../../tasks-domain/tasks.service';
import { GoalOrchestratorService } from '../goal-orchestrator.service';

/**
 * A Goal's loop iteration is a Task carrying the Goal's title and brief, so it takes the Goal's
 * sharing. A private Goal files private iterations (review 2026-10-17 F1). A Goal shared with a
 * Team used to file `organization` iterations, readable by every member of the Organization; it
 * now files them on the Goal's Teams with `team` visibility (the Goal's Teams, plus the members
 * of the iteration's Work as for any `team` Task). Real
 * `TasksService`, `TaskRepository` and `RecordVisibilityService` on an in-memory SQLite database
 * with `RecordVisibilitySubscriber` registered; only the run dispatch is a double.
 */
describe('Goal loop iterations take the Goal visibility (real SQLite)', () => {
    let dataSource: DataSource;
    let goals: Repository<Goal>;
    let tasks: Repository<Task>;
    let teamRows: Repository<Team>;
    let teamResources: Repository<TeamResource>;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    const COLLEAGUE = '22222222-2222-4222-8222-222222222222';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    const ORG = '55555555-5555-4555-8555-555555555555';

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        goals = dataSource.getRepository(Goal);
        tasks = dataSource.getRepository(Task);
        teamRows = dataSource.getRepository(Team);
        teamResources = dataSource.getRepository(TeamResource);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await tasks.clear();
        await goals.clear();
        await teamResources.clear();
        await dataSource.getRepository(GoalEvent).clear();
        await resetDomainEventsTables(dataSource);
    });

    async function team(name: string): Promise<Team> {
        return teamRows.save(
            teamRows.create({
                userId: COLLEAGUE,
                name,
                slug: name.toLowerCase(),
                tenantId: TENANT,
                organizationId: ORG,
            }),
        );
    }

    /** One `advance` of a running Goal pinned to an Agent: files iteration 1. */
    async function advance(
        scope: { tenantId: string | null; organizationId: string | null },
        goalOver: Partial<Goal> = {},
        onTeams: Team[] = [],
    ) {
        const goal = await goals.save(
            goals.create({
                userId: OWNER,
                title: 'Reach 1k signups',
                goalKind: 'metric',
                metricSource: { pluginId: 'stripe', metricId: 'signups' },
                comparator: 'gte',
                targetValue: 1000,
                unit: 'signups',
                window: 'total',
                iteration: 0,
                assignedAgentId: AGENT,
                loopStatus: 'running',
                loopStartedAt: new Date(),
                ...scope,
                ...goalOver,
            } as Partial<Goal>),
        );
        for (const [index, onTeam] of onTeams.entries()) {
            await teamResources.save(
                teamResources.create({
                    teamId: onTeam.id,
                    resourceType: 'goal',
                    resourceId: goal.id,
                    addedById: OWNER,
                    tenantId: scope.tenantId,
                    organizationId: scope.organizationId,
                    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)),
                }),
            );
        }
        const agent = { id: AGENT, name: 'Builder', slug: 'builder', userId: OWNER, ...scope };
        const agents = {
            findByIdAndUser: jest.fn(async (id: string) => (id === AGENT ? agent : null)),
            findByUserIdScoped: jest.fn(async () => ({ rows: [agent], total: 1 })),
        };
        let slug = 0;
        const stub = {} as never;
        const tasksService = new TasksService(
            new TaskRepository(tasks),
            stub, // assignees
            stub, // reviewers
            stub, // approvers
            stub, // blocks
            stub, // relations
            { nextSlug: async () => ++slug } as never, // counter
            stub, // transitions
            undefined, // activityLog
            undefined, // attachments
            agents as never,
            undefined, // notifications
            undefined, // workUploads
            undefined, // works
            undefined, // missions
            undefined, // ideas
            teamRows,
            goals,
            undefined, // agentRuns
            undefined, // users
            undefined, // organizationMembers
            undefined, // tenants
            undefined, // repoConnections
            undefined, // runNowLock
            undefined, // domainEvents
            undefined, // accessPolicy
            new RecordVisibilityService(dataSource),
        );
        const transitions = {
            dispatchAgentRun: jest.fn(async () => ({
                runId: 'run-1',
                dispatched: true,
                parked: false,
            })),
        };
        const service = new GoalOrchestratorService(
            goals,
            dataSource.getRepository(GoalEvent),
            tasks,
            dataSource.getRepository(AgentRun),
            agents as never,
            tasksService,
            transitions as never,
        );
        const result = await service.advance(OWNER, goal.id);
        return { goal, result, transitions };
    }

    const ORG_SCOPE = { tenantId: TENANT, organizationId: ORG };

    it('a Team Goal files its iteration on its Team instead of the whole Organization', async () => {
        const design = await team('Design');
        const { goal, transitions } = await advance(ORG_SCOPE, { visibility: 'team' }, [design]);
        expect(goal).toMatchObject({ visibility: 'team', visibilityExplicit: false });

        expect(transitions.dispatchAgentRun).toHaveBeenCalledTimes(1);
        const [row] = await tasks.find({ where: { goalId: goal.id } });
        // Was `organization` with no Team.
        expect(row).toMatchObject({
            organizationId: ORG,
            teamId: design.id,
            visibility: 'team',
            visibilityExplicit: false,
        });
    });

    it('a Goal on two Teams files its iteration on both', async () => {
        const design = await team('Design');
        const growth = await team('Growth');
        const { goal } = await advance(ORG_SCOPE, { visibility: 'team' }, [design, growth]);

        const [row] = await tasks.find({ where: { goalId: goal.id } });
        expect(row).toMatchObject({ teamId: design.id, visibility: 'team' });
        const links = await teamResources.find({
            where: { resourceType: 'task', resourceId: row.id },
        });
        expect(links.map((link) => link.teamId)).toEqual([growth.id]);
    });

    it('an Organization Goal keeps the insert-time default', async () => {
        const { goal } = await advance(ORG_SCOPE);
        expect(goal.visibility).toBe('organization');

        const [row] = await tasks.find({ where: { goalId: goal.id } });
        expect(row).toMatchObject({
            teamId: null,
            visibility: 'organization',
            visibilityExplicit: false,
        });
    });

    it('a private Goal (even one on a Team) files a private iteration', async () => {
        const design = await team('Design');
        const { goal } = await advance(
            ORG_SCOPE,
            { visibility: 'private', visibilityExplicit: true },
            [design],
        );

        const [row] = await tasks.find({ where: { goalId: goal.id } });
        expect(row).toMatchObject({
            teamId: null,
            visibility: 'private',
            visibilityExplicit: true,
        });
    });

    it('a personal Goal files a private iteration', async () => {
        const { goal } = await advance({ tenantId: null, organizationId: null });
        expect(goal.visibility).toBe('private');

        const [row] = await tasks.find({ where: { goalId: goal.id } });
        expect(row).toMatchObject({ teamId: null, visibility: 'private' });
    });
});
