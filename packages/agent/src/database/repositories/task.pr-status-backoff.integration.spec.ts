import { DataSource, type Repository } from 'typeorm';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import { ENTITIES } from '../_entities-inventory';
import { Task, TaskPriority, TaskStatus } from '../../entities/task.entity';
import { Work } from '../../entities/work.entity';
import type { GitFacadeService } from '../../facades/git.facade';
import {
    TASK_PR_NOT_FOUND_CONFIRM_MS,
    TASK_PR_NOT_FOUND_STATE,
} from '../../tasks-domain/task-open-work';
import { TASK_PR_READ_RETRY_CAP_MS } from '../../tasks-domain/task-pr-read-retry';
import {
    PR_STATUS_SYNC_BATCH,
    TaskPrStatusService,
} from '../../tasks-domain/task-pr-status.service';
import type { WorkRepository } from './work.repository';
import { TaskRepository } from './task.repository';

/**
 * The PR-status sweep (`TaskPrStatusService.syncDuePrStatuses`) on REAL better-sqlite3, through
 * the real `TaskRepository`, with a clock that moves (Date only) and a provider double that
 * answers per owner.
 *
 * What it pins, from the closure review of #3158:
 *
 *  1. **Cross-tenant stall.** A read that throws (credentials removed, a refusal, an outage)
 *     stamped nothing, so its row kept its stale `ciCheckedAt` and sorted first on every tick: 25
 *     of them (the batch size, one owner's worth) and nobody else's pull request was read again.
 *     A failed read now backs off (`prReadRetryAt`), and a retry waits its turn by its retry
 *     instant. A rate limit defers every read of the owner's connection to the provider's reset.
 *  2. **"Not found" counted from the last successful read.** After a gap in reads, one answer
 *     confirmed at once. It is now confirmed 30 minutes after the FIRST "not found" answer.
 *
 * A failed read is never an answer: none of these cases changes `prState`, the CI cache,
 * `ciCheckedAt` or `updatedAt`.
 */
describe('PR-status sweep: failed reads back off (real SQLite)', () => {
    let dataSource: DataSource;
    let taskRows: Repository<Task>;
    let workRows: Repository<Work>;
    let repository: TaskRepository;
    let slugSeq = 0;

    const BROKEN = '11111111-1111-4111-8111-111111111111';
    const HEALTHY = '22222222-2222-4222-8222-222222222222';
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    // The wall clock at the start of the run, to the minute: the sweep's clock starts there, so a
    // sweep that reads the wall clock instead (as `develop`'s did) sees the same first tick.
    const T0 = Math.floor(Date.now() / MINUTE) * MINUTE;
    const LONG_AGO = new Date(T0 - 30 * DAY);

    /** Provider id per Work id: the service reads it from the Work double, the deferral from SQL. */
    const providerOf = new Map<string, string>();
    let ghWorkOf: Record<string, string>;
    let glWork: string;

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
        workRows = dataSource.getRepository(Work);
        repository = new TaskRepository(taskRows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        at(T0);
        await taskRows.clear();
        await workRows.clear();
        providerOf.clear();
        const work = async (userId: string, gitProvider: string) => {
            slugSeq += 1;
            const row = await workRows.save(
                workRows.create({
                    userId,
                    name: `work-${slugSeq}`,
                    slug: `work-${slugSeq}`,
                    description: 'Sweep fixture',
                    gitProvider,
                } as Partial<Work>),
            );
            providerOf.set(row.id, gitProvider);
            return row.id;
        };
        ghWorkOf = {
            [BROKEN]: await work(BROKEN, 'github'),
            [HEALTHY]: await work(HEALTHY, 'github'),
        };
        glWork = await work(BROKEN, 'gitlab');
    });

    /**
     * The sweep's clock (`TaskPrStatusService.clock`). Not jest's fake timers: a faked global
     * `Date` makes TypeORM hand `Date` columns back as strings on SQLite.
     */
    let now = T0;
    const at = (ms: number) => {
        now = ms;
    };

    /** An open pull request of `userId`, last read successfully at `lastRead` (`null`: never). */
    async function openPr(
        userId: string,
        lastRead: Date | null,
        over: Partial<Task> = {},
    ): Promise<Task> {
        slugSeq += 1;
        const row = await taskRows.save(
            taskRows.create({
                userId,
                slug: `T-${slugSeq}`,
                title: 'Waiting for review',
                status: TaskStatus.IN_REVIEW,
                priority: TaskPriority.P3,
                createdByType: 'user',
                createdById: userId,
                workId: ghWorkOf[userId],
                branchRef: `task/t-${slugSeq}`,
                branchState: 'pr-open',
                prNumber: slugSeq,
                prState: 'open',
                ciState: 'passing',
                ...over,
            } as Partial<Task>),
        );
        // The update builder would set `updatedAt` to now unless the SET names it.
        await taskRows
            .createQueryBuilder()
            .update(Task)
            .set({ createdAt: LONG_AGO, updatedAt: LONG_AGO, ciCheckedAt: lastRead })
            .where('id = :id', { id: row.id })
            .execute();
        return taskRows.findOneByOrFail({ id: row.id });
    }

    const readRow = (id: string) => taskRows.findOneByOrFail({ id });

    const providerSays = (number: number, state: GitPullRequestStatus['state'] = 'open') => ({
        number,
        state,
        merged: state === 'merged',
        headSha: 'c'.repeat(40),
        ciState: 'passing' as const,
        checks: [],
    });

    /** What a git provider's HTTP client throws: an error with the response status. */
    const httpError = (status: number, message: string, headers: Record<string, string> = {}) =>
        Object.assign(new Error(message), {
            status,
            response: { status, headers, data: { message } },
        });

    type Answer = (task: { userId: string; workId: string; prNumber: number }) => unknown;

    /**
     * The real sweep against a provider whose answer is `answer(...)`: a status, `null` ("not
     * found"), or an Error, which is thrown. Every call is recorded by owner, Work and number.
     */
    function sweeper(answer: Answer) {
        const calls: Array<{ userId: string; workId: string; prNumber: number }> = [];
        const git = {
            getPullRequestStatus: jest.fn(
                async (
                    _owner: string,
                    _repo: string,
                    prNumber: number,
                    options: { userId: string; workId: string },
                ) => {
                    const call = { userId: options.userId, workId: options.workId, prNumber };
                    calls.push(call);
                    const result = answer(call);
                    if (result instanceof Error) throw result;
                    return result;
                },
            ),
        };
        const works = {
            findById: async (id: string) => ({
                id,
                gitProvider: providerOf.get(id) ?? 'github',
                taskIsolationBaseBranch: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'widgets',
            }),
        };
        const service = new TaskPrStatusService(
            repository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
        );
        service.clock = () => new Date(now);
        // The cron's own call: default batch (25) and staleness (2 minutes).
        const tick = () => service.syncDuePrStatuses();
        return { tick, calls, service };
    }

    describe('a read that throws', () => {
        /**
         * The review's repro: 25 rows whose read throws ("Bad credentials" after their owner
         * disconnected the git account) and one healthy row. On `develop` the healthy row is read in
         * none of the ten ticks, and each broken row is re-read on every tick.
         */
        it('25+ rows whose read throws no longer stall the sweep: another owner’s pull request is read within two ticks, and keeps being read', async () => {
            const broken: Task[] = [];
            for (let i = 0; i < PR_STATUS_SYNC_BATCH + 5; i += 1) {
                broken.push(await openPr(BROKEN, new Date(T0 - 10 * MINUTE)));
            }
            const healthy = await openPr(HEALTHY, new Date(T0 - 3 * MINUTE));
            const { tick, calls } = sweeper((call) =>
                call.userId === BROKEN
                    ? httpError(401, 'Bad credentials')
                    : providerSays(call.prNumber),
            );

            const healthyReadAt: number[] = [];
            for (let n = 0; n < 10; n += 1) {
                at(T0 + n * 2 * MINUTE);
                const before = calls.filter((call) => call.userId === HEALTHY).length;
                await tick();
                if (calls.filter((call) => call.userId === HEALTHY).length > before) {
                    healthyReadAt.push(n);
                }
            }

            // Read on the second tick at the latest, then on every tick it is due (the 2-minute
            // staleness makes that every other tick), never starved by the broken rows.
            expect(healthyReadAt[0]).toBeLessThanOrEqual(1);
            expect(healthyReadAt.length).toBeGreaterThanOrEqual(4);
            expect((await readRow(healthy.id)).ciCheckedAt!.getTime()).toBeGreaterThan(T0);

            // Each broken row was read at most twice in 20 minutes (on `develop`: up to every tick).
            const perRow = new Map<number, number>();
            for (const call of calls.filter((c) => c.userId === BROKEN)) {
                perRow.set(call.prNumber, (perRow.get(call.prNumber) ?? 0) + 1);
            }
            expect(perRow.size).toBe(broken.length);
            expect(Math.max(...perRow.values())).toBeLessThanOrEqual(2);

            // A failed read is not an answer: nothing the pull request shows moved.
            for (const row of broken) {
                const after = await readRow(row.id);
                expect(after).toMatchObject({
                    prState: 'open',
                    ciState: 'passing',
                    prNotFoundSince: null,
                });
                expect(after.ciCheckedAt!.getTime()).toBe(T0 - 10 * MINUTE);
                expect(after.updatedAt.getTime()).toBe(LONG_AGO.getTime());
                expect(after.prReadRetryAt!.getTime()).toBeGreaterThan(T0 + 18 * MINUTE);
            }
        });

        it('backs off as long as the pull request has gone unseen, doubling up to 6 hours, and asks nothing in between', async () => {
            const row = await openPr(BROKEN, new Date(T0 - 4 * MINUTE));
            const { tick, calls } = sweeper(() => httpError(502, 'Bad gateway'));

            const waits: number[] = [];
            let readAt = T0;
            for (let attempt = 0; attempt < 9; attempt += 1) {
                at(readAt);
                await tick();
                expect(calls).toHaveLength(attempt + 1);
                const retryAt = (await readRow(row.id)).prReadRetryAt!.getTime();
                waits.push((retryAt - readAt) / MINUTE);
                // A minute before the retry instant the row is not due: no provider call.
                at(retryAt - MINUTE);
                await tick();
                expect(calls).toHaveLength(attempt + 1);
                readAt = retryAt;
            }

            expect(waits).toEqual([4, 8, 16, 32, 64, 128, 256, 360, 360]);
            expect(TASK_PR_READ_RETRY_CAP_MS).toBe(360 * MINUTE);
            const after = await readRow(row.id);
            expect(after).toMatchObject({
                prState: 'open',
                ciState: 'passing',
                prNotFoundSince: null,
            });
            expect(after.ciCheckedAt!.getTime()).toBe(T0 - 4 * MINUTE);
        });

        it('a credential that comes back is read at its retry instant and returns to the usual cadence', async () => {
            const row = await openPr(BROKEN, new Date(T0 - 4 * MINUTE));
            let healthy = false;
            const { tick, calls } = sweeper((call) =>
                healthy ? providerSays(call.prNumber) : httpError(401, 'Bad credentials'),
            );
            at(T0);
            await tick();
            const retryAt = (await readRow(row.id)).prReadRetryAt!.getTime();
            at(retryAt);
            await tick();
            expect(calls).toHaveLength(2);

            // Reconnected: the next retry succeeds and ends the backoff.
            healthy = true;
            const next = (await readRow(row.id)).prReadRetryAt!.getTime();
            at(next);
            await tick();
            expect(calls).toHaveLength(3);
            const recovered = await readRow(row.id);
            expect(recovered).toMatchObject({
                prReadRetryAt: null,
                prNotFoundSince: null,
                prState: 'open',
            });
            expect(recovered.ciCheckedAt!.getTime()).toBe(next);

            // The usual cadence: not due within the 2-minute staleness, due right after it.
            at(next + MINUTE);
            await tick();
            expect(calls).toHaveLength(3);
            at(next + 2 * MINUTE + 1_000);
            await tick();
            expect(calls).toHaveLength(4);
        });
    });

    describe('a rate limit', () => {
        /**
         * One read learns the connection is spent; on `develop` every other row of the owner in the
         * batch made the same call (25 per tick), and the other owner was not read at all.
         */
        it('defers every read of the owner’s connection to the reset, skips the rest of the batch without a call, and reads another owner in the same tick', async () => {
            const resetAt = T0 + 40 * MINUTE;
            const limited: Task[] = [];
            for (let i = 0; i < PR_STATUS_SYNC_BATCH + 5; i += 1) {
                limited.push(await openPr(BROKEN, new Date(T0 - 10 * MINUTE)));
            }
            // The same owner on another provider: a different connection, not deferred.
            const otherProvider = await openPr(BROKEN, new Date(T0 - 9 * MINUTE), {
                workId: glWork,
            });
            const otherOwner = await openPr(HEALTHY, new Date(T0 - 3 * MINUTE));
            let spent = true;
            const { tick, calls } = sweeper((call) =>
                call.userId === BROKEN && call.workId !== glWork && spent
                    ? httpError(403, 'API rate limit exceeded', {
                          'x-ratelimit-remaining': '0',
                          'x-ratelimit-reset': String(resetAt / 1000),
                      })
                    : providerSays(call.prNumber),
            );

            at(T0);
            const summary = await tick();

            const limitedCalls = () =>
                calls.filter((call) => call.userId === BROKEN && call.workId !== glWork).length;
            expect(limitedCalls()).toBe(1);
            expect(calls.filter((call) => call.userId === HEALTHY)).toHaveLength(1);
            expect(summary).toMatchObject({ failed: 1, refreshed: 1, deferred: 25 });
            for (const row of limited) {
                const after = await readRow(row.id);
                expect(after.prReadRetryAt!.getTime()).toBe(resetAt);
                expect(after).toMatchObject({
                    prState: 'open',
                    ciState: 'passing',
                    prNotFoundSince: null,
                });
                expect(after.ciCheckedAt!.getTime()).toBe(T0 - 10 * MINUTE);
                expect(after.updatedAt.getTime()).toBe(LONG_AGO.getTime());
            }
            expect((await readRow(otherProvider.id)).prReadRetryAt).toBeNull();
            expect((await readRow(otherOwner.id)).ciCheckedAt!.getTime()).toBe(T0);

            // Next tick: the owner's other connection is read; the spent one is still left alone.
            at(T0 + 2 * MINUTE);
            await tick();
            expect(calls.filter((call) => call.workId === glWork)).toHaveLength(1);
            expect(limitedCalls()).toBe(1);

            // From the reset the deferred rows are read again, a batch at a time (sharing it with
            // the rows last read before the reset), and each successful read ends its deferral.
            spent = false;
            at(resetAt);
            await tick();
            at(resetAt + 2 * MINUTE);
            await tick();
            expect(limitedCalls()).toBe(1 + limited.length);
            for (const row of limited) {
                expect((await readRow(row.id)).prReadRetryAt).toBeNull();
            }
        });
    });

    describe('"not found"', () => {
        /**
         * The review's (b2): the last successful read was 3 hours ago (the sweep was down, or had
         * more open pull requests than it reads in 30 minutes). On `develop` the first "not found"
         * answer was recorded at once.
         */
        it('a single "not found" after a long gap in reads is recorded only 30 minutes after that first answer', async () => {
            const row = await openPr(BROKEN, new Date(T0 - 3 * HOUR));
            const { tick, calls } = sweeper(() => null);

            for (let n = 0; n < 15; n += 1) {
                at(T0 + n * 2 * MINUTE);
                await tick();
                const pending = await readRow(row.id);
                expect(pending).toMatchObject({ prState: 'open', ciState: 'passing' });
                expect(pending.prNotFoundSince!.getTime()).toBe(T0);
                expect(pending.ciCheckedAt!.getTime()).toBe(T0 - 3 * HOUR);
            }
            // The first answer, then nothing until the 30 minutes are up.
            expect(calls).toHaveLength(1);
            expect((await readRow(row.id)).prReadRetryAt!.getTime()).toBe(
                T0 + TASK_PR_NOT_FOUND_CONFIRM_MS,
            );

            at(T0 + TASK_PR_NOT_FOUND_CONFIRM_MS);
            await tick();
            expect(calls).toHaveLength(2);
            const confirmed = await readRow(row.id);
            expect(confirmed).toMatchObject({
                prState: TASK_PR_NOT_FOUND_STATE,
                ciState: null,
                prChecks: null,
                prReadRetryAt: null,
                prNotFoundSince: null,
            });
            expect(confirmed.ciCheckedAt!.getTime()).toBe(T0 + TASK_PR_NOT_FOUND_CONFIRM_MS);
            expect(confirmed.updatedAt.getTime()).toBe(LONG_AGO.getTime());
        });

        it('a successful read in between starts the 30 minutes afresh', async () => {
            const row = await openPr(BROKEN, new Date(T0 - 4 * MINUTE));
            let visible = false;
            const { tick } = sweeper((call) => (visible ? providerSays(call.prNumber) : null));

            at(T0);
            await tick();
            expect((await readRow(row.id)).prNotFoundSince!.getTime()).toBe(T0);

            // Seen again on the retry: the run of "not found" answers is over.
            visible = true;
            const retryAt = (await readRow(row.id)).prReadRetryAt!.getTime();
            at(retryAt);
            await tick();
            expect(await readRow(row.id)).toMatchObject({
                prNotFoundSince: null,
                prReadRetryAt: null,
            });

            // Gone again 31 minutes after the FIRST answer: a new first answer, not a confirmation.
            visible = false;
            at(T0 + TASK_PR_NOT_FOUND_CONFIRM_MS + MINUTE);
            await tick();
            const again = await readRow(row.id);
            expect(again.prState).toBe('open');
            expect(again.prNotFoundSince!.getTime()).toBe(
                T0 + TASK_PR_NOT_FOUND_CONFIRM_MS + MINUTE,
            );
        });

        it('a read that throws in between is not an answer: it neither confirms nor restarts the 30 minutes', async () => {
            const row = await openPr(BROKEN, new Date(T0 - 4 * MINUTE));
            let answer: unknown = null;
            const { tick, calls } = sweeper(() => answer);

            at(T0);
            await tick();
            answer = httpError(503, 'Service unavailable');
            at((await readRow(row.id)).prReadRetryAt!.getTime());
            await tick();
            expect(calls).toHaveLength(2);
            const afterThrow = await readRow(row.id);
            expect(afterThrow.prState).toBe('open');
            expect(afterThrow.prNotFoundSince!.getTime()).toBe(T0);

            // Still "not found" once the 30 minutes since the first answer are up: recorded.
            answer = null;
            at(T0 + TASK_PR_NOT_FOUND_CONFIRM_MS);
            await tick();
            expect((await readRow(row.id)).prState).toBe(TASK_PR_NOT_FOUND_STATE);
        });
    });
});
