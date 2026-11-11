import { randomUUID } from 'node:crypto';
import { DataSource, type Repository } from 'typeorm';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import { ENTITIES } from '../_entities-inventory';
import { Task, TaskPriority, TaskStatus } from '../../entities/task.entity';
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
 *     instant. A rate limit defers the owner's reads made with the same credential (the
 *     facade picks one per Work) to the provider's reset, never making a row due earlier.
 *  2. **"Not found" counted from the last successful read.** After a gap in reads, one answer
 *     confirmed at once. It is now confirmed 30 minutes after the FIRST "not found" answer.
 *
 * A failed read is never an answer: none of these cases changes `prState`, the CI cache,
 * `ciCheckedAt` or `updatedAt`.
 */
describe('PR-status sweep: failed reads back off (real SQLite)', () => {
    let dataSource: DataSource;
    let taskRows: Repository<Task>;
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

    /**
     * The Works the Work double resolves, with what the git facade picks the credential by: the
     * provider and, for a repository connected through an app installation, its id.
     */
    const workFixtures = new Map<string, { gitProvider: string; installationId?: string }>();
    /** Each owner's default Work: read with the owner's own account. */
    let workOf: Record<string, string>;
    const addWork = (gitProvider: string, installationId?: string) => {
        const id = randomUUID();
        workFixtures.set(id, { gitProvider, installationId });
        return id;
    };

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
        repository = new TaskRepository(taskRows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        at(T0);
        await taskRows.clear();
        workFixtures.clear();
        workOf = { [BROKEN]: addWork('github'), [HEALTHY]: addWork('github') };
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
                workId: workOf[userId],
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
            findById: async (id: string) => {
                const fixture = workFixtures.get(id) ?? { gitProvider: 'github' };
                return {
                    id,
                    gitProvider: fixture.gitProvider,
                    storageProvider: 'user-github',
                    sourceRepository: fixture.installationId
                        ? {
                              auth: {
                                  mode: 'github_app_installation',
                                  providerId: 'github',
                                  installationId: fixture.installationId,
                              },
                          }
                        : undefined,
                    taskIsolationBaseBranch: null,
                    getRepoOwner: () => 'acme',
                    getDataRepo: () => 'widgets',
                };
            },
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
        const resetAt = T0 + 40 * MINUTE;
        const limited = () =>
            httpError(403, 'API rate limit exceeded', {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(resetAt / 1000),
            });

        /**
         * The review of #3169: the facade picks the credential PER WORK (the platform token, an
         * app installation, or the owner's account), so a limit on one installation says nothing
         * about the owner's other installation or own account. On `develop` every other row of the
         * owner in the batch made the same call (25 per tick) and no other owner was read.
         */
        it('defers only the pull requests read with the spent credential, skips them in the tick without a call, and reads everything else in the same tick', async () => {
            const workA = addWork('github', 'X');
            const workC = addWork('github', 'X');
            const workB = addWork('github', 'Y');
            const ownAccount = workOf[BROKEN];
            const onA: Task[] = [];
            for (let i = 0; i < PR_STATUS_SYNC_BATCH + 5; i += 1) {
                onA.push(await openPr(BROKEN, new Date(T0 - 10 * MINUTE), { workId: workA }));
            }
            const onC = await openPr(BROKEN, new Date(T0 - 9 * MINUTE), { workId: workC });
            const onB = await openPr(BROKEN, new Date(T0 - 9 * MINUTE), { workId: workB });
            const onOwnAccount = await openPr(BROKEN, new Date(T0 - 9 * MINUTE));
            const otherOwner = await openPr(HEALTHY, new Date(T0 - 3 * MINUTE));
            let spent = true;
            const onX = (call: { workId: string }) =>
                call.workId === workA || call.workId === workC;
            const { tick, calls } = sweeper((call) =>
                onX(call) && spent ? limited() : providerSays(call.prNumber),
            );

            at(T0);
            const summary = await tick();

            const xCalls = () => calls.filter(onX).length;
            const callsOn = (workId: string) => calls.filter((call) => call.workId === workId);
            // One call learnt that installation X is spent; nothing else read with it.
            expect(xCalls()).toBe(1);
            // Installation Y, the owner's own account and the other owner: all read this tick.
            expect(callsOn(workB)).toHaveLength(1);
            expect(callsOn(ownAccount)).toHaveLength(1);
            expect(calls.filter((call) => call.userId === HEALTHY)).toHaveLength(1);
            expect(summary).toMatchObject({ failed: 1, refreshed: 3, deferred: 24 });
            for (const row of [...onA, onC]) {
                const after = await readRow(row.id);
                expect(after.prReadRetryAt!.getTime()).toBe(resetAt);
                expect(after).toMatchObject({
                    prState: 'open',
                    ciState: 'passing',
                    prNotFoundSince: null,
                });
                expect(after.ciCheckedAt!.getTime()).toBeLessThan(T0);
                expect(after.updatedAt.getTime()).toBe(LONG_AGO.getTime());
            }
            for (const row of [onB, onOwnAccount, otherOwner]) {
                const after = await readRow(row.id);
                expect(after.prReadRetryAt).toBeNull();
                expect(after.ciCheckedAt!.getTime()).toBe(T0);
            }

            // Next tick: installation X is still left alone.
            at(T0 + 2 * MINUTE);
            await tick();
            expect(xCalls()).toBe(1);

            // From the reset its pull requests are read again, a batch at a time.
            spent = false;
            at(resetAt);
            await tick();
            at(resetAt + 2 * MINUTE);
            await tick();
            expect(xCalls()).toBe(1 + onA.length + 1);
            for (const row of [...onA, onC]) {
                expect((await readRow(row.id)).prReadRetryAt).toBeNull();
            }
        });

        /**
         * The review of #3169: the deferral used to set the reset on every row of the owner, which
         * pulled a "not found" row FORWARD from its 6-hourly re-check to the reset, an extra call
         * landing just as the budget refilled.
         */
        it('never makes a row due earlier than it already was', async () => {
            const workA = addWork('github', 'X');
            // Recorded "not found" and re-checked an hour ago: next due 5 h from now.
            const goneLater = await openPr(BROKEN, new Date(T0 - HOUR), {
                workId: workA,
                prState: TASK_PR_NOT_FOUND_STATE,
                ciState: null,
            });
            // Re-checked 5 h 50 min ago: due 10 minutes from now, before the reset.
            const goneSooner = await openPr(BROKEN, new Date(T0 - 5 * HOUR - 50 * MINUTE), {
                workId: workA,
                prState: TASK_PR_NOT_FOUND_STATE,
                ciState: null,
            });
            const failing = await openPr(BROKEN, new Date(T0 - 2 * HOUR), { workId: workA });
            const backingOffLonger = new Date(resetAt + HOUR);
            await repository.updatePrStatusCache(failing.id, { prReadRetryAt: backingOffLonger });
            const trigger = await openPr(BROKEN, new Date(T0 - 10 * MINUTE), { workId: workA });
            let spent = true;
            const { tick, calls } = sweeper((call) =>
                call.prNumber === trigger.prNumber && spent ? limited() : null,
            );

            at(T0);
            await tick();

            expect(calls.map((call) => call.prNumber)).toEqual([trigger.prNumber]);
            expect((await readRow(trigger.id)).prReadRetryAt!.getTime()).toBe(resetAt);
            // Due after the reset anyway: left exactly as they were.
            expect((await readRow(goneLater.id)).prReadRetryAt).toBeNull();
            expect((await readRow(failing.id)).prReadRetryAt!.getTime()).toBe(
                backingOffLonger.getTime(),
            );
            // Due before the reset: waits for it.
            expect((await readRow(goneSooner.id)).prReadRetryAt!.getTime()).toBe(resetAt);

            // At the reset the "not found" re-check that was due 5 h out is still not read.
            spent = false;
            at(resetAt);
            await tick();
            expect(calls.some((call) => call.prNumber === goneLater.prNumber)).toBe(false);
            expect(calls.some((call) => call.prNumber === goneSooner.prNumber)).toBe(true);
            // Its own 6-hourly re-check, as before the rate limit.
            at(T0 + 5 * HOUR + MINUTE);
            await tick();
            expect(calls.some((call) => call.prNumber === goneLater.prNumber)).toBe(true);
        });
    });

    /**
     * The review of #3169: every writer clamps a retry instant to 6 hours, but one written under a
     * clock that was ahead (or by hand) was obeyed until then, and a failed `refresh=true` could
     * not clear it. The same for a first "not found" stamped in the future.
     */
    describe('a stored instant beyond the 6-hour ceiling', () => {
        it('a retry instant a year ahead is not obeyed: the row is read on the usual cadence, and a failed read replaces it', async () => {
            const row = await openPr(BROKEN, new Date(T0 - 10 * MINUTE));
            const yearAhead = new Date(T0 + 365 * DAY);
            await repository.updatePrStatusCache(row.id, { prReadRetryAt: yearAhead });
            const { tick, calls, service } = sweeper(() => httpError(502, 'Bad gateway'));

            at(T0);
            await tick();
            expect(calls).toHaveLength(1);
            // The failed read wrote a real backoff (10 min: as long as it has gone unseen).
            const after = await readRow(row.id);
            expect(after.prReadRetryAt!.getTime()).toBe(T0 + 10 * MINUTE);

            // The on-demand read does not serve a year-ahead instant from the cache either.
            await repository.updatePrStatusCache(row.id, { prReadRetryAt: yearAhead });
            const view = await service.getForTask(BROKEN, row.id);
            expect(view.cached).toBe(true);
            expect(calls).toHaveLength(2);
            expect((await readRow(row.id)).prReadRetryAt!.getTime()).toBeLessThanOrEqual(
                T0 + TASK_PR_READ_RETRY_CAP_MS,
            );
        });

        it('a first "not found" stamped a year ahead counts as this answer: confirmed 30 minutes later', async () => {
            const row = await openPr(BROKEN, new Date(T0 - 3 * HOUR));
            await repository.updatePrStatusCache(row.id, {
                prNotFoundSince: new Date(T0 + 365 * DAY),
            });
            const { tick, calls } = sweeper(() => null);

            at(T0);
            await tick();
            const pending = await readRow(row.id);
            expect(pending.prState).toBe('open');
            expect(pending.prNotFoundSince!.getTime()).toBe(T0);

            at(T0 + TASK_PR_NOT_FOUND_CONFIRM_MS);
            await tick();
            expect(calls).toHaveLength(2);
            expect((await readRow(row.id)).prState).toBe(TASK_PR_NOT_FOUND_STATE);
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
