import { DataSource, type Repository } from 'typeorm';
import {
    combineBothOutcomes,
    describeMissionNothingToFile,
    missionActiveRunExists,
    missionOpenTasksWhere,
    MissionTickService,
} from '../mission-tick.service';
import { ENTITIES } from '../../database/_entities-inventory';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { Task } from '../../entities/task.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

/**
 * APW-08 T35 (FR-51…FR-54; ACC-08-26) — the Mission tick's Task branch, through `runOnce`:
 * `ideas` untouched; `tasks` / `both`; the open-Tasks cap and the per-tick count; duplicate open
 * titles dropped; Backlog when the Mission requires approval, otherwise To do and started; at most
 * five Works; the once-per-day "nothing to file" notice.
 *
 * Plus Repository Works: one with Task isolation on is filed on and started like an App Work; one
 * with isolation off gets nothing and the Mission says so; every other kind is still left alone;
 * the App-changes switch pauses App Works only; and a Task whose pull request was closed without
 * merging does not hold a slot of the open-Tasks cap.
 */

type Row = Record<string, unknown>;

const NOW_DAY_1 = new Date('2026-10-31T10:00:00.000Z');

/**
 * A TypeORM `where`, evaluated the way SQL does: an array is OR-ed branches, and a comparison
 * against NULL is never true — `Not(In([...]))` drops a NULL column, only `IsNull()` matches it.
 * The one `Raw` operator the cap uses (`missionActiveRunExists`, on `id`) is "a run of this Task
 * is queued or running", modelled by the row's test-only `activeRun` flag; its SQL is pinned by
 * the real-metadata case below.
 */
function matches(row: Row, where: Row | Row[]): boolean {
    if (Array.isArray(where)) return where.some((branch) => matches(row, branch));
    return Object.entries(where).every(([key, expected]) => {
        const value = row[key] ?? null;
        if (expected && typeof expected === 'object' && '_type' in (expected as object)) {
            const op = expected as { _type: string; _value: unknown };
            if (op._type === 'isNull') return value === null;
            if (op._type === 'not') {
                const inner = op._value as { _type: string; _value: unknown[] };
                return value !== null && !inner._value.includes(value);
            }
            if (op._type === 'in') return (op._value as unknown[]).includes(value);
            if (op._type === 'moreThanOrEqual') {
                return (
                    value !== null &&
                    new Date(value as string).getTime() >= new Date(op._value as string).getTime()
                );
            }
            if (op._type === 'raw') return key === 'id' && row.activeRun === true;
        }
        return row[key] === expected;
    });
}

function build(
    missionOver: Partial<Mission> = {},
    relations: Array<{
        workId: string;
        relation: string;
        workKind: string | null;
        workName?: string;
        /** The Work's Task isolation setting (`worktree` = on); absent = off, the default. */
        workTaskIsolation?: string | null;
    }> = [{ workId: 'w-1', relation: 'improves', workKind: 'app', workName: 'Bookings' }],
) {
    const mission = {
        id: 'm1',
        userId: 'u1',
        title: 'Grow Bookings',
        description: 'Make Bookings the easiest way to book a class.',
        type: MissionType.ONE_SHOT,
        status: MissionStatus.ACTIVE,
        schedule: null,
        outputMode: 'tasks',
        taskOutput: null,
        guardrailsOverride: null,
        taskOutputNoticeAt: null,
        tenantId: null,
        organizationId: null,
        ...missionOver,
    } as unknown as Mission;
    // The Task-output lease (review of #3061): a compare-and-set on
    // `taskOutputLeaseUntil`, modelled on the one Mission row.
    const leaseWrites: Array<{ set: Row; params: Row }> = [];
    const createQueryBuilder = jest.fn(() => {
        const state: { set: Row; params: Row } = { set: {}, params: {} };
        const qb = {
            update: () => qb,
            set: (patch: Row) => {
                state.set = patch;
                return qb;
            },
            where: (_clause: string, params: Row = {}) => {
                Object.assign(state.params, params);
                return qb;
            },
            andWhere: (_clause: string, params: Row = {}) => {
                Object.assign(state.params, params);
                return qb;
            },
            execute: jest.fn(async () => {
                leaseWrites.push({ set: { ...state.set }, params: { ...state.params } });
                const held = (mission as unknown as Row).taskOutputLeaseUntil as Date | null;
                const next = state.set.taskOutputLeaseUntil as Date | null;
                if (next instanceof Date && 'held' in state.params) {
                    // A renewal: only the instant this tick last set.
                    if (!held || held.getTime() !== state.params.held) return { affected: 0 };
                    (mission as unknown as Row).taskOutputLeaseUntil = next;
                    return { affected: 1 };
                }
                if (next instanceof Date) {
                    const now = state.params.now as number;
                    if (held && held.getTime() >= now) return { affected: 0 };
                    (mission as unknown as Row).taskOutputLeaseUntil = next;
                    return { affected: 1 };
                }
                if (held && held.getTime() === state.params.held) {
                    (mission as unknown as Row).taskOutputLeaseUntil = null;
                    return { affected: 1 };
                }
                return { affected: 0 };
            }),
        };
        return qb;
    });
    const missionRepo = {
        findOne: jest.fn(async () => mission),
        update: jest.fn(async (_where: Row, patch: Row) => {
            Object.assign(mission, patch);
            return { affected: 1 };
        }),
        createQueryBuilder,
        manager: { connection: { driver: { escape: (name: string) => `"${name}"` } } },
    };
    const proposals = { generate: jest.fn(async () => ({ status: 'generated', proposals: [] })) };
    const proposalRepo = { countOutstandingByMission: jest.fn(async () => 0) };
    const activityLog = { log: jest.fn(async () => undefined) };
    const works = {
        findById: jest.fn(async (id: string) => ({
            id,
            name: `Work ${id}`,
            description: 'An app.',
        })),
    };
    const taskRows: Row[] = [];
    const taskRepo = {
        find: jest.fn(async () => {
            throw new Error('the tick must not read Task rows past the visibility predicate');
        }),
        count: jest.fn(
            async (opts: { where: Row | Row[] }) =>
                taskRows.filter((row) => matches(row, opts.where)).length,
        ),
    };
    const planner = {
        plan: jest.fn(async (input: { count: number; work: { id: string } }) =>
            Array.from({ length: input.count }, (_, i) => ({
                title: `Improve ${input.work.id} step ${i + 1}`,
                description: 'Done when it ships.',
            })),
        ),
    };
    let created = 0;
    const tasksService = {
        create: jest.fn(async (_userId: string, input: Row) => {
            // `tasks.createdByType` / `tasks.createdById` are NOT NULL: refused here as the
            // database refuses them, so a create input without its author never passes a mock.
            if (!input.createdByType || !input.createdById) {
                throw new Error(
                    'null value in column "createdByType" of relation "tasks" violates not-null constraint',
                );
            }
            const task = { id: `t-${++created}`, ...input };
            taskRows.push({ ...task, status: input.status });
            return task;
        }),
        runTask: jest.fn(async () => ({ dispatched: true })),
        // The rule dispatch applies to a Mission's unattended Task on a Repository Work, asked
        // before planning with the Agent `runTask` will resolve. `null` = it may run.
        missionRepoRunRefusalForNewTask: jest.fn(
            async (_userId: string, _input: { workId: string }): Promise<string | null> => null,
        ),
        // The Tasks list's visibility predicate, modelled: the owner's own rows, and other
        // people's rows unless they are private.
        list: jest.fn(
            async (
                userId: string,
                filter: { workId?: string; status?: string[]; orderBy?: string; limit?: number },
            ) => {
                let rows = taskRows.filter(
                    (row) =>
                        row.workId === filter.workId &&
                        (!filter.status || filter.status.includes(row.status as string)) &&
                        ((row.userId ?? userId) === userId || row.visibility !== 'private'),
                );
                if (filter.orderBy === 'createdAt') rows = [...rows].reverse();
                return { rows: rows.slice(0, filter.limit ?? 50), total: rows.length };
            },
        ),
    };
    const moduleRef = { get: jest.fn(() => tasksService) };
    const sink = { track: jest.fn() };
    const missionWorks = { listForMissionWithWork: jest.fn(async () => relations) };
    // The Agents the Mission's owner can still use (review of #3061).
    const reachableAgents = new Set<string>(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    const agentRows = {
        findOne: jest.fn(async (opts: { where: { id: string } }) =>
            reachableAgents.has(opts.where.id) ? { id: opts.where.id } : null,
        ),
    };

    const service = new (MissionTickService as unknown as new (
        ...args: unknown[]
    ) => MissionTickService)(
        missionRepo as unknown as Repository<Mission>,
        proposals,
        proposalRepo,
        {}, // workAgent
        activityLog,
        undefined, // ideaBuildDispatcher
        works,
        undefined, // domainEvents
        planner,
        missionWorks,
        taskRepo,
        moduleRef,
        sink,
        agentRows,
    );
    return {
        service,
        mission,
        missionRepo,
        proposals,
        activityLog,
        planner,
        tasksService,
        taskRows,
        sink,
        missionWorks,
        taskRepo,
        leaseWrites,
        reachableAgents,
    };
}

const nothingToFile = (activityLog: { log: jest.Mock }) =>
    activityLog.log.mock.calls.filter(
        ([entry]) => (entry as Row).actionType === ActivityActionType.MISSION_NOTHING_TO_FILE,
    );

describe('MissionTickService — Task output (APW-08 T35)', () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW_DAY_1);
    });
    afterEach(() => jest.useRealTimers());

    it('an `ideas` Mission is untouched: the planner is never asked, no Task is filed', async () => {
        const t = build({ outputMode: 'ideas' } as Partial<Mission>);
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.proposals.generate).toHaveBeenCalledTimes(1);
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(t.tasksService.create).not.toHaveBeenCalled();
        expect(result.tasksFiled).toBeUndefined();
    });

    it('a `tasks` Mission files on its App Work in To do, with the Mission, the Work and the label, and starts it', async () => {
        const t = build();
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.proposals.generate).not.toHaveBeenCalled();
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        expect(t.tasksService.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                missionId: 'm1',
                workId: 'w-1',
                labels: ['mission-task'],
                status: 'todo',
            }),
            undefined,
            { ownershipStamp: { tenantId: null, organizationId: null } },
        );
        expect(t.tasksService.runTask).toHaveBeenCalledWith(
            'u1',
            't-1',
            { agentId: null },
            undefined,
        );
        expect(t.sink.track).toHaveBeenCalledWith(
            'u1',
            'mission.task_output.tick',
            expect.objectContaining({ missionId: 'm1', worksConsidered: 1, tasksFiled: 1 }),
        );
    });

    // Prod, round 20: every Task-output tick failed on `tasks.createdByType` NOT NULL, because the
    // create input carried no author. A Mission files on behalf of its owner, as a Goal does.
    it.each([
        ['a personal Mission', {}, undefined],
        [
            'an Organization Mission',
            { tenantId: 'ten-1', organizationId: 'org-1' },
            { tenantId: 'ten-1', organizationId: 'org-1' },
        ],
    ])(
        '%s files every Task as its owner (createdByType user, createdById the owner)',
        async (_label, scope, relationScope) => {
            const t = build({ userId: 'owner-1', ...scope } as Partial<Mission>);
            const result = await t.service.runOnce('m1', 'owner-1');
            expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
            expect(t.tasksService.create).toHaveBeenCalledTimes(1);
            const call = t.tasksService.create.mock.calls[0] as unknown[];
            expect(call[0]).toBe('owner-1');
            expect(call[1]).toMatchObject({ createdByType: 'user', createdById: 'owner-1' });
            expect(call[2]).toEqual(relationScope);
        },
    );

    // Review of #3061 — the per-run cap is resolved by `dispatchAgentRun` from the Task's Mission
    // for EVERY run of it, so the tick passes none of its own (pinned in the transition spec).
    it('leaves the Mission’s per-run budget to the dispatch path (FR-53)', async () => {
        const t = build({ guardrailsOverride: { maxBudgetCentsPerRun: 1500 } } as Partial<Mission>);
        await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.runTask).toHaveBeenCalledWith(
            'u1',
            't-1',
            { agentId: null },
            undefined,
        );
    });

    it('counts the Mission’s open Tasks on the Work in SQL, never by reading rows', async () => {
        const t = build();
        await t.service.runOnce('m1', 'u1');
        // Six OR-ed branches (see `missionOpenTasksWhere`), each scoped to this Mission's Tasks
        // on this Work.
        const scoped = expect.objectContaining({ workId: 'w-1', missionId: 'm1' });
        expect(t.taskRepo.count).toHaveBeenCalledWith({
            where: [scoped, scoped, scoped, scoped, scoped, scoped],
        });
        expect(t.taskRepo.find).not.toHaveBeenCalled();
    });

    it('never puts a colleague’s private Task in the planner prompt (review of #3061)', async () => {
        const t = build({ taskOutput: { tasksPerTick: 2, openTasksCap: 10 } } as Partial<Mission>);
        t.taskRows.push(
            { id: 'mine', workId: 'w-1', userId: 'u1', status: 'todo', title: 'My own Task' },
            {
                id: 'secret',
                workId: 'w-1',
                userId: 'u2',
                visibility: 'private',
                status: 'todo',
                title: 'Colleague secret plan',
            },
            {
                id: 'shared',
                workId: 'w-1',
                userId: 'u3',
                visibility: 'organization',
                status: 'todo',
                title: 'Shared roadmap item',
            },
        );
        await t.service.runOnce('m1', 'u1');
        const titles = (
            t.planner.plan.mock.calls[0][0] as unknown as { recentTaskTitles: string[] }
        ).recentTaskTitles;
        expect(titles).toEqual(expect.arrayContaining(['My own Task', 'Shared roadmap item']));
        expect(titles).not.toContain('Colleague secret plan');
        for (const [userId, filter] of t.tasksService.list.mock.calls) {
            expect(userId).toBe('u1');
            expect(filter).toMatchObject({ workId: 'w-1', view: 'organization' });
        }
    });

    it('while App changes are paused (T49) it asks no planner and files nothing', async () => {
        const previous = process.env.EVER_WORKS_APP_CHANGES_ENABLED;
        process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';
        try {
            const t = build();
            const result = await t.service.runOnce('m1', 'u1');
            expect(result).toMatchObject({
                outcome: 'no-tasks',
                tasksFiled: 0,
                message: 'app-changes-paused',
            });
            expect(t.planner.plan).not.toHaveBeenCalled();
            expect(t.tasksService.create).not.toHaveBeenCalled();
            expect(nothingToFile(t.activityLog)).toHaveLength(0);
        } finally {
            if (previous === undefined) delete process.env.EVER_WORKS_APP_CHANGES_ENABLED;
            else process.env.EVER_WORKS_APP_CHANGES_ENABLED = previous;
        }
    });

    it('holds the Mission’s lease while it files and gives it back after', async () => {
        const t = build();
        await t.service.runOnce('m1', 'u1');
        // Claim, renew before the Work's planner call, renew before filing, release.
        expect(t.leaseWrites).toHaveLength(4);
        expect(t.leaseWrites[0].set.taskOutputLeaseUntil).toBeInstanceOf(Date);
        expect(t.leaseWrites[0].params).toHaveProperty('now');
        expect(t.leaseWrites[1].params).toHaveProperty('held');
        expect(t.leaseWrites[2].params).toHaveProperty('held');
        // A tick is not an edit: `updatedAt` keeps its value.
        for (const write of t.leaseWrites) expect(typeof write.set.updatedAt).toBe('function');
        expect(t.leaseWrites[3].set.taskOutputLeaseUntil).toBeNull();
        expect((t.mission as unknown as Row).taskOutputLeaseUntil).toBeNull();
    });

    it('a lease taken over while the planner ran files nothing (review of #3061)', async () => {
        const t = build({}, [
            { workId: 'w-1', relation: 'improves', workKind: 'app' },
            { workId: 'w-2', relation: 'improves', workKind: 'app' },
        ]);
        t.planner.plan.mockImplementationOnce(
            async (input: { count: number; work: { id: string } }) => {
                // The planner outlived the lease and another tick claimed it.
                (t.mission as unknown as Row).taskOutputLeaseUntil = new Date(Date.now() + 1);
                return [{ title: `Improve ${input.work.id}`, description: '' }];
            },
        );
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.create).not.toHaveBeenCalled();
        // The remaining Works wait for the next tick; no "nothing to file" notice either.
        expect(t.planner.plan).toHaveBeenCalledTimes(1);
        expect(result.message).toContain('lease-lost');
        expect(nothingToFile(t.activityLog)).toHaveLength(0);
    });

    it('a Work detached while the planner ran gets no Task (review of #3061)', async () => {
        const t = build();
        t.planner.plan.mockImplementationOnce(async () => {
            t.missionWorks.listForMissionWithWork.mockResolvedValue([]);
            return [{ title: 'Add a waitlist', description: '' }];
        });
        await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.create).not.toHaveBeenCalled();
    });

    it('an Agent the owner can no longer use falls back to the Work’s default (review of #3061)', async () => {
        const gone = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const t = build({
            taskOutput: { tasksPerTick: 1, openTasksCap: 3, agentId: gone },
        } as Partial<Mission>);
        await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.create).toHaveBeenCalledTimes(1);
        expect(t.tasksService.create.mock.calls[0][1]).not.toHaveProperty('agentId');
        expect(t.tasksService.runTask).toHaveBeenCalledWith(
            'u1',
            't-1',
            { agentId: null },
            undefined,
        );

        const kept = build({
            taskOutput: {
                tasksPerTick: 1,
                openTasksCap: 3,
                agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            },
        } as Partial<Mission>);
        await kept.service.runOnce('m1', 'u1');
        expect(kept.tasksService.create.mock.calls[0][1]).toMatchObject({
            agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        });
    });

    it('a failed notice write leaves the day unstamped, so the next tick records it (review of #3061)', async () => {
        const t = build({}, [{ workId: 'w-site', relation: 'improves', workKind: 'directory' }]);
        t.activityLog.log.mockRejectedValueOnce(new Error('db down'));
        await t.service.runOnce('m1', 'u1');
        expect(t.mission.taskOutputNoticeAt).toBeNull();
        await t.service.runOnce('m1', 'u1');
        expect(nothingToFile(t.activityLog)).toHaveLength(2);
        expect(t.mission.taskOutputNoticeAt).toEqual(NOW_DAY_1);
    });

    it('a tick that finds the lease held files nothing and asks no planner', async () => {
        const t = build();
        (t.mission as unknown as Row).taskOutputLeaseUntil = new Date(Date.now() + 60_000);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'no-tasks', message: 'task-output-busy' });
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(t.tasksService.create).not.toHaveBeenCalled();
    });

    it('two overlapping ticks (Run now + the schedule) never both file up to the cap', async () => {
        const t = build({ taskOutput: { tasksPerTick: 3, openTasksCap: 3 } } as Partial<Mission>);
        const [first, second] = await Promise.all([
            t.service.runOnce('m1', 'u1'),
            t.service.runOnce('m1', 'u1'),
        ]);
        expect([first.tasksFiled, second.tasksFiled].sort()).toEqual([0, 3]);
        expect(t.tasksService.create).toHaveBeenCalledTimes(3);
        expect(t.planner.plan).toHaveBeenCalledTimes(1);
    });

    it('a lease that cannot be written files nothing (fail closed)', async () => {
        const t = build();
        t.missionRepo.createQueryBuilder.mockImplementation(() => {
            throw new Error('db down');
        });
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'no-tasks', message: 'task-output-busy' });
        expect(t.planner.plan).not.toHaveBeenCalled();
    });

    it('requires approval before creating: filed in Backlog, never started (ACC-08-26)', async () => {
        const t = build({
            guardrailsOverride: { requireApprovalBeforeCreate: true },
            taskOutput: { tasksPerTick: 3, openTasksCap: 10 },
        } as Partial<Mission>);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result.tasksFiled).toBe(3);
        for (const [, input] of t.tasksService.create.mock.calls) {
            expect((input as Row).status).toBe('backlog');
        }
        expect(t.tasksService.runTask).not.toHaveBeenCalled();
    });

    it('never past the open-Tasks cap: at the cap nothing is filed; below it only the headroom', async () => {
        const capped = build({
            taskOutput: { tasksPerTick: 3, openTasksCap: 2 },
        } as Partial<Mission>);
        capped.taskRows.push(
            { id: 'o1', workId: 'w-1', missionId: 'm1', status: 'todo', title: 'A' },
            { id: 'o2', workId: 'w-1', missionId: 'm1', status: 'in_review', title: 'B' },
            // Not the Mission's: does not count against its cap.
            { id: 'o3', workId: 'w-1', missionId: 'other', status: 'todo', title: 'C' },
        );
        expect((await capped.service.runOnce('m1', 'u1')).tasksFiled).toBe(0);
        expect(capped.planner.plan).not.toHaveBeenCalled();

        const headroom = build({
            taskOutput: { tasksPerTick: 3, openTasksCap: 3 },
        } as Partial<Mission>);
        headroom.taskRows.push(
            { id: 'o1', workId: 'w-1', missionId: 'm1', status: 'todo', title: 'A' },
            { id: 'o2', workId: 'w-1', missionId: 'm1', status: 'done', title: 'B' },
            { id: 'o3', workId: 'w-1', missionId: 'm1', status: 'blocked', title: 'C' },
        );
        expect((await headroom.service.runOnce('m1', 'u1')).tasksFiled).toBe(1);
        expect(headroom.planner.plan.mock.calls[0][0]).toMatchObject({ count: 1 });
    });

    it('drops a proposal whose normalised title equals an open Task’s title on that Work', async () => {
        const t = build({ taskOutput: { tasksPerTick: 2, openTasksCap: 10 } } as Partial<Mission>);
        t.taskRows.push({
            id: 'o1',
            workId: 'w-1',
            missionId: null,
            status: 'todo',
            title: 'Add  online CANCELLATION!',
        });
        t.planner.plan.mockResolvedValueOnce([
            { title: 'add online cancellation', description: '' },
            { title: 'Send reminder emails', description: '' },
        ]);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result.tasksFiled).toBe(1);
        expect(t.tasksService.create.mock.calls[0][1]).toMatchObject({
            title: 'Send reminder emails',
        });
        expect(t.sink.track.mock.calls[0][2]).toMatchObject({ skippedDuplicate: 1 });
    });

    it('files on at most five Works, only App Works attached as Improves or Operates', async () => {
        const relations = [
            ...Array.from({ length: 7 }, (_, i) => ({
                workId: `w-${i + 1}`,
                relation: i % 2 ? 'operates' : 'improves',
                workKind: 'app',
            })),
            { workId: 'w-site', relation: 'improves', workKind: 'directory' },
            { workId: 'w-mkt', relation: 'markets', workKind: 'app' },
        ];
        const t = build({}, relations);
        await t.service.runOnce('m1', 'u1');
        const planned = t.planner.plan.mock.calls.map(
            ([input]) => (input as { work: { id: string } }).work.id,
        );
        expect(planned).toEqual(['w-1', 'w-2', 'w-3', 'w-4', 'w-5']);
        expect(t.planner.plan.mock.calls[1][0]).toMatchObject({ relation: 'operates' });
    });

    it('one Work’s planner failure never stops the others or fails the Mission', async () => {
        const t = build({}, [
            { workId: 'w-1', relation: 'improves', workKind: 'app' },
            { workId: 'w-2', relation: 'improves', workKind: 'app' },
        ]);
        t.planner.plan.mockRejectedValueOnce(new Error('model down'));
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        expect(t.mission.status).toBe(MissionStatus.ACTIVE);
    });

    it('no App or Repository Work to file on: ONE notice per Mission per day, stamped on the Mission (FR-54, S27)', async () => {
        const t = build({}, [{ workId: 'w-site', relation: 'improves', workKind: 'directory' }]);
        expect(await t.service.runOnce('m1', 'u1')).toMatchObject({
            outcome: 'no-tasks',
            tasksFiled: 0,
            message: 'no-app-work',
        });
        await t.service.runOnce('m1', 'u1');
        expect(nothingToFile(t.activityLog)).toHaveLength(1);
        expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
            details: expect.objectContaining({
                reason: 'no-app-work',
                message: 'No attached App or Repository Work to file Tasks on.',
            }),
        });
        expect(t.mission.taskOutputNoticeAt).toEqual(NOW_DAY_1);

        jest.setSystemTime(new Date('2026-11-01T09:00:00.000Z'));
        await t.service.runOnce('m1', 'u1');
        expect(nothingToFile(t.activityLog)).toHaveLength(2);
        expect(
            t.sink.track.mock.calls.filter(
                ([, event]) => event === 'mission.task_output.nothing_to_file',
            ),
        ).toHaveLength(2);
    });

    // ── Repository Works ────────────────────────────────────────────────────────────────

    it('a Repository Work with Task isolation on gets a Task and a run, like an App Work', async () => {
        const t = build({}, [
            {
                workId: 'w-repo',
                relation: 'improves',
                workKind: 'repo',
                workName: 'ever-works',
                workTaskIsolation: 'worktree',
            },
        ]);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        // The planner is told it plans for an existing repository.
        expect(t.planner.plan).toHaveBeenCalledTimes(1);
        expect(t.planner.plan.mock.calls[0][0]).toMatchObject({
            relation: 'improves',
            work: { id: 'w-repo', kind: 'repo' },
        });
        expect(t.tasksService.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                missionId: 'm1',
                workId: 'w-repo',
                labels: ['mission-task'],
                status: 'todo',
            }),
            undefined,
            { ownershipStamp: { tenantId: null, organizationId: null } },
        );
        expect(t.tasksService.runTask).toHaveBeenCalledWith(
            'u1',
            't-1',
            { agentId: null },
            undefined,
        );
        expect(nothingToFile(t.activityLog)).toHaveLength(0);
    });

    it('an App Work is still planned as an app', async () => {
        const t = build();
        await t.service.runOnce('m1', 'u1');
        expect(t.planner.plan.mock.calls[0][0]).toMatchObject({ work: { id: 'w-1', kind: 'app' } });
    });

    it('a Repository Work is filed on under the same caps, approval rule and duplicate check', async () => {
        const t = build(
            {
                guardrailsOverride: { requireApprovalBeforeCreate: true },
                taskOutput: { tasksPerTick: 3, openTasksCap: 2 },
            } as Partial<Mission>,
            [
                {
                    workId: 'w-repo',
                    relation: 'operates',
                    workKind: 'repo',
                    workTaskIsolation: 'worktree',
                },
            ],
        );
        t.taskRows.push({
            id: 'o1',
            workId: 'w-repo',
            missionId: null,
            status: 'todo',
            title: 'Update the lockfile',
        });
        t.planner.plan.mockResolvedValueOnce([
            { title: 'update the LOCKFILE', description: '' },
            { title: 'Bump the base image', description: '' },
            { title: 'Fix the flaky spec', description: '' },
        ]);
        const result = await t.service.runOnce('m1', 'u1');
        // openTasksCap 2 → the planner is asked for 2; one is a duplicate of an open title.
        expect(t.planner.plan.mock.calls[0][0]).toMatchObject({ count: 2, relation: 'operates' });
        expect(result.tasksFiled).toBe(2);
        expect(t.tasksService.create.mock.calls.map(([, input]) => (input as Row).title)).toEqual([
            'Bump the base image',
            'Fix the flaky spec',
        ]);
        for (const [, input] of t.tasksService.create.mock.calls) {
            expect((input as Row).status).toBe('backlog');
        }
        expect(t.tasksService.runTask).not.toHaveBeenCalled();
    });

    it('a Repository Work with Task isolation off gets no Task, no planner call, and the day’s notice says why', async () => {
        const t = build({}, [
            {
                workId: 'w-repo',
                relation: 'improves',
                workKind: 'repo',
                workName: 'ever-works',
                workTaskIsolation: 'off',
            },
        ]);
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({
            outcome: 'no-tasks',
            tasksFiled: 0,
            message: 'repo-isolation-off',
        });
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(t.tasksService.create).not.toHaveBeenCalled();
        expect(t.tasksService.runTask).not.toHaveBeenCalled();
        // Once a day, like every "nothing to file" notice — and it names the Work and the fix.
        await t.service.runOnce('m1', 'u1');
        expect(nothingToFile(t.activityLog)).toHaveLength(1);
        expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
            details: expect.objectContaining({
                reason: 'repo-isolation-off',
                message:
                    'Nothing filed. Task isolation is off on the attached Repository Work "ever-works", ' +
                    "so no Tasks are filed there. Turn on Task isolation in the Work's settings to let " +
                    'this Mission file Tasks on it.',
            }),
        });
        expect(t.mission.taskOutputNoticeAt).toEqual(NOW_DAY_1);
    });

    it('a Repository Work whose isolation setting is missing is treated as off (nothing is forced on)', async () => {
        const t = build({}, [{ workId: 'w-repo', relation: 'operates', workKind: 'repo' }]);
        expect(await t.service.runOnce('m1', 'u1')).toMatchObject({
            outcome: 'no-tasks',
            message: 'repo-isolation-off',
        });
        expect(t.tasksService.create).not.toHaveBeenCalled();
    });

    it('files on the eligible Works and skips the Repository Work with isolation off', async () => {
        const t = build({}, [
            { workId: 'w-app', relation: 'improves', workKind: 'app' },
            {
                workId: 'w-off',
                relation: 'improves',
                workKind: 'repo',
                workName: 'website',
                workTaskIsolation: 'off',
            },
            {
                workId: 'w-on',
                relation: 'operates',
                workKind: 'repo',
                workTaskIsolation: 'worktree',
            },
        ]);
        const result = await t.service.runOnce('m1', 'u1');
        expect(
            t.planner.plan.mock.calls.map(([input]) => (input as { work: { id: string } }).work.id),
        ).toEqual(['w-app', 'w-on']);
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 2 });
        expect(result.message).toContain('works=2');
        expect(result.message).toContain('isolation-off=1');
        expect(t.tasksService.create.mock.calls.map(([, input]) => (input as Row).workId)).toEqual([
            'w-app',
            'w-on',
        ]);
    });

    it('when nothing new is filed, the notice also names the Repository Work that was skipped', async () => {
        const t = build({ taskOutput: { tasksPerTick: 1, openTasksCap: 1 } } as Partial<Mission>, [
            { workId: 'w-app', relation: 'improves', workKind: 'app' },
            {
                workId: 'w-off',
                relation: 'improves',
                workKind: 'repo',
                workName: 'website',
                workTaskIsolation: 'off',
            },
        ]);
        // The App Work is at its cap, so the tick files nothing.
        t.taskRows.push({ id: 'o1', workId: 'w-app', missionId: 'm1', status: 'todo', title: 'A' });
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'no-tasks', tasksFiled: 0 });
        expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
            details: expect.objectContaining({
                reason: 'nothing-new',
                message:
                    'Nothing new to file on the attached App or Repository Works. Task isolation is off on ' +
                    'the attached Repository Work "website", so no Tasks are filed there. Turn on Task ' +
                    "isolation in the Work's settings to let this Mission file Tasks on it.",
            }),
        });
    });

    it('a Repository Work whose isolation was turned off while the planner ran gets no Task', async () => {
        const relations = [
            {
                workId: 'w-repo',
                relation: 'improves',
                workKind: 'repo',
                workTaskIsolation: 'worktree' as string,
            },
        ];
        const t = build({}, relations);
        t.planner.plan.mockImplementationOnce(async () => {
            t.missionWorks.listForMissionWithWork.mockResolvedValue([
                { ...relations[0], workTaskIsolation: 'off' },
            ]);
            return [{ title: 'Add a changelog', description: '' }];
        });
        await t.service.runOnce('m1', 'u1');
        expect(t.tasksService.create).not.toHaveBeenCalled();
    });

    it('every other kind is still left alone, with Task isolation on or off', async () => {
        const relations = [
            'directory',
            'default',
            'website',
            'landing-page',
            'blog',
            'awesome-repo',
            'company',
            'campaign',
            'project',
            'no-such-kind',
        ].flatMap((workKind, index) => [
            {
                workId: `w-${index}-on`,
                relation: 'improves',
                workKind,
                workTaskIsolation: 'worktree',
            },
            { workId: `w-${index}-off`, relation: 'operates', workKind, workTaskIsolation: 'off' },
        ]);
        const t = build({}, [
            ...relations,
            { workId: 'w-null', relation: 'improves', workKind: null },
        ]);
        expect(await t.service.runOnce('m1', 'u1')).toMatchObject({
            outcome: 'no-tasks',
            tasksFiled: 0,
            message: 'no-app-work',
        });
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(t.tasksService.create).not.toHaveBeenCalled();
        expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
            details: expect.objectContaining({ reason: 'no-app-work' }),
        });
    });

    it('a Repository Work attached under another relation is not a target', async () => {
        const t = build({}, [
            {
                workId: 'w-repo',
                relation: 'researches',
                workKind: 'repo',
                workTaskIsolation: 'worktree',
            },
        ]);
        expect(await t.service.runOnce('m1', 'u1')).toMatchObject({ message: 'no-app-work' });
        expect(t.planner.plan).not.toHaveBeenCalled();
    });

    // ── The App-changes switch (T49) governs App Works only ─────────────────────────────

    describe('while App changes are paused (EVER_WORKS_APP_CHANGES_ENABLED=false)', () => {
        let previous: string | undefined;
        beforeEach(() => {
            previous = process.env.EVER_WORKS_APP_CHANGES_ENABLED;
            process.env.EVER_WORKS_APP_CHANGES_ENABLED = 'false';
        });
        afterEach(() => {
            if (previous === undefined) delete process.env.EVER_WORKS_APP_CHANGES_ENABLED;
            else process.env.EVER_WORKS_APP_CHANGES_ENABLED = previous;
        });

        it('a Repository Work is still filed on and started', async () => {
            const t = build({}, [
                {
                    workId: 'w-repo',
                    relation: 'improves',
                    workKind: 'repo',
                    workTaskIsolation: 'worktree',
                },
            ]);
            const result = await t.service.runOnce('m1', 'u1');
            expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
            expect(t.tasksService.runTask).toHaveBeenCalledTimes(1);
        });

        it('with an App Work and a Repository Work attached, only the App Work is skipped', async () => {
            const t = build({}, [
                { workId: 'w-app', relation: 'improves', workKind: 'app' },
                {
                    workId: 'w-repo',
                    relation: 'improves',
                    workKind: 'repo',
                    workTaskIsolation: 'worktree',
                },
            ]);
            const result = await t.service.runOnce('m1', 'u1');
            expect(
                t.planner.plan.mock.calls.map(
                    ([input]) => (input as { work: { id: string } }).work.id,
                ),
            ).toEqual(['w-repo']);
            expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
            expect(result.message).toContain('app-paused=1');
            expect(
                t.tasksService.create.mock.calls.map(([, input]) => (input as Row).workId),
            ).toEqual(['w-repo']);
        });

        it('an App Work beside a Repository Work with isolation off: nothing filed, and the notice is about the Repository Work', async () => {
            const t = build({}, [
                { workId: 'w-app', relation: 'improves', workKind: 'app' },
                {
                    workId: 'w-repo',
                    relation: 'improves',
                    workKind: 'repo',
                    workName: 'ever-works',
                    workTaskIsolation: 'off',
                },
            ]);
            const result = await t.service.runOnce('m1', 'u1');
            expect(result).toMatchObject({
                outcome: 'no-tasks',
                tasksFiled: 0,
                message: 'app-changes-paused',
            });
            expect(t.planner.plan).not.toHaveBeenCalled();
            expect(nothingToFile(t.activityLog)).toHaveLength(1);
            expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
                details: expect.objectContaining({ reason: 'repo-isolation-off' }),
            });
        });
    });

    // ── The open-Tasks cap counts only Tasks that are really open ───────────────────────

    /** NOW_DAY_1 minus `hours`. */
    const hoursAgo = (hours: number) => new Date(NOW_DAY_1.getTime() - hours * 3_600_000);

    it('a Task waiting on a pull request closed without merging a day ago or more does not count', async () => {
        const t = build({ taskOutput: { tasksPerTick: 3, openTasksCap: 2 } } as Partial<Mission>, [
            {
                workId: 'w-repo',
                relation: 'improves',
                workKind: 'repo',
                workTaskIsolation: 'worktree',
            },
        ]);
        t.taskRows.push(
            // Rejected: the pull request was closed unmerged over a day ago, and nothing ever
            // completes the Task.
            {
                id: 'rejected-1',
                workId: 'w-repo',
                missionId: 'm1',
                status: 'in_review',
                prNumber: 11,
                prState: 'closed',
                updatedAt: hoursAgo(30),
                ciCheckedAt: hoursAgo(30),
                title: 'Rejected one',
            },
            {
                id: 'rejected-2',
                workId: 'w-repo',
                missionId: 'm1',
                status: 'blocked',
                prNumber: 12,
                prState: 'closed',
                updatedAt: hoursAgo(48),
                ciCheckedAt: hoursAgo(25),
                title: 'Rejected two',
            },
            // Really open: in review with an open pull request.
            {
                id: 'open-1',
                workId: 'w-repo',
                missionId: 'm1',
                status: 'in_review',
                prNumber: 13,
                prState: 'open',
                title: 'Open one',
            },
        );
        const result = await t.service.runOnce('m1', 'u1');
        // Cap 2, one really open → headroom 1 (not 0, which three counted Tasks would give).
        expect(t.planner.plan.mock.calls[0][0]).toMatchObject({ count: 1 });
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        // Their status is not touched.
        expect(t.taskRows.find((row) => row.id === 'rejected-1')?.status).toBe('in_review');
        expect(t.taskRows.find((row) => row.id === 'rejected-2')?.status).toBe('blocked');
    });

    it('a closed pull request holds its slot for a day after the Task last changed, by either timestamp', async () => {
        // Closing a Mission's pull requests throttles it to `openTasksCap` new Tasks per Work per
        // day; it does not free a slot the moment each one closes.
        for (const changed of [
            { updatedAt: hoursAgo(1), ciCheckedAt: hoursAgo(40) },
            { updatedAt: hoursAgo(40), ciCheckedAt: hoursAgo(23) },
            { updatedAt: hoursAgo(24), ciCheckedAt: null },
        ]) {
            const t = build({
                taskOutput: { tasksPerTick: 1, openTasksCap: 1 },
            } as Partial<Mission>);
            t.taskRows.push({
                id: 'o1',
                workId: 'w-1',
                missionId: 'm1',
                status: 'in_review',
                prNumber: 7,
                prState: 'closed',
                title: 'A',
                ...changed,
            });
            expect((await t.service.runOnce('m1', 'u1')).tasksFiled).toBe(0);
            expect(t.planner.plan).not.toHaveBeenCalled();
        }
    });

    it('a Task run again after its pull request closed counts while its run is queued or running', async () => {
        // The real path: `runTask` does not move the Task out of In review, and its cached PR
        // state still says `closed` (the sweep never polls a closed one again) — but a run is in
        // flight, so it is open work, however long ago the old pull request closed.
        for (const status of ['in_review', 'blocked']) {
            const t = build({
                taskOutput: { tasksPerTick: 1, openTasksCap: 1 },
            } as Partial<Mission>);
            t.taskRows.push({
                id: 'rerun-1',
                workId: 'w-1',
                missionId: 'm1',
                status,
                prNumber: 7,
                prState: 'closed',
                updatedAt: hoursAgo(72),
                ciCheckedAt: hoursAgo(72),
                activeRun: true,
                title: 'A',
            });
            expect((await t.service.runOnce('m1', 'u1')).tasksFiled).toBe(0);
            expect(t.planner.plan).not.toHaveBeenCalled();
        }
        // The same Task once its run has ended (and the closed PR is old) frees the slot.
        const t = build({ taskOutput: { tasksPerTick: 1, openTasksCap: 1 } } as Partial<Mission>);
        t.taskRows.push({
            id: 'rerun-1',
            workId: 'w-1',
            missionId: 'm1',
            status: 'in_review',
            prNumber: 7,
            prState: 'closed',
            updatedAt: hoursAgo(72),
            ciCheckedAt: hoursAgo(72),
            activeRun: false,
            title: 'A',
        });
        expect((await t.service.runOnce('m1', 'u1')).tasksFiled).toBe(1);
    });

    it('every other pull-request state still counts: none yet, open, draft, and merged-but-not-done', async () => {
        for (const prState of [null, undefined, 'open', 'draft', 'merged']) {
            const t = build({
                taskOutput: { tasksPerTick: 1, openTasksCap: 1 },
            } as Partial<Mission>);
            t.taskRows.push({
                id: 'o1',
                workId: 'w-1',
                missionId: 'm1',
                status: 'in_review',
                prNumber: prState ? 7 : null,
                prState,
                title: 'A',
            });
            expect((await t.service.runOnce('m1', 'u1')).tasksFiled).toBe(0);
            expect(t.planner.plan).not.toHaveBeenCalled();
        }
    });

    it('a Task with a closed pull request moved back to To do / Backlog, or In progress, still counts', async () => {
        for (const status of ['in_progress', 'todo', 'backlog']) {
            const t = build({
                taskOutput: { tasksPerTick: 1, openTasksCap: 1 },
            } as Partial<Mission>);
            t.taskRows.push({
                id: 'o1',
                workId: 'w-1',
                missionId: 'm1',
                status,
                prNumber: 7,
                prState: 'closed',
                updatedAt: hoursAgo(72),
                title: 'A',
            });
            expect((await t.service.runOnce('m1', 'u1')).tasksFiled).toBe(0);
            expect(t.planner.plan).not.toHaveBeenCalled();
        }
    });

    it('a Done or Cancelled Task never counts, whatever its pull-request state', async () => {
        const t = build({ taskOutput: { tasksPerTick: 1, openTasksCap: 1 } } as Partial<Mission>);
        t.taskRows.push(
            {
                id: 'd1',
                workId: 'w-1',
                missionId: 'm1',
                status: 'done',
                prState: 'merged',
                title: 'A',
            },
            {
                id: 'c1',
                workId: 'w-1',
                missionId: 'm1',
                status: 'cancelled',
                prState: 'open',
                title: 'B',
            },
        );
        expect((await t.service.runOnce('m1', 'u1')).tasksFiled).toBe(1);
    });

    it('missionOpenTasksWhere: open work, a closed PR for a day after it last changed, any run in flight', () => {
        const where = missionOpenTasksWhere(
            { workId: 'w-1', missionId: 'm1' },
            { now: NOW_DAY_1 },
        ) as unknown as Row[];
        expect(where).toHaveLength(6);
        const row = (over: Row) => ({
            workId: 'w-1',
            missionId: 'm1',
            status: 'in_review',
            ...over,
        });
        const old = { updatedAt: hoursAgo(25), ciCheckedAt: hoursAgo(25) };
        expect(matches(row({}), where)).toBe(true);
        expect(matches(row({ prState: 'open' }), where)).toBe(true);
        expect(matches(row({ prState: 'merged' }), where)).toBe(true);
        expect(matches(row({ prState: 'closed', ...old }), where)).toBe(false);
        expect(matches(row({ prState: 'closed' }), where)).toBe(false);
        expect(matches(row({ status: 'blocked', prState: 'closed', ...old }), where)).toBe(false);
        expect(matches(row({ status: 'blocked', prState: 'draft' }), where)).toBe(true);
        // Within the day, by either timestamp (24 h exactly still holds the slot).
        expect(matches(row({ prState: 'closed', ...old, updatedAt: hoursAgo(24) }), where)).toBe(
            true,
        );
        expect(matches(row({ prState: 'closed', ...old, ciCheckedAt: hoursAgo(2) }), where)).toBe(
            true,
        );
        // A run in flight, whatever the status or PR state says.
        expect(matches(row({ prState: 'closed', ...old, activeRun: true }), where)).toBe(true);
        expect(matches(row({ status: 'done', activeRun: true }), where)).toBe(true);
        for (const status of ['in_progress', 'todo', 'backlog', 'some-future-status']) {
            expect(matches(row({ status, prState: 'closed', ...old }), where)).toBe(true);
            expect(matches(row({ status }), where)).toBe(true);
        }
        expect(matches(row({ status: 'done' }), where)).toBe(false);
        expect(matches(row({ status: 'cancelled', prState: 'open' }), where)).toBe(false);
        expect(matches(row({ missionId: 'other' }), where)).toBe(false);
        expect(matches(row({ workId: 'w-2' }), where)).toBe(false);
        expect(matches(row({ workId: 'w-2', activeRun: true }), where)).toBe(false);
    });

    // The same rule against the REAL Task entity: what the count asks the database.
    it('missionOpenTasksWhere compiles to six OR-ed branches, the last an EXISTS on a queued or running run', async () => {
        // The entity metadata is built against the real `Date` (a faked one is a different
        // constructor from the one the column decorators recorded).
        jest.useRealTimers();
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: ENTITIES,
        });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        const query = dataSource
            .getRepository(Task)
            .createQueryBuilder('task')
            .setFindOptions({
                where: missionOpenTasksWhere(
                    { workId: 'w-1', missionId: 'm1' },
                    {
                        now: NOW_DAY_1,
                        activeRunExists: missionActiveRunExists((name) =>
                            dataSource.driver.escape(name),
                        ),
                    },
                ),
            });
        const sql = query.getQuery().replace(/\s+/g, ' ');
        const where = sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
        const branches = where.split(' OR ');
        expect(branches).toHaveLength(6);
        for (const branch of branches) {
            expect(branch).toContain('"task"."workId" = ');
            expect(branch).toContain('"task"."missionId" = ');
        }
        // 1: any status but Done, Cancelled and the two waiting ones — whatever the PR did.
        expect(branches[0]).toContain('NOT("task"."status" IN (');
        expect(branches[0]).not.toContain('"task"."prState"');
        // 2-5: a waiting status, with no PR state yet, one that is not closed, or a closed one
        // that changed in the last day (by `updatedAt`, by `ciCheckedAt`).
        for (const branch of branches.slice(1, 5)) {
            expect(branch).toContain('("task"."status" IN (');
            expect(branch).not.toContain('NOT("task"."status"');
        }
        expect(branches[1]).toContain('"task"."prState" IS NULL');
        expect(branches[2]).toContain('NOT("task"."prState" IN (');
        expect(branches[3]).toContain('"task"."prState" = ');
        expect(branches[3]).toContain('"task"."updatedAt" >= ');
        expect(branches[4]).toContain('"task"."ciCheckedAt" >= ');
        // 6: any status, a queued or running run of THIS Task.
        expect(branches[5]).not.toContain('"task"."status"');
        expect(branches[5]).toContain(
            'EXISTS (SELECT 1 FROM "agent_runs" "mission_cap_run" WHERE "mission_cap_run"."taskId" = "task"."id" AND "mission_cap_run"."status" IN (\'queued\', \'running\'))',
        );
        const parameters = Object.values(query.getParameters());
        expect(parameters).toEqual(
            expect.arrayContaining([
                'w-1',
                'm1',
                'done',
                'cancelled',
                'in_review',
                'blocked',
                'closed',
            ]),
        );
        // The day is measured from the tick's own `now`.
        expect(
            parameters.filter(
                (value) =>
                    value instanceof Date &&
                    value.getTime() === NOW_DAY_1.getTime() - 24 * 3_600_000,
            ),
        ).toHaveLength(2);
    });

    it('describeMissionNothingToFile: every reason, one Work or several, capped at three names', () => {
        const blocked = (over: Partial<Record<string, string[]>> = {}) => ({
            isolationOff: [],
            agentCannotOpenPullRequests: [],
            agentMergeAllowed: [],
            ...over,
        });
        expect(describeMissionNothingToFile('no-app-work')).toBe(
            'No attached App or Repository Work to file Tasks on.',
        );
        expect(describeMissionNothingToFile('nothing-new')).toBe(
            'Nothing new to file on the attached App or Repository Works.',
        );
        expect(
            describeMissionNothingToFile(
                'repo-isolation-off',
                blocked({ isolationOff: ['a', 'b'] }),
            ),
        ).toBe(
            'Nothing filed. Task isolation is off on the attached Repository Works "a", "b", so no ' +
                "Tasks are filed there. Turn on Task isolation in each Work's settings to let this " +
                'Mission file Tasks on them.',
        );
        expect(
            describeMissionNothingToFile(
                'repo-agent-cannot-open-pull-requests',
                blocked({ agentCannotOpenPullRequests: ['site'] }),
            ),
        ).toBe(
            'Nothing filed. The Agent that would run Tasks on the attached Repository Work "site" may ' +
                'not both commit and open pull requests (or no single Agent is set), so no Tasks are ' +
                "filed there. Choose an Agent with both permissions for this Mission's Task output, or " +
                "grant them to the Work's Agent.",
        );
        expect(
            describeMissionNothingToFile(
                'repo-agent-merge-allowed',
                blocked({ agentMergeAllowed: ['site'] }),
            ),
        ).toBe(
            'Nothing filed. The merge policy of the attached Repository Work "site" lets agents merge ' +
                'their own pull requests, so this Mission files no unattended Tasks there. Turn agent ' +
                'merges off for it, or opt the Mission in (taskOutput.allowAgentMerge).',
        );
        expect(
            describeMissionNothingToFile(
                'repo-isolation-off',
                blocked({ isolationOff: ['a', 'b', 'c', 'd', 'e'] }),
            ),
        ).toContain('Repository Works "a", "b", "c" and 2 more, so no Tasks are filed there.');
        // A long Work name is cut, so the entry stays one readable line.
        const long = describeMissionNothingToFile(
            'repo-isolation-off',
            blocked({ isolationOff: ['x'.repeat(500)] }),
        );
        expect(long).toContain(`Repository Work "${'x'.repeat(80)}", so no Tasks`);
    });

    // ── A Repository Work's Agent and merge policy (asked before the planner) ──────────

    const repoOn = {
        workId: 'w-repo',
        relation: 'improves',
        workKind: 'repo',
        workName: 'ever-works',
        workTaskIsolation: 'worktree',
    };

    it('asks, before planning, whether a Task on the Repository Work could run — with the Mission’s Agent', async () => {
        const t = build(
            { taskOutput: { agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } } as Partial<Mission>,
            [repoOn, { workId: 'w-app', relation: 'improves', workKind: 'app' }],
        );
        await t.service.runOnce('m1', 'u1');
        // Only the Repository Work is asked (an App Work's own rails are FR-9 and T12).
        expect(t.tasksService.missionRepoRunRefusalForNewTask).toHaveBeenCalledTimes(1);
        expect(t.tasksService.missionRepoRunRefusalForNewTask).toHaveBeenCalledWith(
            'u1',
            {
                workId: 'w-repo',
                missionId: 'm1',
                agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            },
            undefined,
        );
        expect(
            t.tasksService.missionRepoRunRefusalForNewTask.mock.invocationCallOrder[0],
        ).toBeLessThan(t.planner.plan.mock.invocationCallOrder[0]);
    });

    it('a Repository Work whose Agent may not commit and open pull requests gets no Task, no planner call, no run', async () => {
        const t = build({}, [repoOn]);
        t.tasksService.missionRepoRunRefusalForNewTask.mockResolvedValue(
            'agent-cannot-open-pull-requests',
        );
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({
            outcome: 'no-tasks',
            tasksFiled: 0,
            message: 'repo-agent-cannot-open-pull-requests',
        });
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(t.tasksService.create).not.toHaveBeenCalled();
        expect(t.tasksService.runTask).not.toHaveBeenCalled();
        expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
            details: expect.objectContaining({
                reason: 'repo-agent-cannot-open-pull-requests',
                message: expect.stringContaining(
                    'The Agent that would run Tasks on the attached Repository Work "ever-works"',
                ),
            }),
        });
    });

    it('a Repository Work whose merge policy lets agents merge gets no Task unless the Mission opted in', async () => {
        const t = build({}, [repoOn]);
        t.tasksService.missionRepoRunRefusalForNewTask.mockResolvedValue('agent-merge-allowed');
        expect(await t.service.runOnce('m1', 'u1')).toMatchObject({
            outcome: 'no-tasks',
            message: 'repo-agent-merge-allowed',
        });
        expect(t.planner.plan).not.toHaveBeenCalled();
        expect(nothingToFile(t.activityLog)[0][0]).toMatchObject({
            details: expect.objectContaining({ reason: 'repo-agent-merge-allowed' }),
        });
    });

    it('the eligible Works are still filed on beside a blocked Repository Work, and the message counts it', async () => {
        const t = build({}, [{ workId: 'w-app', relation: 'improves', workKind: 'app' }, repoOn]);
        t.tasksService.missionRepoRunRefusalForNewTask.mockResolvedValue(
            'agent-cannot-open-pull-requests',
        );
        const result = await t.service.runOnce('m1', 'u1');
        expect(result).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 1 });
        expect(result.message).toContain('agent-blocked=1');
        expect(t.tasksService.create.mock.calls.map(([, input]) => (input as Row).workId)).toEqual([
            'w-app',
        ]);
    });

    it('a Repository Work whose verdict cannot be read is skipped this tick, with no notice', async () => {
        for (const failure of ['unreadable', 'throws'] as const) {
            const t = build({}, [repoOn]);
            if (failure === 'throws') {
                t.tasksService.missionRepoRunRefusalForNewTask.mockRejectedValue(
                    new Error('db down'),
                );
            } else {
                t.tasksService.missionRepoRunRefusalForNewTask.mockResolvedValue('unreadable');
            }
            expect(await t.service.runOnce('m1', 'u1')).toMatchObject({
                outcome: 'no-tasks',
                message: 'repo-unreadable',
            });
            expect(t.planner.plan).not.toHaveBeenCalled();
            expect(nothingToFile(t.activityLog)).toHaveLength(0);
        }
    });

    it('blockedRepoWorksForMission: the write path’s half, from the same verdicts', async () => {
        const t = build({
            taskOutput: { agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
        } as Partial<Mission>);
        t.tasksService.missionRepoRunRefusalForNewTask.mockImplementation(
            async (_userId: string, input: { workId: string }) =>
                input.workId === 'w-a' ? 'agent-cannot-open-pull-requests' : 'agent-merge-allowed',
        );
        const blocked = await t.service.blockedRepoWorksForMission(
            {
                id: 'm1',
                userId: 'u1',
                taskOutput: { agentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
            },
            [
                { ...repoOn, workId: 'w-a', workName: 'a' },
                { ...repoOn, workId: 'w-b', workName: 'b', relation: 'operates' },
                // Not asked: isolation off, another kind, another relation.
                { ...repoOn, workId: 'w-c', workTaskIsolation: 'off' },
                { workId: 'w-app', relation: 'improves', workKind: 'app' },
                { ...repoOn, workId: 'w-d', relation: 'researches' },
            ],
            undefined,
        );
        expect(blocked).toEqual({ agentCannotOpenPullRequests: ['a'], agentMergeAllowed: ['b'] });
        expect(t.tasksService.missionRepoRunRefusalForNewTask).toHaveBeenCalledTimes(2);
    });

    it('a `both` Mission runs the Ideas branch, then files Tasks — and reports both halves', async () => {
        const t = build({ outputMode: 'both' } as Partial<Mission>);
        const result = await t.service.runOnce('m1', 'u1');
        expect(t.proposals.generate).toHaveBeenCalledTimes(1);
        expect(result.tasksFiled).toBe(1);
        // Review of #3061 — "generated no Ideas" no longer hides the Tasks that were filed.
        expect(result.outcome).toBe('tasks-filed');
        expect(result.message).toMatch(/^ideas: .*; tasks: /);
    });

    it('combineBothOutcomes: Ideas spawned wins; Tasks filed beats an empty Ideas half; else the Ideas outcome', () => {
        expect(
            combineBothOutcomes(
                { outcome: 'spawned', ideasCreated: 2 },
                { outcome: 'tasks-filed', tasksFiled: 1 },
            ),
        ).toMatchObject({ outcome: 'spawned', ideasCreated: 2, tasksFiled: 1 });
        expect(
            combineBothOutcomes(
                { outcome: 'cap-hit', outstanding: 5, cap: 5 },
                { outcome: 'tasks-filed', tasksFiled: 2 },
            ),
        ).toMatchObject({ outcome: 'tasks-filed', tasksFiled: 2, cap: 5 });
        expect(
            combineBothOutcomes(
                { outcome: 'no-ideas', message: 'none' },
                { outcome: 'no-tasks', tasksFiled: 0, message: 'works=1 filed=0' },
            ),
        ).toMatchObject({
            outcome: 'no-ideas',
            tasksFiled: 0,
            message: 'ideas: none; tasks: works=1 filed=0',
        });
    });
});
