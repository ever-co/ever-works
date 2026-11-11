import { DataSource, type Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { TaskRepository } from '../../database/repositories/task.repository';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { Task } from '../../entities/task.entity';
import { TasksService } from '../../tasks-domain/tasks.service';
import { MISSION_TASK_LABEL, MissionTickService } from '../mission-tick.service';

/**
 * Prod, round 20: a Mission with Task output never filed a Task. Every attempt logged
 * `Task output on Work <id> failed (null value in column "createdByType" of relation "tasks"
 * violates not-null constraint)`, because the tick's create input carried no author and a cast
 * hid that from the compiler. The unit specs mock `TasksService.create`, so only a real insert
 * shows it: here the tick runs against the real `TasksService` and `TaskRepository` on an
 * in-memory SQLite database whose `tasks` table has the same NOT NULL author columns.
 */
describe('Mission Task output files a Task the database accepts (real SQLite)', () => {
    let dataSource: DataSource;
    let missionRows: Repository<Mission>;
    let taskRows: Repository<Task>;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    const ORG = '55555555-5555-4555-8555-555555555555';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        missionRows = dataSource.getRepository(Mission);
        taskRows = dataSource.getRepository(Task);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await taskRows.clear();
        await missionRows.clear();
    });

    async function tick(scope: { tenantId: string | null; organizationId: string | null }) {
        const mission = await missionRows.save(
            missionRows.create({
                userId: OWNER,
                title: 'Grow Bookings',
                description: 'Make Bookings the easiest way to book a class.',
                type: MissionType.ONE_SHOT,
                status: MissionStatus.ACTIVE,
                outputMode: 'tasks',
                ...scope,
            }),
        );
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
        );
        // Starting the run is the transition service's job, not under test here.
        const runTask = jest.spyOn(tasksService, 'runTask').mockResolvedValue({} as never);
        const planner = {
            plan: jest.fn(async () => [
                {
                    title: 'Add a class waitlist',
                    description: 'Done when a full class takes a waitlist.',
                },
            ]),
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
        return { mission, outcome, runTask };
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
});
