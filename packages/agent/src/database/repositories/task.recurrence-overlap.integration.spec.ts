import { DataSource, type Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { Task, TaskPriority, TaskStatus } from '../../entities/task.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { CacheEntry } from '../../entities/cache.entity';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { TaskRecurrenceDispatcherService } from '../../tasks-domain/task-recurrence-dispatcher.service';
import {
    RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
    recurrenceFireLockKey,
    recurrenceOpenInstancesWhere,
} from '../../tasks-domain/recurrence-overlap';
import {
    TASK_PR_NOT_FOUND_CONFIRM_MS,
    TASK_PR_NOT_FOUND_RECHECK_MS,
    TASK_PR_NOT_FOUND_STATE,
} from '../../tasks-domain/task-open-work';
import { TaskPrStatusService } from '../../tasks-domain/task-pr-status.service';
import type { TaskTransitionService } from '../../tasks-domain/task-transition.service';
import { missionOpenTasksWhere } from '../../missions/mission-tick.service';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import type { GitFacadeService } from '../../facades/git.facade';
import type { WorkRepository } from './work.repository';
import { TaskRepository } from './task.repository';

/**
 * Recurring Tasks overlap limit (`tasks.recurrenceMaxOpenInstances`) on REAL better-sqlite3:
 * the open-instance count (`TaskRepository.countOpenRecurrenceInstances`), the CAS skip, and
 * the recurrence dispatcher end to end — skip at the limit, the slot advancing without the
 * occurred count, firing again once an instance finishes or its pull request merges / closes,
 * no limit by default, and two dispatchers racing on one template.
 */
describe('Recurring Tasks overlap limit (real SQLite)', () => {
    let dataSource: DataSource;
    let taskRows: Repository<Task>;
    let runRows: Repository<AgentRun>;
    let repository: TaskRepository;
    let lock: DistributedTaskLockService;
    let slugSeq = 0;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const OTHER_WORK = '44444444-4444-4444-8444-444444444444';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    // Wall clock: the dispatcher's spawned instances get a real `createdAt`.
    const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    // Daily, at the minute twelve and a half hours from now, due a minute ago: the next slot
    // is always about half a day ahead, never within the test's own minute.
    const AHEAD = new Date(NOW.getTime() + 12.5 * HOUR);
    const CRON = `${AHEAD.getUTCMinutes()} ${AHEAD.getUTCHours()} * * *`;
    const DUE = new Date(NOW.getTime() - 60_000);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        taskRows = dataSource.getRepository(Task);
        runRows = dataSource.getRepository(AgentRun);
        repository = new TaskRepository(taskRows);
        lock = new DistributedTaskLockService(dataSource.getRepository(CacheEntry));
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await runRows.clear();
        await taskRows.clear();
        await dataSource.getRepository(CacheEntry).clear();
    });

    async function template(over: Partial<Task> = {}): Promise<Task> {
        slugSeq += 1;
        return taskRows.save(
            taskRows.create({
                userId: OWNER,
                slug: `T-${slugSeq}`,
                title: 'Quality loop',
                status: TaskStatus.TODO,
                priority: TaskPriority.P3,
                createdByType: 'user',
                createdById: OWNER,
                agentId: AGENT,
                isRecurring: true,
                recurrenceCron: CRON,
                nextOccurrenceAt: DUE,
                recurrenceOccurredCount: 4,
                recurrenceMaxOpenInstances: 1,
                tenantId: TENANT,
                organizationId: ORG,
                ...over,
            } as Partial<Task>),
        );
    }

    /** An instance of `parent`, with its timestamps forced where a case needs an age. */
    async function instance(
        parent: Task,
        over: Partial<Task> = {},
        times: { createdAt?: Date; updatedAt?: Date } = {},
    ): Promise<Task> {
        slugSeq += 1;
        const row = await taskRows.save(
            taskRows.create({
                userId: OWNER,
                slug: `T-${slugSeq}`,
                title: parent.title,
                status: TaskStatus.TODO,
                priority: TaskPriority.P3,
                createdByType: 'user',
                createdById: OWNER,
                parentRecurringTaskId: parent.id,
                tenantId: TENANT,
                organizationId: ORG,
                ...over,
            } as Partial<Task>),
        );
        await setTimes(row.id, {
            createdAt: times.createdAt ?? NOW,
            updatedAt: times.updatedAt ?? NOW,
        });
        return row;
    }

    async function setTimes(
        id: string,
        times: { createdAt?: Date; updatedAt?: Date; ciCheckedAt?: Date | null },
    ): Promise<void> {
        // The update builder would set `updatedAt` to now unless the SET names it.
        const keep = dataSource.driver.escape('updatedAt');
        await taskRows
            .createQueryBuilder()
            .update(Task)
            .set({ ...times, updatedAt: times.updatedAt ?? (() => keep) })
            .where('id = :id', { id })
            .execute();
    }

    /**
     * The PR-status sweep's write, exactly as production makes it (`updatePrStatusCache`). It keeps
     * `updatedAt` (a machine-only write): only `ciCheckedAt` and the cache columns move. Every
     * `ciCheckedAt` stamp in this file goes through it, so `updatedAt` behaves as in production.
     */
    const sweepRead = (
        taskId: string,
        patch: Parameters<TaskRepository['updatePrStatusCache']>[1] = {},
    ) => repository.updatePrStatusCache(taskId, { ciCheckedAt: new Date(), ...patch });

    /**
     * The PR-status read the sweep makes, end to end (`TaskPrStatusService.syncDuePrStatuses`
     * through the real repository), against a provider that answers `status` for every pull
     * request: `null` is "not found". The transition double moves the status the way
     * `TaskTransitionService` does for `completeOnMerge` (a real write, so `updatedAt` moves).
     */
    async function sweepWithProvider(status: GitPullRequestStatus | null) {
        const works = {
            findById: async (id: string) => ({
                id,
                gitProvider: 'github',
                taskIsolationBaseBranch: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'widgets',
            }),
        };
        const git = { getPullRequestStatus: jest.fn(async () => status) };
        const transitions = {
            transition: jest.fn(async (task: Task, to: TaskStatus) =>
                repository.updateById(task.id, { status: to }),
            ),
        };
        const service = new TaskPrStatusService(
            repository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
            transitions as unknown as TaskTransitionService,
        );
        const summary = await service.syncDuePrStatuses({ staleSeconds: 0 });
        return { summary, git, transitions };
    }

    /** The provider's answer for an open pull request (or `state` for another one). */
    const providerSays = (
        number: number,
        state: GitPullRequestStatus['state'] = 'open',
    ): GitPullRequestStatus => ({
        number,
        state,
        merged: state === 'merged',
        headSha: 'c'.repeat(40),
        ciState: 'pending',
        checks: [],
    });

    /**
     * Record a "not found" the way production does: the last successful read was more than the
     * confirm window ago, and the sweep's next read answers "not found".
     */
    async function goNotFound(taskId: string) {
        await sweepRead(taskId, { ciCheckedAt: ago(TASK_PR_NOT_FOUND_CONFIRM_MS + 60_000) });
        return sweepWithProvider(null);
    }

    const readRow = (id: string) => taskRows.findOneByOrFail({ id });

    async function run(
        taskId: string,
        status: AgentRun['status'],
        extra: {
            awaitingInput?: boolean;
            startedAt?: Date | null;
            createdAt?: Date;
            queuedReason?: string | null;
        } = {},
    ): Promise<void> {
        const row = await runRows.save(
            runRows.create({
                agentId: AGENT,
                userId: OWNER,
                triggerKind: 'task',
                status,
                taskId,
                awaitingInput: extra.awaitingInput ?? false,
                startedAt: extra.startedAt ?? null,
                queuedReason: extra.queuedReason ?? null,
            }),
        );
        if (extra.createdAt) {
            await runRows
                .createQueryBuilder()
                .update(AgentRun)
                .set({ createdAt: extra.createdAt })
                .where('id = :id', { id: row.id })
                .execute();
        }
    }

    const count = async (parent: Task, now = NOW) =>
        (await repository.countOpenRecurrenceInstances(parent, now)).count;
    const openIds = async (parent: Task, now = NOW) =>
        (await repository.countOpenRecurrenceInstances(parent, now)).instances
            .map((row) => row.id)
            .sort();
    const ago = (ms: number) => new Date(NOW.getTime() - ms);

    describe('countOpenRecurrenceInstances', () => {
        it('counts a queued or running run whatever the status, and never a finished one', async () => {
            const parent = await template();
            const queued = await instance(parent, { status: TaskStatus.DONE });
            await run(queued.id, 'queued');
            const running = await instance(
                parent,
                { status: TaskStatus.CANCELLED },
                {
                    createdAt: new Date(NOW.getTime() - 30 * DAY),
                },
            );
            await run(running.id, 'running');
            const finished = await instance(parent, { status: TaskStatus.DONE });
            await run(finished.id, 'completed');
            await run(finished.id, 'failed');
            expect(await count(parent)).toBe(2);
        });

        it('counts an open or draft pull request the sweep still reads on the Work, with no age bound', async () => {
            const parent = await template({ workId: WORK });
            const old = ago(60 * DAY);
            const open = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 7, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: old },
            );
            await sweepRead(open.id);
            const draft = await instance(
                parent,
                { status: TaskStatus.BLOCKED, prNumber: 8, prState: 'draft', workId: WORK },
                { createdAt: old, updatedAt: old },
            );
            await sweepRead(draft.id);
            const cancelled = await instance(
                parent,
                { status: TaskStatus.CANCELLED, prNumber: 9, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: old },
            );
            await sweepRead(cancelled.id);
            expect(await openIds(parent)).toEqual([open.id, draft.id].sort());
            // Counted by the sweep's read alone: the read is not a change to the instance.
            const read = await readRow(open.id);
            expect(read.updatedAt.getTime()).toBe(old.getTime());
            expect(read.ciCheckedAt!.getTime()).toBeGreaterThan(ago(HOUR).getTime());
        });

        it('a sweep write keeps updatedAt: the cache write and the CI head write', async () => {
            const parent = await template({ workId: WORK });
            const old = ago(30 * DAY);
            const row = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 12, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: old },
            );
            await sweepRead(row.id, {
                prState: 'closed',
                ciState: 'failing',
                prHeadSha: 'a'.repeat(40),
                prChecks: [{ name: 'build', status: 'completed', conclusion: 'failure' }],
            });
            await repository.recordCiHead({
                taskId: row.id,
                expectedHeadSha: null,
                headSha: 'b'.repeat(40),
                seenAt: new Date(),
                failing: true,
            });
            const after = await readRow(row.id);
            expect(after.prState).toBe('closed');
            expect(after.ciHeadSha).toBe('b'.repeat(40));
            expect(after.updatedAt.getTime()).toBe(old.getTime());
        });

        it('an open pull request the sweep no longer reads ages out 7 days after the last write', async () => {
            const parent = await template({ workId: WORK });
            const old = ago(60 * DAY);
            // Taken out of the Work: the sweep never polls `workId IS NULL`, so nothing writes it.
            const movedOutStale = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 30, prState: 'open', workId: null },
                { createdAt: old, updatedAt: ago(8 * DAY) },
            );
            const movedOutRecent = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 31, prState: 'open', workId: null },
                { createdAt: old, updatedAt: ago(6 * DAY) },
            );
            // On the Work, but its reads have failed for 8 days (a failed read writes nothing):
            // its last successful read and its last change were both 8 days ago.
            const readsFailing = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 33, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: ago(8 * DAY) },
            );
            await setTimes(readsFailing.id, { ciCheckedAt: ago(8 * DAY), updatedAt: ago(8 * DAY) });
            expect(await openIds(parent)).toEqual([movedOutRecent.id]);
            expect(movedOutStale.id && readsFailing.id).toBeTruthy();
        });

        /**
         * #3146 closure review, follow-up 1: the sweep reads an instance moved to another Work
         * against that Work's repository, and its write used to bump `updatedAt`, so the instance
         * never aged out. Its reads now leave "last changed" alone.
         */
        it('an instance moved to another Work ages out a week after it last changed, however often the sweep reads it', async () => {
            const parent = await template({ workId: WORK });
            const old = ago(60 * DAY);
            const stale = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 32, prState: 'open', workId: OTHER_WORK },
                { createdAt: old, updatedAt: ago(8 * DAY) },
            );
            await sweepRead(stale.id);
            const recent = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 35, prState: 'open', workId: OTHER_WORK },
                { createdAt: old, updatedAt: ago(6 * DAY) },
            );
            await sweepRead(recent.id);
            expect(await openIds(parent)).toEqual([recent.id]);
            expect(await openIds(parent, new Date(NOW.getTime() + 2 * DAY))).toEqual([]);
        });

        /**
         * #3146 closure review, follow-up 2 (and the review of this PR): a "not found" is
         * recorded only once it has persisted, so a brief loss of access (a provider answers "not
         * found" for a private repository it does not show you) never touches the Task.
         */
        it('a single "not found" changes nothing: the next read finds the pull request and it keeps its slot', async () => {
            const parent = await template({ workId: WORK });
            const old = ago(30 * DAY);
            const blip = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 34, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: old },
            );
            const lastRead = ago(5 * 60_000);
            await sweepRead(blip.id, { ciCheckedAt: lastRead, ciState: 'passing' });

            const { summary, git } = await sweepWithProvider(null);
            expect(summary).toMatchObject({ scanned: 1, refreshed: 1, failed: 0 });
            expect(git.getPullRequestStatus).toHaveBeenCalledTimes(1);
            const untouched = await readRow(blip.id);
            expect(untouched).toMatchObject({ prState: 'open', ciState: 'passing' });
            expect(untouched.ciCheckedAt!.getTime()).toBe(lastRead.getTime());
            expect(await openIds(parent)).toEqual([blip.id]);

            // Access is back on the next tick.
            await sweepWithProvider(providerSays(34));
            expect((await readRow(blip.id)).prState).toBe('open');
            expect(await openIds(parent, new Date(NOW.getTime() + 2 * DAY))).toEqual([blip.id]);
        });

        it('a "not found" that persists is recorded, frees the slot a day after the instance last changed, and is re-read every 6 hours', async () => {
            const parent = await template({ workId: WORK });
            const old = ago(30 * DAY);
            const idle = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 37, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: old },
            );
            const touched = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 38, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: ago(2 * HOUR) },
            );
            await sweepRead(idle.id, {
                ciCheckedAt: ago(TASK_PR_NOT_FOUND_CONFIRM_MS + 60_000),
                ciState: 'failing',
                prChecks: [{ name: 'build', status: 'completed', conclusion: 'failure' }],
            });
            await goNotFound(touched.id);

            const row = await readRow(idle.id);
            expect(row).toMatchObject({
                prState: TASK_PR_NOT_FOUND_STATE,
                ciState: null,
                prChecks: null,
            });
            expect(row.updatedAt.getTime()).toBe(old.getTime());
            expect((await readRow(touched.id)).prState).toBe(TASK_PR_NOT_FOUND_STATE);
            // The idle one is free at once (no change in a day); the one changed 2 h ago holds its
            // slot until a day after that change, whatever the re-reads stamp.
            expect(await openIds(parent)).toEqual([touched.id]);
            expect(await openIds(parent, new Date(NOW.getTime() + 21 * HOUR))).toEqual([
                touched.id,
            ]);
            expect(await openIds(parent, new Date(NOW.getTime() + 23 * HOUR))).toEqual([]);

            // Not due again until 6 hours after the read that recorded it.
            const soon = await sweepWithProvider(null);
            expect(soon.summary.scanned).toBe(0);
            await sweepRead(idle.id, { ciCheckedAt: ago(TASK_PR_NOT_FOUND_RECHECK_MS + 60_000) });
            const later = await sweepWithProvider(null);
            expect(later.summary.scanned).toBe(1);
            expect(later.git.getPullRequestStatus).toHaveBeenCalledTimes(1);
            const reread = await readRow(idle.id);
            expect(reread.prState).toBe(TASK_PR_NOT_FOUND_STATE);
            expect(reread.ciCheckedAt!.getTime()).toBeGreaterThan(ago(HOUR).getTime());
            expect(reread.updatedAt.getTime()).toBe(old.getTime());
        });

        it('a "not found" pull request the 6-hourly re-read finds merged completes its Task and frees the Mission slot', async () => {
            const MISSION = '66666666-6666-4666-8666-666666666666';
            const parent = await template({ workId: WORK });
            const old = ago(30 * DAY);
            const back = await instance(
                parent,
                {
                    status: TaskStatus.IN_REVIEW,
                    prNumber: 39,
                    prState: 'open',
                    workId: WORK,
                    missionId: MISSION,
                },
                { createdAt: old, updatedAt: old },
            );
            await goNotFound(back.id);
            expect((await readRow(back.id)).prState).toBe(TASK_PR_NOT_FOUND_STATE);
            const missionCount = () =>
                taskRows.count({
                    where: missionOpenTasksWhere(
                        { workId: WORK, missionId: MISSION },
                        { now: NOW },
                    ),
                });
            expect(await missionCount()).toBe(1);

            await sweepRead(back.id, { ciCheckedAt: ago(TASK_PR_NOT_FOUND_RECHECK_MS + 60_000) });
            const { summary, transitions } = await sweepWithProvider(providerSays(39, 'merged'));

            expect(summary).toMatchObject({ scanned: 1, merged: 1, completed: 1, failed: 0 });
            expect(transitions.transition).toHaveBeenCalledWith(
                expect.objectContaining({ id: back.id, prState: 'merged' }),
                TaskStatus.DONE,
                expect.objectContaining({ actorType: 'agent' }),
            );
            const done = await readRow(back.id);
            // `prState` merged is what the Goal wait-for-merge gate reads; Done is what the
            // Mission cap and the overlap count read.
            expect(done).toMatchObject({
                status: TaskStatus.DONE,
                prState: 'merged',
                branchState: 'merged',
            });
            expect(await missionCount()).toBe(0);
            expect(await count(parent)).toBe(0);
        });

        it('(counter-example) a pull request the provider still answers for as open keeps its slot past that day', async () => {
            const parent = await template({ workId: WORK });
            const old = ago(30 * DAY);
            const waiting = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 36, prState: 'open', workId: WORK },
                { createdAt: old, updatedAt: old },
            );
            const { summary } = await sweepWithProvider(providerSays(36));
            expect(summary).toMatchObject({ scanned: 1, refreshed: 1, failed: 0 });

            const row = await readRow(waiting.id);
            expect(row.prState).toBe('open');
            expect(row.updatedAt.getTime()).toBe(old.getTime());
            expect(await openIds(parent, new Date(NOW.getTime() + 25 * HOUR))).toEqual([
                waiting.id,
            ]);
            expect(await openIds(parent, new Date(NOW.getTime() + 6 * DAY))).toEqual([waiting.id]);
        });

        it('a template with no Work bounds every open pull request by its last write', async () => {
            // Its instances inherit no Work, so the sweep never reads (or writes) them.
            const parent = await template({ workId: null });
            await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 40, prState: 'open' },
                { createdAt: ago(60 * DAY), updatedAt: ago(8 * DAY) },
            );
            const recent = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 41, prState: 'open' },
                { createdAt: ago(60 * DAY), updatedAt: ago(DAY) },
            );
            expect(await openIds(parent)).toEqual([recent.id]);
        });

        it('a run waiting on a human counts for 7 days after it started, then stops', async () => {
            const parent = await template();
            // Old instances with no PR, so only the run can make them count.
            const fresh = await instance(
                parent,
                { status: TaskStatus.IN_PROGRESS },
                {
                    createdAt: ago(30 * DAY),
                },
            );
            await run(fresh.id, 'running', {
                awaitingInput: true,
                startedAt: ago(6 * DAY),
                createdAt: ago(6 * DAY),
            });
            const stale = await instance(
                parent,
                { status: TaskStatus.IN_PROGRESS },
                {
                    createdAt: ago(30 * DAY),
                },
            );
            await run(stale.id, 'running', {
                awaitingInput: true,
                startedAt: ago(8 * DAY),
                createdAt: ago(8 * DAY),
            });
            expect(await openIds(parent)).toEqual([fresh.id]);
        });

        it('a held queued run counts for 7 days after it was queued, then stops', async () => {
            const parent = await template();
            const fresh = await instance(
                parent,
                { status: TaskStatus.TODO },
                {
                    createdAt: ago(30 * DAY),
                },
            );
            await run(fresh.id, 'queued', {
                queuedReason: 'agent-paused',
                createdAt: ago(2 * DAY),
            });
            const stale = await instance(
                parent,
                { status: TaskStatus.TODO },
                {
                    createdAt: ago(30 * DAY),
                },
            );
            await run(stale.id, 'queued', {
                queuedReason: 'agent-paused',
                createdAt: ago(8 * DAY),
            });
            expect(await openIds(parent)).toEqual([fresh.id]);
        });

        it('counts no pull-request outcome yet for 7 days after the spawn, then stops', async () => {
            const parent = await template();
            const justInside = new Date(NOW.getTime() - RECURRENCE_OPEN_INSTANCE_WINDOW_MS + HOUR);
            const outside = new Date(NOW.getTime() - RECURRENCE_OPEN_INSTANCE_WINDOW_MS - HOUR);
            // A failed run left in To do, and a pull request the sweep has not read yet.
            await instance(parent, { status: TaskStatus.TODO }, { createdAt: justInside });
            await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 3, prState: null },
                { createdAt: justInside },
            );
            await instance(parent, { status: TaskStatus.IN_PROGRESS }, { createdAt: outside });
            await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 4, prState: null },
                { createdAt: outside },
            );
            expect(await count(parent)).toBe(2);
        });

        it('holds a pull request closed unmerged for 24 h after it last changed', async () => {
            const parent = await template();
            const longAgo = new Date(NOW.getTime() - 3 * DAY);
            const closedByUpdate = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 5, prState: 'closed' },
                { createdAt: longAgo, updatedAt: new Date(NOW.getTime() - 2 * HOUR) },
            );
            // Closed as the sweep sees it happen: its read writes `prState` and `ciCheckedAt` and
            // keeps `updatedAt`, so the read is what holds the slot.
            const closedBySweep = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 6, prState: 'open' },
                { createdAt: longAgo, updatedAt: longAgo },
            );
            await sweepRead(closedBySweep.id, { prState: 'closed' });
            await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 7, prState: 'closed' },
                { createdAt: longAgo, updatedAt: longAgo },
            );
            expect(await count(parent)).toBe(2);
            // A day after the later of the two, neither holds a slot any more.
            expect(await count(parent, new Date(NOW.getTime() + 25 * HOUR))).toBe(0);
            expect(closedByUpdate.id).toBeTruthy();
        });

        it('frees the slot at once when the pull request merges, or the instance is Done', async () => {
            const parent = await template();
            await instance(parent, {
                status: TaskStatus.IN_REVIEW,
                prNumber: 1,
                prState: 'merged',
            });
            await instance(parent, { status: TaskStatus.DONE });
            await instance(parent, { status: TaskStatus.CANCELLED });
            expect(await count(parent)).toBe(0);
        });

        it('counts only this template’s instances, never the template or another template’s', async () => {
            const parent = await template();
            const other = await template();
            await instance(other, { status: TaskStatus.TODO });
            await instance(parent, { status: TaskStatus.TODO });
            expect(await count(parent)).toBe(1);
            expect(await count(other)).toBe(1);
        });

        it('names the oldest ten and reports the full count', async () => {
            const parent = await template();
            for (let i = 0; i < 12; i += 1) {
                await instance(
                    parent,
                    { status: TaskStatus.TODO },
                    {
                        createdAt: new Date(NOW.getTime() - (20 - i) * HOUR),
                    },
                );
            }
            const open = await repository.countOpenRecurrenceInstances(parent, NOW);
            expect(open.count).toBe(12);
            expect(open.instances).toHaveLength(10);
            const times = open.instances.map((row) => new Date(row.createdAt).getTime());
            expect([...times].sort((a, b) => a - b)).toEqual(times);
            expect(open.instances[0]).toEqual(
                expect.objectContaining({ status: TaskStatus.TODO, prNumber: null, prUrl: null }),
            );
        });

        it('seeks idx_tasks_parent_recurring (EXPLAIN QUERY PLAN)', async () => {
            const parent = await template();
            await instance(parent);
            const qb = taskRows.createQueryBuilder('task').setFindOptions({
                where: recurrenceOpenInstancesWhere(parent, { now: NOW }),
            });
            const [sql, params] = qb.getQueryAndParameters();
            const plan = (await dataSource.query(`EXPLAIN QUERY PLAN ${sql}`, params)) as Array<{
                detail: string;
            }>;
            const details = plan.map((row) => row.detail).join(' | ');
            expect(details).toContain('idx_tasks_parent_recurring');
            expect(details).not.toMatch(/SCAN task/);
        });
    });

    describe('casSkipRecurrence', () => {
        it('advances the slot and stamps the skip, keeping the occurred count and updatedAt', async () => {
            const parent = await template();
            const before = await taskRows.findOneByOrFail({ id: parent.id });
            const next = new Date(NOW.getTime() + 30 * DAY);
            expect(await repository.casSkipRecurrence(parent.id, DUE, next, NOW)).toBe(true);
            const after = await taskRows.findOneByOrFail({ id: parent.id });
            expect(after.nextOccurrenceAt).toEqual(next);
            expect(after.recurrenceSkippedAt).toEqual(NOW);
            expect(after.recurrenceOccurredCount).toBe(4);
            expect(after.updatedAt).toEqual(before.updatedAt);
            // The slot is gone: a second skip (or claim) of it loses.
            expect(await repository.casSkipRecurrence(parent.id, DUE, next, NOW)).toBe(false);
            expect(await repository.casClaimRecurrence(parent.id, DUE, next)).toBe(false);
        });

        it('refuses a paused template', async () => {
            const parent = await template({ recurrencePausedAt: NOW });
            expect(await repository.casSkipRecurrence(parent.id, DUE, null, NOW)).toBe(false);
        });

        it('clearRecurrenceSkip clears only a set marker and keeps updatedAt', async () => {
            const parent = await template({ recurrenceSkippedAt: NOW });
            const before = await taskRows.findOneByOrFail({ id: parent.id });
            expect(await repository.clearRecurrenceSkip(parent.id)).toBe(true);
            const after = await taskRows.findOneByOrFail({ id: parent.id });
            expect(after.recurrenceSkippedAt).toBeNull();
            expect(after.updatedAt).toEqual(before.updatedAt);
            expect(await repository.clearRecurrenceSkip(parent.id)).toBe(false);
        });

        it('a claim clears the skip marker only when asked', async () => {
            const parent = await template({ recurrenceSkippedAt: NOW });
            const next = new Date(NOW.getTime() + DAY);
            expect(await repository.casClaimRecurrence(parent.id, DUE, next)).toBe(true);
            expect((await taskRows.findOneByOrFail({ id: parent.id })).recurrenceSkippedAt).toEqual(
                NOW,
            );
            expect(
                await repository.casClaimRecurrence(parent.id, next, null, { clearSkip: true }),
            ).toBe(true);
            const after = await taskRows.findOneByOrFail({ id: parent.id });
            expect(after.recurrenceSkippedAt).toBeNull();
            expect(after.recurrenceOccurredCount).toBe(6);
        });
    });

    describe('TaskRecurrenceDispatcherService.dispatchDue', () => {
        // One slug sequence for every dispatcher in a case, like the real per-user counter.
        let slugNumber = 1000;

        function dispatcher(
            opts: {
                fireLock?: DistributedTaskLockService;
                tasks?: TaskRepository;
                activity?: Array<Record<string, unknown>>;
            } = {},
        ) {
            const counter = { nextSlug: jest.fn(async () => (slugNumber += 1)) };
            // A dispatch queues a run, exactly what makes a real instance "in flight".
            const transitions = {
                dispatchAgentRun: jest.fn(async (task: Task, agentId: string) => {
                    await runRows.save(
                        runRows.create({
                            agentId,
                            userId: task.userId,
                            triggerKind: 'task',
                            status: 'queued',
                            taskId: task.id,
                        }),
                    );
                    return { dispatched: true, parked: false };
                }),
            };
            const activityLog = {
                log: jest.fn(async (entry: Record<string, unknown>) => {
                    opts.activity?.push(entry);
                    return entry;
                }),
            };
            const service = new TaskRecurrenceDispatcherService(
                (opts.tasks ?? repository) as never,
                counter as never,
                undefined,
                undefined,
                transitions as never,
                undefined,
                opts.fireLock,
                activityLog as never,
            );
            return { service, transitions, activityLog };
        }

        const instancesOf = (parent: Task) =>
            taskRows.find({
                where: { parentRecurringTaskId: parent.id },
                order: { createdAt: 'ASC' },
            });
        const reload = (parent: Task) => taskRows.findOneByOrFail({ id: parent.id });
        /** Make the template due again (the next "day"), keeping everything else. */
        const dueAgain = async (parent: Task, at = DUE) => {
            await taskRows
                .createQueryBuilder()
                .update(Task)
                .set({ nextOccurrenceAt: at })
                .where('id = :id', { id: parent.id })
                .execute();
        };

        it('with no limit (the default) fires exactly as before: no count, no claim', async () => {
            const parent = await template({ recurrenceMaxOpenInstances: null });
            await instance(parent, { status: TaskStatus.IN_REVIEW, prNumber: 1, prState: 'open' });
            const countSpy = jest.spyOn(repository, 'countOpenRecurrenceInstances');
            const lockSpy = jest.spyOn(lock, 'runExclusive');
            try {
                const { service } = dispatcher({ fireLock: lock });
                const summary = await service.dispatchDue(50, NOW);
                expect(summary.spawned).toBe(1);
                expect(countSpy).not.toHaveBeenCalled();
                expect(lockSpy).not.toHaveBeenCalled();
            } finally {
                countSpy.mockRestore();
                lockSpy.mockRestore();
            }
            expect((await reload(parent)).recurrenceOccurredCount).toBe(5);
        });

        it('skips at the limit: the slot advances, the count does not, the skip is recorded', async () => {
            const parent = await template({ recurrenceMaxOpenInstances: 2 });
            const a = await instance(
                parent,
                { status: TaskStatus.IN_REVIEW, prNumber: 11, prState: 'open' },
                { createdAt: new Date(NOW.getTime() - 2 * HOUR) },
            );
            const b = await instance(
                parent,
                { status: TaskStatus.IN_PROGRESS },
                {
                    createdAt: new Date(NOW.getTime() - HOUR),
                },
            );
            await run(b.id, 'running');
            const activity: Array<Record<string, unknown>> = [];
            const { service, transitions } = dispatcher({ fireLock: lock, activity });

            const summary = await service.dispatchDue(50, NOW);

            expect(summary.spawned).toBe(0);
            expect(summary.skipped).toBe(1);
            expect(summary.entries[0]).toEqual(
                expect.objectContaining({
                    outcome: 'skipped',
                    skipReason: 'over-limit',
                    openInstances: 2,
                    maxOpenInstances: 2,
                }),
            );
            expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
            expect(await instancesOf(parent)).toHaveLength(2);
            const after = await reload(parent);
            expect(after.nextOccurrenceAt!.getTime()).toBeGreaterThan(NOW.getTime());
            expect(after.recurrenceOccurredCount).toBe(4);
            expect(after.recurrenceSkippedAt).toEqual(NOW);
            expect(activity).toHaveLength(1);
            expect(activity[0]).toEqual(
                expect.objectContaining({
                    userId: OWNER,
                    tenantId: TENANT,
                    organizationId: ORG,
                    actionType: ActivityActionType.SCHEDULE_SKIPPED,
                    status: ActivityStatus.CANCELLED,
                    summary: `Skipped: 2 instances still open (${a.slug}, ${b.slug}); at most 2 at a time.`,
                    details: expect.objectContaining({
                        reason: 'max-open-instances',
                        scheduleId: `recurring_task:${parent.id}`,
                        openInstances: 2,
                        maxOpenInstances: 2,
                        openInstanceIds: [a.id, b.id],
                        resourceType: 'task',
                        resourceId: parent.id,
                    }),
                }),
            );

            // Still due-scanned? No: the slot passed, so the next tick has nothing to do.
            expect((await service.dispatchDue(50, NOW)).dueCount).toBe(0);
        });

        it('records the first skip of a stall, then at most one skip per UTC day', async () => {
            const parent = await template();
            await instance(parent, { status: TaskStatus.TODO });
            const activity: Array<Record<string, unknown>> = [];
            const { service } = dispatcher({ fireLock: lock, activity });
            const tomorrow = Date.UTC(
                NOW.getUTCFullYear(),
                NOW.getUTCMonth(),
                NOW.getUTCDate() + 1,
            );
            const at = (hours: number) => new Date(tomorrow + hours * HOUR);
            // A fast schedule stalled for two days: five skips, two UTC days.
            for (const when of [at(1), at(1.2), at(20), at(25), at(26)]) {
                await dueAgain(parent, new Date(when.getTime() - 1_000));
                const summary = await service.dispatchDue(50, when);
                expect(summary.entries[0].skipReason).toBe('over-limit');
            }
            expect(
                activity.map((entry) => (entry.details as { scheduledFor: string }).scheduledFor),
            ).toEqual([
                new Date(at(1).getTime() - 1_000).toISOString(),
                new Date(at(25).getTime() - 1_000).toISOString(),
            ]);
            // The Schedules page still shows the latest skip.
            expect((await reload(parent)).recurrenceSkippedAt).toEqual(at(26));
        });

        it('fires again once the open instance finishes, and clears the skip marker', async () => {
            const parent = await template();
            const open = await instance(parent, { status: TaskStatus.IN_PROGRESS });
            await run(open.id, 'running');
            const { service } = dispatcher({ fireLock: lock });
            expect((await service.dispatchDue(50, NOW)).spawned).toBe(0);

            await runRows.update({ taskId: open.id }, { status: 'completed' });
            await taskRows.update(open.id, { status: TaskStatus.DONE });
            await dueAgain(parent);
            const summary = await service.dispatchDue(50, NOW);

            expect(summary.spawned).toBe(1);
            const after = await reload(parent);
            expect(after.recurrenceSkippedAt).toBeNull();
            expect(after.recurrenceOccurredCount).toBe(5);
            expect(await instancesOf(parent)).toHaveLength(2);
        });

        it('fires again as soon as the pull request merges', async () => {
            const parent = await template();
            const open = await instance(parent, {
                status: TaskStatus.IN_REVIEW,
                prNumber: 21,
                prState: 'open',
            });
            const { service } = dispatcher({ fireLock: lock });
            expect((await service.dispatchDue(50, NOW)).spawned).toBe(0);
            await taskRows.update(open.id, { prState: 'merged', branchState: 'merged' });
            await dueAgain(parent);
            expect((await service.dispatchDue(50, NOW)).spawned).toBe(1);
        });

        it('a pull request closed unmerged holds the slot for a day, then frees it', async () => {
            const parent = await template();
            const open = await instance(parent, {
                status: TaskStatus.IN_REVIEW,
                prNumber: 22,
                prState: 'open',
            });
            const { service } = dispatcher({ fireLock: lock });
            // The sweep sees it close (its read writes `prState`, `ciCheckedAt` and `updatedAt`).
            await sweepRead(open.id, { prState: 'closed' });
            expect((await service.dispatchDue(50, NOW)).spawned).toBe(0);

            const nextDay = new Date(NOW.getTime() + 25 * HOUR);
            await dueAgain(parent, new Date(nextDay.getTime() - 60_000));
            expect((await service.dispatchDue(50, nextDay)).spawned).toBe(1);
        });

        it('below the limit it fires and the new instance counts at once', async () => {
            const parent = await template({ recurrenceMaxOpenInstances: 2 });
            await instance(parent, { status: TaskStatus.TODO });
            const { service } = dispatcher({ fireLock: lock });
            expect((await service.dispatchDue(50, NOW)).spawned).toBe(1);
            expect(await count(parent)).toBe(2);
            await dueAgain(parent);
            expect((await service.dispatchDue(50, NOW)).entries[0].skipReason).toBe('over-limit');
        });

        it('defers (slot untouched) while a run-now of the template holds the shared claim', async () => {
            const parent = await template();
            const { service } = dispatcher({ fireLock: lock });
            const held = await lock.runExclusive(recurrenceFireLockKey(parent.id), () =>
                service.dispatchDue(50, NOW),
            );
            expect(held.acquired).toBe(true);
            expect(held.result!.entries[0]).toEqual(
                expect.objectContaining({ outcome: 'skipped', skipReason: 'busy' }),
            );
            const after = await reload(parent);
            expect(after.nextOccurrenceAt).toEqual(DUE);
            expect(after.recurrenceSkippedAt ?? null).toBeNull();
            // Released: the next tick fires it.
            expect((await service.dispatchDue(50, NOW)).spawned).toBe(1);
        });

        /**
         * The count must run INSIDE the claim. A tick starts while a run-now of the same template
         * holds the claim and has not inserted its instance yet; the run-now inserts and releases;
         * only then does the tick get the claim. Counting inside the claim, the tick sees the
         * run-now's instance and skips. A tick that counted before taking the claim would carry a
         * stale 0 in and spawn past the limit (the reviewer's mutant of #3146 does exactly that).
         */
        it('a tick that waits on a run-now counts what that run-now spawned, and skips', async () => {
            const parent = await template({ recurrenceMaxOpenInstances: 1 });
            let runNowHolds!: () => void;
            const runNowHolding = new Promise<void>((resolve) => (runNowHolds = resolve));
            let tickAtClaim!: () => void;
            const tickReachedClaim = new Promise<void>((resolve) => (tickAtClaim = resolve));
            let releaseTick!: () => void;
            const runNowDone = new Promise<void>((resolve) => (releaseTick = resolve));
            // The tick's view of the shared claim: it reports that it reached the claim, then
            // waits for the run-now to finish before asking the real lock.
            const tickLock = {
                runExclusive: async <T>(
                    key: string,
                    fn: () => Promise<T>,
                    options?: Record<string, unknown>,
                ) => {
                    tickAtClaim();
                    await runNowDone;
                    return lock.runExclusive(key, fn, options);
                },
            };
            let runNowInstance: Task | null = null;
            const runNow = lock.runExclusive(recurrenceFireLockKey(parent.id), async () => {
                runNowHolds();
                await tickReachedClaim;
                runNowInstance = await instance(parent, { status: TaskStatus.TODO });
                await run(runNowInstance.id, 'queued');
            });
            await runNowHolding;
            const tick = dispatcher({ fireLock: tickLock as never }).service.dispatchDue(50, NOW);
            expect((await runNow).acquired).toBe(true);
            releaseTick();
            const summary = await tick;

            expect(summary.spawned).toBe(0);
            expect(summary.entries[0]).toEqual(
                expect.objectContaining({
                    outcome: 'skipped',
                    skipReason: 'over-limit',
                    openInstances: 1,
                }),
            );
            expect((await instancesOf(parent)).map((row) => row.id)).toEqual([runNowInstance!.id]);
            const after = await reload(parent);
            expect(after.nextOccurrenceAt!.getTime()).toBeGreaterThan(NOW.getTime());
            expect(after.recurrenceOccurredCount).toBe(4);
        });

        /**
         * The race the claim exists for: a backlogged template (two slots already due) and two
         * dispatchers. A reads, counts 0 and claims slot 1, then stalls before inserting; B reads
         * the template at slot 2 meanwhile. With the SHARED claim, B is refused and leaves slot
         * 2 due; with separate per-process claims (no shared lock) B counts 0 too and both spawn,
         * which is what an unguarded count would do.
         */
        async function race(shared: boolean): Promise<number> {
            const parent = await template({
                nextOccurrenceAt: new Date(NOW.getTime() - 2 * DAY),
                recurrenceCron: '0 0 * * *',
            });
            let releaseA!: () => void;
            const aMayInsert = new Promise<void>((resolve) => (releaseA = resolve));
            let aIsInserting!: () => void;
            const aReachedInsert = new Promise<void>((resolve) => (aIsInserting = resolve));
            // A's repository stalls its instance insert until B has run.
            const stalling = Object.create(repository) as TaskRepository;
            stalling.create = async (data, manager) => {
                aIsInserting();
                await aMayInsert;
                return repository.create(data, manager);
            };
            const a = dispatcher({ tasks: stalling, fireLock: shared ? lock : undefined });
            const b = dispatcher({ fireLock: shared ? lock : undefined });
            const aDone = a.service.dispatchDue(50, NOW);
            await aReachedInsert;
            const bSummary = await b.service.dispatchDue(50, NOW);
            releaseA();
            const aSummary = await aDone;
            expect(aSummary.spawned).toBe(1);
            if (shared) {
                expect(bSummary.entries[0]).toEqual(
                    expect.objectContaining({ outcome: 'skipped', skipReason: 'busy' }),
                );
            }
            return (await instancesOf(parent)).length;
        }

        it('two dispatchers racing on one template spawn ONE instance under the shared claim', async () => {
            expect(await race(true)).toBe(1);
        });

        it('(control) without a shared claim the same race spawns past the limit', async () => {
            expect(await race(false)).toBe(2);
        });
    });
});
