import { agentReviewRunScope } from '../task-agent-review';
import { feedbackCutoff, TaskReviewRejectionService } from '../task-review-rejection.service';

/**
 * Review feedback reaches the next run (2026-11-11).
 *
 * Production incident: findings recorded with `POST /api/tasks/:id/reject`
 * reached a RESUMED run only, and resume refuses a completed run, so the run
 * started next with `POST /api/tasks/:id/run` never saw them. It read the
 * Task's standing brief, treated itself as fresh work and pushed an
 * unrelated feature onto the pull request under review.
 *
 * What these pin, against an in-memory model of `task_review_rejections`
 * (so claim → settle → claim is the real state machine, not a mock's say-so):
 *
 *  - a fresh run CARRIES the open findings (`consumedByRunId` set,
 *    `consumedAt` not yet), oldest first, within the caps;
 *  - completing consumes them, so a later run is not told again;
 *  - failing or being cancelled hands them back, and the next run gets them;
 *  - a finding older than the Task's last completed run that carried
 *    nothing is not replayed; a finding a capped run left behind is;
 *  - review runs, runs of another Task or owner, and non-Task runs get
 *    nothing; a run still in flight keeps what it carries.
 */

type Row = {
    id: string;
    taskId: string;
    source: string;
    feedback: string;
    reviewerKind?: string | null;
    reviewerLabel?: string | null;
    severity?: string | null;
    prNumber?: number | null;
    consumedByRunId: string | null;
    consumedAt: Date | null;
    createdAt: Date;
};

type Run = {
    id: string;
    taskId: string;
    userId: string;
    triggerKind: string;
    status: string;
    awaitingInput?: boolean;
    resumeSuccessorRunId?: string | null;
    delegationScope?: unknown;
    startedAt?: Date | null;
    createdAt: Date;
};

const TASK = 'task-1';
const USER = 'user-1';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 10, minute));

function makeRejections(rows: Row[]) {
    return {
        rows,
        findOpenForTask: jest.fn(async (taskId: string) =>
            rows
                .filter((row) => row.taskId === taskId && row.consumedAt === null)
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        ),
        findCarrierRunIds: jest.fn(
            async (taskId: string) =>
                new Set(
                    rows
                        .filter((row) => row.taskId === taskId && row.consumedByRunId)
                        .map((row) => row.consumedByRunId as string),
                ),
        ),
        carryForRun: jest.fn(async (ids: string[], runId: string, from: string[] = []) => {
            for (const row of rows) {
                if (!ids.includes(row.id) || row.consumedAt !== null) continue;
                if (row.consumedByRunId === null || from.includes(row.consumedByRunId)) {
                    row.consumedByRunId = runId;
                }
            }
            return rows
                .filter(
                    (row) =>
                        ids.includes(row.id) &&
                        row.consumedByRunId === runId &&
                        row.consumedAt === null,
                )
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        }),
        markCarriedConsumed: jest.fn(async (runId: string) => {
            let n = 0;
            for (const row of rows) {
                if (row.consumedByRunId === runId && row.consumedAt === null) {
                    row.consumedAt = new Date();
                    n += 1;
                }
            }
            return n;
        }),
        releaseCarried: jest.fn(async (runId: string) => {
            let n = 0;
            for (const row of rows) {
                if (row.consumedByRunId === runId && row.consumedAt === null) {
                    row.consumedByRunId = null;
                    n += 1;
                }
            }
            return n;
        }),
    };
}

function makeRuns(runs: Run[]) {
    return {
        runs,
        findById: jest.fn(async (id: string) => runs.find((run) => run.id === id) ?? null),
        findByIds: jest.fn(async (ids: string[]) => runs.filter((run) => ids.includes(run.id))),
        findRecentForTask: jest.fn(async (taskId: string) =>
            runs
                .filter((run) => run.taskId === taskId)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
        ),
    };
}

const row = (over: Partial<Row> & Pick<Row, 'id' | 'createdAt'>): Row => ({
    taskId: TASK,
    source: 'task-review',
    feedback: `finding ${over.id}`,
    reviewerKind: 'human',
    consumedByRunId: null,
    consumedAt: null,
    ...over,
});

const run = (over: Partial<Run> & Pick<Run, 'id' | 'createdAt'>): Run => ({
    taskId: TASK,
    userId: USER,
    triggerKind: 'task',
    status: 'queued',
    startedAt: null,
    ...over,
});

function build(rows: Row[], runs: Run[]) {
    const rejections = makeRejections(rows);
    const runRepo = makeRuns(runs);
    const svc = new TaskReviewRejectionService(
        {} as never,
        rejections as never,
        {} as never,
        {} as never,
        undefined,
        runRepo as never,
    );
    for (const level of ['warn', 'log'] as const) {
        jest.spyOn(
            (svc as never as { logger: Record<string, () => void> }).logger,
            level,
        ).mockImplementation(() => undefined);
    }
    return { svc, rejections, runRepo };
}

const claim = (svc: TaskReviewRejectionService, runId: string, userId = USER) =>
    svc.claimFeedbackForRun({ taskId: TASK, runId, userId });

describe('TaskReviewRejectionService.claimFeedbackForRun — the incident', () => {
    it('gives a fresh run the findings recorded after the run that opened the pull request', async () => {
        // r1 completed (opened PR #5038), then a reviewer rejected twice, then
        // POST /run started r2 — the exact sequence from production.
        const rows = [row({ id: 'a', createdAt: at(20) }), row({ id: 'b', createdAt: at(21) })];
        const { svc } = build(rows, [
            run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
            run({ id: 'r2', status: 'running', createdAt: at(30) }),
        ]);

        const feedback = await claim(svc, 'r2');

        expect(feedback?.items.map((item) => item.id)).toEqual(['a', 'b']);
        expect(feedback?.omitted).toBe(0);
        // Carried, not consumed: the run has not done anything yet.
        expect(rows.map((r) => [r.consumedByRunId, r.consumedAt])).toEqual([
            ['r2', null],
            ['r2', null],
        ]);
    });

    it('a later run is not told again once the fix run completed', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) })];
        const runs = [
            run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
            run({ id: 'r2', status: 'running', startedAt: at(30), createdAt: at(30) }),
        ];
        const { svc, rejections } = build(rows, runs);
        await claim(svc, 'r2');

        runs[1].status = 'completed';
        await svc.settleFeedbackForRun('r2', 'completed');
        expect(rejections.markCarriedConsumed).toHaveBeenCalledWith('r2');
        expect(rows[0].consumedAt).toBeInstanceOf(Date);

        runs.push(run({ id: 'r3', status: 'running', createdAt: at(50) }));
        await expect(claim(svc, 'r3')).resolves.toBeNull();
    });

    it('a failed (or cancelled) fix run hands the findings back to the next run', async () => {
        for (const outcome of ['failed', 'cancelled'] as const) {
            const rows = [row({ id: 'a', createdAt: at(20) })];
            const runs = [
                run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
                run({ id: 'r2', status: 'running', startedAt: at(30), createdAt: at(30) }),
            ];
            const { svc, rejections } = build(rows, runs);
            await claim(svc, 'r2');

            runs[1].status = outcome;
            await svc.settleFeedbackForRun('r2', outcome);
            expect(rejections.releaseCarried).toHaveBeenCalledWith('r2');
            expect(rows[0]).toMatchObject({ consumedByRunId: null, consumedAt: null });

            runs.push(run({ id: 'r3', status: 'running', createdAt: at(50) }));
            const feedback = await claim(svc, 'r3');
            expect(feedback?.items.map((item) => item.id)).toEqual(['a']);
        }
    });

    it('a failed run whose settle never happened is still taken over (the claim reads its status)', async () => {
        const rows = [row({ id: 'a', createdAt: at(20), consumedByRunId: 'r2' })];
        const { svc, rejections } = build(rows, [
            run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
            run({ id: 'r2', status: 'failed', startedAt: at(30), createdAt: at(30) }),
            run({ id: 'r3', status: 'running', createdAt: at(50) }),
        ]);

        const feedback = await claim(svc, 'r3');

        expect(feedback?.items.map((item) => item.id)).toEqual(['a']);
        expect(rejections.carryForRun).toHaveBeenCalledWith(['a'], 'r3', ['r2']);
        expect(rows[0].consumedByRunId).toBe('r3');
    });

    it('a run still in flight keeps what it carries; a second run gets nothing of it', async () => {
        const rows = [row({ id: 'a', createdAt: at(20), consumedByRunId: 'r2' })];
        const { svc } = build(rows, [
            run({ id: 'r2', status: 'running', startedAt: at(30), createdAt: at(30) }),
            run({ id: 'r3', status: 'queued', createdAt: at(31) }),
        ]);
        await expect(claim(svc, 'r3')).resolves.toBeNull();
        expect(rows[0].consumedByRunId).toBe('r2');
    });

    it('a re-plan of the same run (a retried enqueue) is handed the same findings', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) })];
        const { svc } = build(rows, [
            run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
            run({ id: 'r2', status: 'queued', createdAt: at(30) }),
        ]);
        await claim(svc, 'r2');
        const again = await claim(svc, 'r2');
        expect(again?.items.map((item) => item.id)).toEqual(['a']);
    });
});

describe('TaskReviewRejectionService.claimFeedbackForRun — what is NOT replayed', () => {
    it('skips findings older than the last completed run that carried nothing', async () => {
        // `old` predates r1, which completed with no findings in front of it —
        // it was answered (or abandoned) long ago.
        const rows = [row({ id: 'old', createdAt: at(1) }), row({ id: 'new', createdAt: at(20) })];
        const { svc } = build(rows, [
            run({ id: 'r1', status: 'completed', startedAt: at(5), createdAt: at(5) }),
            run({ id: 'r2', status: 'queued', createdAt: at(30) }),
        ]);
        const feedback = await claim(svc, 'r2');
        expect(feedback?.items.map((item) => item.id)).toEqual(['new']);
        expect(rows[0].consumedByRunId).toBeNull();
    });

    it('still replays what a capped run left behind (a run that carried findings is no cutoff)', async () => {
        const rows = [
            row({ id: 'carried', createdAt: at(10), consumedByRunId: 'r2', consumedAt: at(40) }),
            row({ id: 'left-behind', createdAt: at(11) }),
        ];
        const { svc } = build(rows, [
            run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
            run({ id: 'r2', status: 'completed', startedAt: at(30), createdAt: at(30) }),
            run({ id: 'r3', status: 'queued', createdAt: at(50) }),
        ]);
        const feedback = await claim(svc, 'r3');
        expect(feedback?.items.map((item) => item.id)).toEqual(['left-behind']);
    });

    it('leaves findings beyond the caps pending and says how many', async () => {
        const rows = Array.from({ length: 12 }, (_, i) => row({ id: `f${i}`, createdAt: at(10 + i) }));
        const { svc } = build(rows, [run({ id: 'r2', status: 'queued', createdAt: at(30) })]);
        const feedback = await claim(svc, 'r2');
        expect(feedback?.items).toHaveLength(10);
        expect(feedback?.omitted).toBe(2);
        expect(rows.filter((r) => r.consumedByRunId === null).map((r) => r.id)).toEqual([
            'f10',
            'f11',
        ]);
    });

    it('gives nothing to a review run, a non-Task run, another Task or another owner', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) })];
        const { svc, rejections } = build(rows, [
            run({ id: 'review', createdAt: at(30), delegationScope: agentReviewRunScope() }),
            run({ id: 'chat', createdAt: at(30), triggerKind: 'chat' }),
            run({ id: 'other-task', createdAt: at(30), taskId: 'task-2' }),
            run({ id: 'other-owner', createdAt: at(30), userId: 'user-2' }),
        ]);
        for (const id of ['review', 'chat', 'other-task', 'other-owner', 'missing']) {
            await expect(claim(svc, id)).resolves.toBeNull();
        }
        expect(rejections.carryForRun).not.toHaveBeenCalled();
        expect(rows[0].consumedByRunId).toBeNull();
    });

    it('a parked fix run (owner question) keeps its findings; the run its answer starts takes them', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) })];
        const runs = [
            run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
            run({ id: 'r2', status: 'running', startedAt: at(30), createdAt: at(30) }),
        ];
        const { svc, rejections } = build(rows, runs);
        await claim(svc, 'r2');

        Object.assign(runs[1], { status: 'completed', awaitingInput: true });
        await svc.settleFeedbackForRun('r2', 'completed');
        expect(rejections.markCarriedConsumed).not.toHaveBeenCalled();

        // The Inbox answer resumes r2 as r3; resume clears the parked flag.
        Object.assign(runs[1], { awaitingInput: false, resumeSuccessorRunId: 'r3' });
        runs.push(run({ id: 'r3', status: 'queued', createdAt: at(60) }));
        const feedback = await claim(svc, 'r3');
        expect(feedback?.items.map((item) => item.id)).toEqual(['a']);
        expect(rows[0].consumedByRunId).toBe('r3');
    });

    it('never throws: a failed read starts the run without the section', async () => {
        const { svc, runRepo } = build([row({ id: 'a', createdAt: at(20) })], []);
        runRepo.findById.mockRejectedValueOnce(new Error('db down'));
        await expect(claim(svc, 'r2')).resolves.toBeNull();
    });

    it('without a run repository (a reduced graph) nothing is claimed', async () => {
        const rejections = makeRejections([row({ id: 'a', createdAt: at(20) })]);
        const svc = new TaskReviewRejectionService(
            {} as never,
            rejections as never,
            {} as never,
            {} as never,
        );
        await expect(claim(svc, 'r2')).resolves.toBeNull();
        expect(rejections.findOpenForTask).not.toHaveBeenCalled();
    });
});

describe('feedbackCutoff', () => {
    it('is the start of the newest completed authoring run that carried nothing', () => {
        const runs = [
            run({ id: 'mine', status: 'queued', createdAt: at(50) }),
            run({ id: 'carried', status: 'completed', startedAt: at(40), createdAt: at(40) }),
            run({
                id: 'parked',
                status: 'completed',
                awaitingInput: true,
                startedAt: at(35),
                createdAt: at(35),
            }),
            run({
                id: 'review',
                status: 'completed',
                delegationScope: agentReviewRunScope(),
                startedAt: at(32),
                createdAt: at(32),
            }),
            run({ id: 'failed', status: 'failed', startedAt: at(31), createdAt: at(31) }),
            run({ id: 'plain', status: 'completed', startedAt: at(30), createdAt: at(29) }),
        ] as never[];
        expect(feedbackCutoff(runs, new Set(['carried']), 'mine')).toEqual(at(30));
        expect(feedbackCutoff([], new Set(), 'mine')).toBeNull();
    });
});
