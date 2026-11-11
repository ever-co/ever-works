import { DataSource, type Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { RecordVisibilitySubscriber } from '../../database/record-visibility.subscriber';
import { TaskRepository } from '../../database/repositories/task.repository';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { Task, TaskStatus } from '../../entities/task.entity';
import { TasksService } from '../../tasks-domain/tasks.service';
import { MISSION_TASK_LABEL, MissionTickService } from '../mission-tick.service';

/**
 * Prod, 2026-11-11: a Mission with Task output filed nothing on a Work for good
 * (`works=1 filed=0 capped=1`). The Work had three standing recurring Tasks linked to the
 * Mission, and the `openTasksCap` count took every open Task carrying the Mission's id on the
 * Work — the recurring TEMPLATES too. A template is a schedule: it is never Done, so it held
 * its slot forever. Here the tick counts against a real in-memory SQLite `tasks` table, so the
 * where clause is the one the database runs.
 */
describe('Mission Task output: recurring templates do not count against the open Tasks cap (real SQLite)', () => {
    let dataSource: DataSource;
    let missionRows: Repository<Mission>;
    let taskRows: Repository<Task>;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    const WORK = '33333333-3333-4333-8333-333333333333';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            subscribers: [RecordVisibilitySubscriber],
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

    let seeded = 0;
    /** A Task already on the Work, linked to the Mission (by hand, or spawned). */
    async function seedTask(missionId: string, over: Partial<Task>): Promise<Task> {
        seeded += 1;
        return taskRows.save(
            taskRows.create({
                userId: OWNER,
                slug: `seed-${seeded}`,
                title: `Standing task ${seeded}`,
                status: TaskStatus.TODO,
                missionId,
                workId: WORK,
                createdByType: 'user',
                createdById: OWNER,
                ...over,
            }),
        );
    }

    /** A recurring template: `isRecurring`, a cadence, no parent. */
    function template(missionId: string, title: string): Promise<Task> {
        return seedTask(missionId, {
            title,
            isRecurring: true,
            recurrenceCron: '0 9 * * 1',
            recurrenceTimezone: 'UTC',
            nextOccurrenceAt: new Date(Date.now() + 86_400_000),
        });
    }

    async function setup(openTasksCap: number) {
        const mission = await missionRows.save(
            missionRows.create({
                userId: OWNER,
                title: 'Keep Bookings healthy',
                description: 'Keep Bookings fast and up to date.',
                type: MissionType.ONE_SHOT,
                status: MissionStatus.ACTIVE,
                outputMode: 'tasks',
                taskOutput: { tasksPerTick: 1, openTasksCap },
                tenantId: null,
                organizationId: null,
            }),
        );
        const work = { id: WORK, userId: OWNER, name: 'Bookings', description: 'An app.' };
        const works = {
            findById: jest.fn(async (id: string) => (id === WORK ? work : null)),
            findByIds: jest.fn(async (ids: string[]) => (ids.includes(WORK) ? [work] : [])),
        };
        let slug = 1000;
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
        jest.spyOn(tasksService, 'runTask').mockResolvedValue({} as never);
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
        return { mission, run: () => service.runOnce(mission.id, OWNER), planner };
    }

    const filedByTick = async (missionId: string) =>
        (await taskRows.find({ where: { missionId } })).filter((task) =>
            (task.labels ?? []).includes(MISSION_TASK_LABEL),
        );

    it('three standing recurring templates and no instance: not capped at cap 1, the tick files', async () => {
        const { mission, run, planner } = await setup(1);
        await template(mission.id, 'Weekly dependency update');
        await template(mission.id, 'Weekly accessibility sweep');
        await template(mission.id, 'Weekly broken-link check');

        const outcome = await run();

        expect(planner.plan).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        const filed = await filedByTick(mission.id);
        expect(filed.map((task) => task.title)).toEqual(['Add a class waitlist']);
        // The templates are untouched.
        expect(await taskRows.count({ where: { missionId: mission.id, isRecurring: true } })).toBe(
            3,
        );
    });

    it('an open instance spawned from a template still counts: capped at cap 1', async () => {
        const { mission, run, planner } = await setup(1);
        const tpl = await template(mission.id, 'Weekly dependency update');
        await template(mission.id, 'Weekly accessibility sweep');
        await seedTask(mission.id, {
            title: 'Weekly dependency update',
            parentRecurringTaskId: tpl.id,
            status: TaskStatus.IN_PROGRESS,
        });

        const outcome = await run();

        expect(planner.plan).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ tasksFiled: 0 });
        expect(await filedByTick(mission.id)).toHaveLength(0);
    });

    it('with the instance done, the slot is free again', async () => {
        const { mission, run } = await setup(1);
        const tpl = await template(mission.id, 'Weekly dependency update');
        await seedTask(mission.id, {
            title: 'Weekly dependency update',
            parentRecurringTaskId: tpl.id,
            status: TaskStatus.DONE,
        });

        expect(await run()).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
    });
});
