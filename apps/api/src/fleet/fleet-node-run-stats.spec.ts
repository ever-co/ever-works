import {
    buildNodeRunStats,
    nodeRunStatsRunIds,
    readNodeRunStats,
    type NodeRunOutcome,
} from './fleet-node-run-stats';
import {
    buildNodeJobHistory,
    isFailedJobOutcome,
    isFailedNodeHistoryEntry,
    type NodeHistorySourceJob,
} from './fleet-node-history';

const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const RUN_B = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const TASK = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';

const outcome = (over: Partial<NodeRunOutcome> = {}): NodeRunOutcome => ({
    jobId: 'job-1',
    status: 'done',
    costCents: 0,
    recent: true,
    runId: RUN_A,
    taskId: TASK,
    ...over,
});

/**
 * A node's run statistics — the counting rule (PR #3131 review, item 3).
 *
 * A failed agent run is stored as a `done` job: the node did its work, the
 * run did not succeed. The outcome is on the run, and the node history
 * already judges by it; these figures must judge the same way.
 */
describe('isFailedJobOutcome — the node history`s rule on two statuses', () => {
    it.each([
        // job status, run status, failed?
        ['done', 'failed', true],
        ['done', 'completed', false],
        ['failed', 'completed', false],
        ['failed', 'failed', true],
        ['done', 'running', false],
        ['done', 'cancelled', false],
        ['done', 'queued', false],
        // No run known: the job's own status speaks.
        ['done', null, false],
        ['failed', null, true],
        ['failed', undefined, true],
        ['failed', '', true],
    ] as const)('job %s + run %s → failed: %s', (jobStatus, runStatus, failed) => {
        expect(isFailedJobOutcome(jobStatus, runStatus)).toBe(failed);
    });
});

describe('buildNodeRunStats', () => {
    it('counts a `done` job whose run failed as a failure — never "N finished, 0 failed"', () => {
        const outcomes = [
            outcome({ jobId: 'j1', runId: RUN_A }),
            outcome({ jobId: 'j2', runId: RUN_B, recent: false, costCents: 40 }),
        ];
        const runStatuses = new Map([
            [RUN_A, 'failed'],
            [RUN_B, 'failed'],
        ]);
        expect(buildNodeRunStats(outcomes, runStatuses)).toEqual({
            last24h: { runs: 1, failed: 1, costCents: 0 },
            last7d: { runs: 2, failed: 2, costCents: 40 },
        });
    });

    it('does not count a `failed` job whose run the reconciler settled completed', () => {
        expect(
            buildNodeRunStats([outcome({ status: 'failed' })], new Map([[RUN_A, 'completed']])),
        ).toEqual({
            last24h: { runs: 1, failed: 0, costCents: 0 },
            last7d: { runs: 1, failed: 0, costCents: 0 },
        });
    });

    it('judges a job by its own status when no run is known for it', () => {
        const outcomes = [
            // The run was not found (deleted, or not this owner's).
            outcome({ jobId: 'j1', status: 'failed', runId: RUN_A }),
            // No correlation at all: a purged body, a job with no task id.
            outcome({ jobId: 'j2', status: 'failed', runId: null, taskId: null }),
            outcome({ jobId: 'j3', status: 'failed', runId: RUN_B, taskId: null }),
            outcome({ jobId: 'j4', status: 'done', runId: '   ', taskId: TASK }),
        ];
        expect(buildNodeRunStats(outcomes, new Map([[RUN_B, 'completed']])).last24h).toEqual({
            runs: 4,
            // j3 names a run that completed — but with no task id it does not
            // correlate (the reconciler's own rule), so its job status stands.
            failed: 3,
            costCents: 0,
        });
    });

    it('sums the spend per window and ignores a cost that is not a number', () => {
        const stats = buildNodeRunStats(
            [
                outcome({ jobId: 'j1', costCents: 120 }),
                outcome({ jobId: 'j2', costCents: Number.NaN }),
                outcome({ jobId: 'j3', costCents: -5 }),
                outcome({ jobId: 'j4', costCents: 300, recent: false }),
            ],
            new Map(),
        );
        expect(stats.last24h.costCents).toBe(120);
        expect(stats.last7d.costCents).toBe(420);
        expect(stats.last7d.runs).toBe(4);
    });

    it('marks a capped read, and only then', () => {
        expect(buildNodeRunStats([], new Map())).toEqual({
            last24h: { runs: 0, failed: 0, costCents: 0 },
            last7d: { runs: 0, failed: 0, costCents: 0 },
        });
        expect(buildNodeRunStats([], new Map(), true).capped).toBe(true);
    });

    it('gives the same verdict as the history row for the same job and run', () => {
        const cases: Array<{ job: string; run: string | null }> = [
            { job: 'done', run: 'failed' },
            { job: 'done', run: 'completed' },
            { job: 'failed', run: 'completed' },
            { job: 'failed', run: 'failed' },
            { job: 'done', run: 'running' },
            { job: 'failed', run: null },
            { job: 'done', run: null },
            // A status the wire contract does not know.
            { job: 'failed', run: 'paused-for-review' },
        ];
        for (const { job, run } of cases) {
            const sourceJob = {
                id: 'job-1',
                kind: 'agent-task',
                status: job,
                payload: { runId: RUN_A, taskId: TASK },
            } as unknown as NodeHistorySourceJob;
            const runs = new Map(run ? [[RUN_A, { id: RUN_A, status: run }]] : []);
            const [row] = buildNodeJobHistory([sourceJob], runs);
            const stats = buildNodeRunStats(
                [outcome({ status: job })],
                new Map(run ? [[RUN_A, run]] : []),
            );
            expect({ job, run, failed: stats.last24h.failed === 1 }).toEqual({
                job,
                run,
                failed: isFailedNodeHistoryEntry(row),
            });
        }
    });
});

describe('nodeRunStatsRunIds', () => {
    it('lists each correlated run once, by the reconciler`s own correlation rule', () => {
        expect(
            nodeRunStatsRunIds([
                outcome({ runId: RUN_A }),
                outcome({ runId: ` ${RUN_A} ` }),
                outcome({ runId: RUN_B }),
                outcome({ runId: null }),
                outcome({ runId: 'ccc', taskId: null }),
                outcome({ runId: '', taskId: TASK }),
            ]),
        ).toEqual([RUN_A, RUN_B]);
    });
});

describe('readNodeRunStats', () => {
    const jobsWith = (outcomes: NodeRunOutcome[], capped = false) => ({
        agentTaskOutcomesForNode: jest.fn(async () => ({ outcomes, capped })),
    });

    it('reads the jobs, then the status of the runs they carried, owner-scoped', async () => {
        const jobs = jobsWith([outcome({ runId: RUN_A }), outcome({ jobId: 'j2', runId: RUN_B })]);
        const runs = {
            findStatusesByIds: jest.fn(async () => new Map([[RUN_A, 'failed']])),
        };
        const now = new Date('2026-11-10T12:00:00.000Z');
        await expect(readNodeRunStats({ jobs, runs }, 'user-1', 'node-1', now)).resolves.toEqual({
            last24h: { runs: 2, failed: 1, costCents: 0 },
            last7d: { runs: 2, failed: 1, costCents: 0 },
        });
        expect(jobs.agentTaskOutcomesForNode).toHaveBeenCalledWith('user-1', 'node-1', now);
        expect(runs.findStatusesByIds).toHaveBeenCalledWith([RUN_A, RUN_B], 'user-1');
    });

    it('answers null — no numbers — when jobs carry runs and there is no run store', async () => {
        const jobs = jobsWith([outcome()]);
        await expect(readNodeRunStats({ jobs }, 'user-1', 'node-1')).resolves.toBeNull();
        await expect(
            readNodeRunStats({ jobs, runs: null }, 'user-1', 'node-1'),
        ).resolves.toBeNull();
    });

    it('needs no run store when no job carries a run', async () => {
        const jobs = jobsWith([outcome({ status: 'failed', runId: null, taskId: null })], true);
        await expect(readNodeRunStats({ jobs }, 'user-1', 'node-1')).resolves.toEqual({
            last24h: { runs: 1, failed: 1, costCents: 0 },
            last7d: { runs: 1, failed: 1, costCents: 0 },
            capped: true,
        });
    });

    it('lets a failed read reach the caller, which degrades to an absent field', async () => {
        const runs = {
            findStatusesByIds: jest.fn(async () => {
                throw new Error('agent_runs unavailable');
            }),
        };
        await expect(
            readNodeRunStats({ jobs: jobsWith([outcome()]), runs }, 'user-1', 'node-1'),
        ).rejects.toThrow('agent_runs unavailable');
    });
});
