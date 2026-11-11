import { In, type DataSource, type Repository } from 'typeorm';
import { TaskRepository } from '../../database/repositories/task.repository';
import { DomainEventPublisher } from '../../domain-events/domain-event-publisher.service';
import { DomainEventRecorder } from '../../domain-events/domain-event-recorder.service';
import {
    createDomainEventsDataSource,
    resetDomainEventsTables,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Goal } from '../../entities/goal.entity';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { Task } from '../../entities/task.entity';
import { Team } from '../../entities/team.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import { RecordVisibilityService } from '../../record-visibility/record-visibility.service';
import { TasksService } from '../../tasks-domain/tasks.service';
import { MISSION_TASK_LABEL, MissionTickService } from '../mission-tick.service';

/**
 * Prod, round 20: a Mission with Task output never filed a Task. Every attempt logged
 * `Task output on Work <id> failed (null value in column "createdByType" of relation "tasks"
 * violates not-null constraint)`, because the tick's create input carried no author and a cast
 * hid that from the compiler. The unit specs mock `TasksService.create`, so only a real insert
 * shows it: here the tick runs against the real `TasksService` and `TaskRepository` on an
 * in-memory SQLite database whose `tasks` table has the same NOT NULL author columns.
 *
 * The filed Task also takes the Mission's privacy: it carries text planned from the Mission's
 * description, so it is never wider than the Mission. A private Mission files private Tasks (as
 * a private Goal files private iterations), a Team Mission files Tasks on its Teams that only
 * those Teams (and the Work's members) can read, and an Organization Mission's Tasks keep the
 * insert-time default. The database has `RecordVisibilitySubscriber` registered, as
 * `databaseConfig()` registers it, and the real `RecordVisibilityService`.
 */
describe('Mission Task output files a Task the database accepts (real SQLite)', () => {
    let dataSource: DataSource;
    let missionRows: Repository<Mission>;
    let taskRows: Repository<Task>;
    let teamRows: Repository<Team>;
    let teamResources: Repository<TeamResource>;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    /** Created the Teams: a Team is not the Mission owner's own, and need not be. */
    const COLLEAGUE = '22222222-2222-4222-8222-222222222222';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const OTHER_ORG = '66666666-6666-4666-8666-666666666666';

    beforeAll(async () => {
        // In-memory better-sqlite3, the whole entity inventory, `RecordVisibilitySubscriber`
        // (so org rows start `team` / `organization`) and the domain-event relay row.
        dataSource = await createDomainEventsDataSource();
        missionRows = dataSource.getRepository(Mission);
        taskRows = dataSource.getRepository(Task);
        teamRows = dataSource.getRepository(Team);
        teamResources = dataSource.getRepository(TeamResource);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await taskRows.clear();
        await missionRows.clear();
        await teamResources.clear();
        await resetDomainEventsTables(dataSource);
    });

    async function team(name: string, organizationId = ORG): Promise<Team> {
        return teamRows.save(
            teamRows.create({
                userId: COLLEAGUE,
                name,
                slug: name.toLowerCase(),
                tenantId: TENANT,
                organizationId,
            }),
        );
    }

    async function tick(
        scope: { tenantId: string | null; organizationId: string | null },
        missionOver: Partial<Mission> = {},
        opts: {
            /** The Mission's Teams (`team_resources`), in order. */
            teams?: Team[];
            /** Wire the domain-event publisher, so the create runs in one transaction. */
            events?: boolean;
            /** Runs while the planner is "thinking" (a slow model call), before anything is filed. */
            whilePlanning?: (mission: Mission) => Promise<void>;
        } = {},
    ) {
        const mission = await missionRows.save(
            missionRows.create({
                userId: OWNER,
                title: 'Grow Bookings',
                description: 'Make Bookings the easiest way to book a class.',
                type: MissionType.ONE_SHOT,
                status: MissionStatus.ACTIVE,
                outputMode: 'tasks',
                ...scope,
                ...missionOver,
            }),
        );
        for (const [index, onTeam] of (opts.teams ?? []).entries()) {
            await teamResources.save(
                teamResources.create({
                    teamId: onTeam.id,
                    resourceType: 'mission',
                    resourceId: mission.id,
                    addedById: OWNER,
                    tenantId: scope.tenantId,
                    organizationId: scope.organizationId,
                    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)),
                }),
            );
        }
        // The Work the Mission improves, as both services read it.
        const work = {
            id: WORK,
            userId: OWNER,
            name: 'Bookings',
            description: 'An app.',
            ...scope,
        };
        const works = {
            findById: jest.fn(async (id: string) => (id === WORK ? work : null)),
            findByIds: jest.fn(async (ids: string[]) => (ids.includes(WORK) ? [work] : [])),
        };
        let slug = 0;
        const stub = {} as never;
        const recorder = new DomainEventRecorder();
        const tasksService = new TasksService(
            new TaskRepository(taskRows),
            stub, // assignees
            stub, // reviewers
            stub, // approvers
            stub, // blocks
            stub, // relations
            { nextSlug: async () => ++slug } as never, // counter
            stub, // transitions
            undefined, // activityLog
            undefined, // attachments
            undefined, // agents
            undefined, // notifications
            undefined, // workUploads
            works as never,
            missionRows,
            undefined, // ideas
            teamRows,
            dataSource.getRepository(Goal),
            undefined, // agentRuns
            undefined, // users
            undefined, // organizationMembers
            undefined, // tenants
            undefined, // repoConnections
            undefined, // runNowLock
            opts.events ? new DomainEventPublisher(recorder, dataSource) : undefined,
            undefined, // accessPolicy
            new RecordVisibilityService(dataSource, recorder),
        );
        // Starting the run is the transition service's job, not under test here.
        const runTask = jest.spyOn(tasksService, 'runTask').mockResolvedValue({} as never);
        const planner = {
            plan: jest.fn(async () => {
                await opts.whilePlanning?.(mission);
                return [
                    {
                        title: 'Add a class waitlist',
                        description: 'Done when a full class takes a waitlist.',
                    },
                ];
            }),
        };
        const missionWorks = {
            listForMissionWithWork: jest.fn(async () => [
                { workId: WORK, relation: 'improves', workKind: 'app', workName: 'Bookings' },
            ]),
        };
        const service = new (MissionTickService as unknown as new (
            ...args: unknown[]
        ) => MissionTickService)(
            missionRows,
            { generate: jest.fn() }, // workProposals
            { countOutstandingByMission: jest.fn(async () => 0) }, // workProposalRepo
            {}, // workAgent
            { log: jest.fn(async () => undefined) }, // activityLog
            undefined, // ideaBuildDispatcher
            works,
            undefined, // domainEvents
            planner,
            missionWorks,
            taskRows,
            { get: jest.fn(() => tasksService) }, // moduleRef
            { track: jest.fn() }, // appWorksSink
        );
        const outcome = await service.runOnce(mission.id, OWNER);
        return { mission, outcome, runTask, tasksService };
    }

    it.each([
        ['a personal Mission', { tenantId: null, organizationId: null }],
        ['an Organization Mission', { tenantId: TENANT, organizationId: ORG }],
    ])('%s files its Task, authored by the Mission owner', async (_label, scope) => {
        const { mission, outcome, runTask } = await tick(scope);

        expect(outcome).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        const rows = await taskRows.find();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            userId: OWNER,
            title: 'Add a class waitlist',
            missionId: mission.id,
            workId: WORK,
            labels: [MISSION_TASK_LABEL],
            status: 'todo',
            createdByType: 'user',
            createdById: OWNER,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
        });
        // Filed in To do, so the tick starts it under the Mission's scope.
        expect(runTask).toHaveBeenCalledWith(
            OWNER,
            rows[0].id,
            { agentId: null },
            scope.organizationId ? scope : undefined,
        );
    });

    describe("the filed Task takes the Mission's privacy", () => {
        const ORG_SCOPE = { tenantId: TENANT, organizationId: ORG };

        it('an Organization Mission made private files a private Task, not a team / organization one', async () => {
            const { mission, outcome } = await tick(ORG_SCOPE, {
                visibility: 'private',
                visibilityExplicit: true,
            });
            expect(mission.visibility).toBe('private');

            expect(outcome).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
            const [row] = await taskRows.find();
            expect(row).toMatchObject({
                missionId: mission.id,
                organizationId: ORG,
                visibility: 'private',
                visibilityExplicit: true,
            });
        });

        it('an Organization Mission shared with the Organization keeps the insert-time default', async () => {
            const { mission, outcome } = await tick(ORG_SCOPE);
            // The same default the Task gets: an org row with no Team is `organization`.
            expect(mission.visibility).toBe('organization');

            expect(outcome).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
            const [row] = await taskRows.find();
            expect(row).toMatchObject({
                missionId: mission.id,
                organizationId: ORG,
                visibility: 'organization',
                visibilityExplicit: false,
            });
        });

        it('a Team Mission files a Task on its Team instead of the whole Organization', async () => {
            const design = await team('Design');
            const { mission, outcome } = await tick(
                ORG_SCOPE,
                { visibility: 'team' },
                {
                    teams: [design],
                },
            );
            // Shared with the Team automatically (it sits on one), not by hand.
            expect(mission).toMatchObject({ visibility: 'team', visibilityExplicit: false });

            expect(outcome).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
            const [row] = await taskRows.find();
            // Was `organization` with no Team: every member of the Organization could read a
            // Task planned from a Mission only the Team could read.
            expect(row).toMatchObject({
                missionId: mission.id,
                organizationId: ORG,
                teamId: design.id,
                visibility: 'team',
                visibilityExplicit: false,
            });
            expect(await teamResources.find({ where: { resourceType: 'task' } })).toEqual([]);
        });

        it.each([
            ['in the create transaction (domain events on)', true],
            ['after the create (no domain events)', false],
        ])(
            'a Mission on two Teams files a Task on both, the first as its teamId — %s',
            async (_label, events) => {
                const design = await team('Design');
                const growth = await team('Growth');
                const { mission } = await tick(
                    ORG_SCOPE,
                    { visibility: 'team' },
                    {
                        teams: [design, growth],
                        events,
                    },
                );

                const [row] = await taskRows.find({ where: { missionId: mission.id } });
                expect(row).toMatchObject({ teamId: design.id, visibility: 'team' });
                const links = await teamResources.find({
                    where: { resourceType: 'task', resourceId: row.id },
                });
                expect(links.map((link) => link.teamId)).toEqual([growth.id]);
                if (events) {
                    // One transaction: `task.created` already carries both Teams, then the
                    // second Team's `team.resource.added` (review 2026-10-17 F34).
                    const recorded = await dataSource.getRepository(DomainEvent).find({
                        where: { aggregateId: In([row.id, growth.id]) },
                        order: { outboxSeq: 'ASC' },
                    });
                    expect(recorded.map((event) => event.type)).toEqual([
                        'task.created',
                        'team.resource.added',
                    ]);
                    expect(recorded[0].visibility).toBe('team');
                    expect((recorded[0].data as { teamIds?: string[] }).teamIds).toEqual([
                        design.id,
                        growth.id,
                    ]);
                }
            },
        );

        it('a Mission made `team` by hand keeps the Task `team` by hand', async () => {
            const design = await team('Design');
            await tick(
                ORG_SCOPE,
                { visibility: 'team', visibilityExplicit: true },
                {
                    teams: [design],
                },
            );

            const [row] = await taskRows.find();
            expect(row).toMatchObject({
                teamId: design.id,
                visibility: 'team',
                visibilityExplicit: true,
            });
        });

        it('a private Mission that sits on a Team still files a private Task (private wins)', async () => {
            const design = await team('Design');
            await tick(
                ORG_SCOPE,
                { visibility: 'private', visibilityExplicit: true },
                {
                    teams: [design],
                },
            );

            const [row] = await taskRows.find();
            expect(row).toMatchObject({
                teamId: null,
                visibility: 'private',
                visibilityExplicit: true,
            });
            expect(await teamResources.find({ where: { resourceType: 'task' } })).toEqual([]);
        });

        it("follows the Mission's visibility as it is when the Task is filed, not when the tick began", async () => {
            const design = await team('Design');
            // Made private by hand while the planner ran: the Task is private, not `organization`.
            await tick(
                ORG_SCOPE,
                {},
                {
                    whilePlanning: (mission) =>
                        missionRows
                            .update(
                                { id: mission.id },
                                { visibility: 'private', visibilityExplicit: true },
                            )
                            .then(() => undefined),
                },
            );
            const [privateRow] = await taskRows.find();
            expect(privateRow).toMatchObject({ visibility: 'private', visibilityExplicit: true });

            await taskRows.clear();
            await missionRows.clear();
            // Put on a Team while the planner ran: the Task sits on that Team.
            await tick(
                ORG_SCOPE,
                {},
                {
                    whilePlanning: async (mission) => {
                        await teamResources.save(
                            teamResources.create({
                                teamId: design.id,
                                resourceType: 'mission',
                                resourceId: mission.id,
                                addedById: OWNER,
                                tenantId: TENANT,
                                organizationId: ORG,
                                createdAt: new Date(),
                            }),
                        );
                        await missionRows.update({ id: mission.id }, { visibility: 'team' });
                    },
                },
            );
            const [teamRow] = await taskRows.find();
            expect(teamRow).toMatchObject({ teamId: design.id, visibility: 'team' });
        });

        it('a `team` Mission on no Team files a `team` Task on no Team, by hand, so it never widens', async () => {
            // A Team of another Organization is never used (and never makes the Task wider).
            const foreign = await team('Elsewhere', OTHER_ORG);
            await tick(
                ORG_SCOPE,
                { visibility: 'team', visibilityExplicit: true },
                {
                    teams: [foreign],
                },
            );

            const [row] = await taskRows.find();
            expect(row).toMatchObject({
                teamId: null,
                visibility: 'team',
                visibilityExplicit: true,
            });
            expect(await teamResources.find({ where: { resourceType: 'task' } })).toEqual([]);
        });

        it("never reads another account's record onto a Task (the source must be the Task owner's)", async () => {
            const design = await team('Design');
            const { mission, tasksService } = await tick(
                ORG_SCOPE,
                { visibility: 'team' },
                {
                    teams: [design],
                },
            );
            await taskRows.clear();

            // A Task of somebody else naming that Mission as its source: the Mission's Teams are
            // not read, and the Task gets the insert-time default it would get without a source.
            const task = await tasksService.create(
                COLLEAGUE,
                {
                    title: 'Unrelated',
                    createdByType: 'user',
                    createdById: COLLEAGUE,
                    derivedFrom: { aggregate: 'mission', id: mission.id },
                },
                ORG_SCOPE,
            );
            const row = await taskRows.findOneByOrFail({ id: task.id });
            expect(row).toMatchObject({ teamId: null, visibility: 'organization' });
        });

        describe("a sub-task of a Task filed on a colleague's Team (review of #3165)", () => {
            /** What the web form's "Add sub-task" sends: the parent's six owners. */
            function subTask(parent: Task, teamId: string | null) {
                return {
                    title: 'Write the waitlist email',
                    parentTaskId: parent.id,
                    workId: parent.workId ?? null,
                    missionId: parent.missionId ?? null,
                    ideaId: parent.ideaId ?? null,
                    teamId,
                    agentId: parent.agentId ?? null,
                    goalId: parent.goalId ?? null,
                    createdByType: 'user' as const,
                    createdById: OWNER,
                };
            }

            it("is created on the parent's Team, which the Mission owner does not own", async () => {
                const design = await team('Design');
                const { tasksService } = await tick(
                    ORG_SCOPE,
                    { visibility: 'team' },
                    {
                        teams: [design],
                    },
                );
                const [parent] = await taskRows.find();
                expect(parent.teamId).toBe(design.id);

                // Was `Team <id> not found.`: the Team-ownership check wants the caller's own Team.
                const child = await tasksService.create(
                    OWNER,
                    subTask(parent, parent.teamId ?? null),
                    ORG_SCOPE,
                );
                expect(await taskRows.findOneByOrFail({ id: child.id })).toMatchObject({
                    parentTaskId: parent.id,
                    teamId: design.id,
                    organizationId: ORG,
                    visibility: 'team',
                });
            });

            it("still refuses a sub-task naming another colleague's Team", async () => {
                const design = await team('Design');
                const growth = await team('Growth');
                const { tasksService } = await tick(
                    ORG_SCOPE,
                    { visibility: 'team' },
                    {
                        teams: [design],
                    },
                );
                const [parent] = await taskRows.find();

                await expect(
                    tasksService.create(OWNER, subTask(parent, growth.id), ORG_SCOPE),
                ).rejects.toThrow(`Team ${growth.id} not found.`);
                expect(await taskRows.count()).toBe(1);
            });

            it("refuses the parent's Team for a sub-task stamped into another Organization", async () => {
                const design = await team('Design');
                const { tasksService } = await tick(
                    ORG_SCOPE,
                    { visibility: 'team' },
                    {
                        teams: [design],
                    },
                );
                const [parent] = await taskRows.find();

                // No request scope (so the parent is found by its owner alone), but the new row
                // would be written into OTHER_ORG: the parent's Team does not vouch for that.
                await expect(
                    tasksService.create(OWNER, subTask(parent, design.id), undefined, {
                        ownershipStamp: { tenantId: TENANT, organizationId: OTHER_ORG },
                    }),
                ).rejects.toThrow(`Team ${design.id} not found.`);
                expect(await taskRows.count()).toBe(1);
            });

            it("still refuses a Task (not a sub-task) naming a colleague's Team", async () => {
                const design = await team('Design');
                const { tasksService } = await tick(
                    ORG_SCOPE,
                    { visibility: 'team' },
                    {
                        teams: [design],
                    },
                );

                await expect(
                    tasksService.create(
                        OWNER,
                        {
                            title: 'On their Team',
                            teamId: design.id,
                            createdByType: 'user',
                            createdById: OWNER,
                        },
                        ORG_SCOPE,
                    ),
                ).rejects.toThrow(`Team ${design.id} not found.`);
            });
        });

        it('a personal Mission (private by default) files a private Task', async () => {
            const { mission } = await tick({ tenantId: null, organizationId: null });
            expect(mission.visibility).toBe('private');

            const [row] = await taskRows.find();
            expect(row).toMatchObject({ visibility: 'private', visibilityExplicit: true });
        });
    });
});
