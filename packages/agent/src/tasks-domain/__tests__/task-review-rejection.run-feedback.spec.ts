import { agentReviewRunScope } from '../task-agent-review';
import {
    openPullRequestNumberOf,
    TaskReviewRejectionService,
} from '../task-review-rejection.service';
import {
    makeRejectionStore,
    makeRunStore,
    type FakeRejectionRow,
    type FakeRun,
} from './review-feedback-store.fake';

/**
 * Review feedback reaches the next run (2026-11-11).
 *
 * Production incident: findings recorded with `POST /api/tasks/:id/reject`
 * reached a RESUMED run only, and resume refuses a completed run, so the run
 * started next with `POST /api/tasks/:id/run` never saw them. It read the
 * Task's standing brief, treated itself as fresh work and pushed an
 * unrelated feature onto the pull request under review.
 *
 * What these pin, against an in-memory `task_review_rejections` with the
 * repository's semantics (so claim → settle → claim is the real state
 * machine, not a mock's say-so):
 *
 *  - a fresh run CARRIES the open findings (`consumedByRunId` set,
 *    `consumedAt` not yet), oldest first, within the caps;
 *  - completing consumes them, so a later run is not told again;
 *  - failing, being cancelled, or parking on an owner question hands them
 *    back, and the next run gets them;
 *  - NO run ever becomes a cutoff: a finding stays open until a run that was
 *    given it completes — the four ways a timestamp cutoff hid findings no
 *    run saw (review of #3150) are each pinned below;
 *  - a finding recorded on a pull request is replayed only while that pull
 *    request is the Task's open one;
 *  - review runs, runs of another Task or owner, and non-Task runs get
 *    nothing; a run still in flight keeps what it carries.
 */

const TASK = 'task-1';
const USER = 'user-1';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 10, minute));

type TaskRow = {
    id: string;
    userId: string;
    prNumber?: number | null;
    prState?: string | null;
    branchState?: string | null;
};

const row = (
    over: Partial<FakeRejectionRow> & Pick<FakeRejectionRow, 'id' | 'createdAt'>,
): FakeRejectionRow => ({
    taskId: TASK,
    source: 'task-review',
    feedback: `finding ${over.id}`,
    reviewerKind: 'human',
    prNumber: null,
    consumedByRunId: null,
    consumedAt: null,
    ...over,
});

const run = (over: Partial<FakeRun> & Pick<FakeRun, 'id' | 'createdAt'>): FakeRun => ({
    taskId: TASK,
    userId: USER,
    triggerKind: 'task',
    status: 'queued',
    startedAt: null,
    ...over,
});

function build(rows: FakeRejectionRow[], runs: FakeRun[], task: Partial<TaskRow> = {}) {
    const rejections = makeRejectionStore(rows);
    const runRepo = makeRunStore(runs);
    const taskRow: TaskRow = {
        id: TASK,
        userId: USER,
        prNumber: 5038,
        prState: 'open',
        branchState: 'pr-open',
        ...task,
    };
    const tasks = { findById: jest.fn(async (id: string) => (id === TASK ? taskRow : null)) };
    const svc = new TaskReviewRejectionService(
        tasks as never,
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
    return { svc, rejections, runRepo, tasks, taskRow };
}

const claim = (svc: TaskReviewRejectionService, runId: string, userId = USER) =>
    svc.claimFeedbackForRun({ taskId: TASK, runId, userId });
const ids = (feedback: Awaited<ReturnType<typeof claim>>) => feedback?.items.map((item) => item.id);

describe('TaskReviewRejectionService.claimFeedbackForRun — the incident', () => {
    it('gives a fresh run the findings recorded after the run that opened the pull request', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) }), row({ id: 'b', createdAt: at(21) })];
        const { svc } = build(rows, [
            run({ id: 'r1', status: 'completed', startedAt: at(0), createdAt: at(0) }),
            run({ id: 'r2', status: 'running', createdAt: at(30) }),
        ]);

        const feedback = await claim(svc, 'r2');

        expect(ids(feedback)).toEqual(['a', 'b']);
        expect(feedback?.omitted).toBe(0);
        // Carried, not consumed: the run has not done anything yet.
        expect(rows.map((r) => [r.consumedByRunId, r.consumedAt])).toEqual([
            ['r2', null],
            ['r2', null],
        ]);
    });

    it('replays findings recorded BEFORE a run that completed without them (the incident’s own rows)', async () => {
        // a, b were recorded; the bad run r2 then completed without seeing
        // them (it predates this feature). They are still unaddressed.
        const rows = [row({ id: 'a', createdAt: at(20) }), row({ id: 'b', createdAt: at(21) })];
        const { svc } = build(rows, [
            run({ id: 'r2', status: 'completed', startedAt: at(25), createdAt: at(25) }),
            run({ id: 'r3', status: 'queued', createdAt: at(40) }),
        ]);
        expect(ids(await claim(svc, 'r3'))).toEqual(['a', 'b']);
    });

    it('a later run is not told again once the fix run completed', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) })];
        const runs = [run({ id: 'r2', status: 'running', startedAt: at(30), createdAt: at(30) })];
        const { svc, rejections } = build(rows, runs);
        await claim(svc, 'r2');

        runs[0].status = 'completed';
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
                run({ id: 'r2', status: 'running', startedAt: at(30), createdAt: at(30) }),
            ];
            const { svc, rejections } = build(rows, runs);
            await claim(svc, 'r2');

            runs[0].status = outcome;
            await svc.settleFeedbackForRun('r2', outcome);
            expect(rejections.releaseCarried).toHaveBeenCalledWith('r2');
            expect(rows[0]).toMatchObject({ consumedByRunId: null, consumedAt: null });

            runs.push(run({ id: 'r3', status: 'running', createdAt: at(50) }));
            expect(ids(await claim(svc, 'r3'))).toEqual(['a']);
        }
    });

    it('a run that PARKS on an owner question hands its findings back as it settles', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) })];
        const runs = [run({ id: 'r2', status: 'running', startedAt: at(30), createdAt: at(30) })];
        const { svc, rejections } = build(rows, runs);
        await claim(svc, 'r2');

        Object.assign(runs[0], { status: 'completed', awaitingInput: true });
        await svc.settleFeedbackForRun('r2', 'completed');

        expect(rejections.markCarriedConsumed).not.toHaveBeenCalled();
        expect(rows[0]).toMatchObject({ consumedByRunId: null, consumedAt: null });
    });

    it('takes over from a carrier whose settle never happened: failed, cancelled, or parked', async () => {
        for (const carrier of [
            { status: 'failed' },
            { status: 'cancelled' },
            { status: 'completed', awaitingInput: true },
        ]) {
            const rows = [row({ id: 'a', createdAt: at(20), consumedByRunId: 'r2' })];
            const { svc, rejections } = build(rows, [
                run({ id: 'r2', startedAt: at(30), createdAt: at(30), ...carrier }),
                run({ id: 'r3', status: 'running', createdAt: at(50) }),
            ]);
            expect(ids(await claim(svc, 'r3'))).toEqual(['a']);
            expect(rejections.carryForRun).toHaveBeenCalledWith(['a'], 'r3', ['r2']);
            expect(rows[0].consumedByRunId).toBe('r3');
        }
    });

    it('settles a completed carrier’s missed consume itself, so the row stops looking open', async () => {
        const rows = [row({ id: 'a', createdAt: at(20), consumedByRunId: 'r2' })];
        const { svc, rejections } = build(rows, [
            run({ id: 'r2', status: 'completed', startedAt: at(30), createdAt: at(30) }),
            run({ id: 'r3', status: 'running', createdAt: at(50) }),
        ]);
        await expect(claim(svc, 'r3')).resolves.toBeNull();
        expect(rejections.markCarriedConsumed).toHaveBeenCalledWith('r2');
        expect(rows[0].consumedAt).toBeInstanceOf(Date);
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
        const { svc } = build(rows, [run({ id: 'r2', status: 'queued', createdAt: at(30) })]);
        await claim(svc, 'r2');
        expect(ids(await claim(svc, 'r2'))).toEqual(['a']);
    });

    it('hands back exactly the findings a plan could not show, keeping the rest', async () => {
        const rows = [row({ id: 'a', createdAt: at(20) }), row({ id: 'b', createdAt: at(21) })];
        const { svc } = build(rows, [run({ id: 'r2', status: 'queued', createdAt: at(30) })]);
        await claim(svc, 'r2');
        await svc.releaseFeedbackForRun('r2', ['b']);
        expect(rows.map((r) => r.consumedByRunId)).toEqual(['r2', null]);
    });
});

/**
 * Review of #3150, finding 4: a cutoff inferred from "the latest completed
 * run that carried nothing" hid findings that run never saw. Each of the
 * reviewer's cases, with the rule that replaced it: no run is ever a cutoff.
 */
describe('no finding is hidden by another run (review of #3150)', () => {
    it('fleet: a finding recorded while the job waited for a node reaches the next run', async () => {
        // r2 was planned (claimed: nothing open yet) at enqueue, waited for a
        // node, and was stamped started at lease — after `late` was recorded.
        const rows: FakeRejectionRow[] = [];
        const runs = [run({ id: 'r2', status: 'queued', createdAt: at(10) })];
        const { svc } = build(rows, runs);
        await expect(claim(svc, 'r2')).resolves.toBeNull();
        rows.push(row({ id: 'late', createdAt: at(15) }));
        Object.assign(runs[0], { status: 'completed', startedAt: at(20) });
        await svc.settleFeedbackForRun('r2', 'completed');

        runs.push(run({ id: 'r3', status: 'queued', createdAt: at(40) }));
        expect(ids(await claim(svc, 'r3'))).toEqual(['late']);
    });

    it('a claim that failed (and was swallowed) leaves its run no power over the findings', async () => {
        const rows = [row({ id: 'a', createdAt: at(5) })];
        const runs = [run({ id: 'r2', status: 'queued', createdAt: at(10) })];
        const { svc, rejections } = build(rows, runs);
        rejections.hasOpenForTask.mockRejectedValueOnce(new Error('db hiccup'));
        await expect(claim(svc, 'r2')).resolves.toBeNull();
        Object.assign(runs[0], { status: 'completed', startedAt: at(11) });
        await svc.settleFeedbackForRun('r2', 'completed');

        runs.push(run({ id: 'r3', status: 'queued', createdAt: at(40) }));
        expect(ids(await claim(svc, 'r3'))).toEqual(['a']);
    });

    it('two agents on one Task: the run that carried nothing does not hide what the other hands back', async () => {
        const rows = [row({ id: 'f', createdAt: at(5) })];
        const runs = [
            run({ id: 'r1', status: 'running', startedAt: at(10), createdAt: at(10) }),
            run({ id: 'r2', status: 'running', startedAt: at(11), createdAt: at(11) }),
        ];
        const { svc } = build(rows, runs);
        expect(ids(await claim(svc, 'r1'))).toEqual(['f']);
        await expect(claim(svc, 'r2')).resolves.toBeNull();
        // r2 completes first, carrying nothing; then r1 fails and hands f back.
        runs[1].status = 'completed';
        await svc.settleFeedbackForRun('r2', 'completed');
        runs[0].status = 'failed';
        await svc.settleFeedbackForRun('r1', 'failed');

        runs.push(run({ id: 'r3', status: 'queued', createdAt: at(40) }));
        expect(ids(await claim(svc, 'r3'))).toEqual(['f']);
    });

    it('with no qualifying run at all, only findings about the CURRENT pull request (or none) are replayed', async () => {
        const rows = [
            row({ id: 'old-pr', createdAt: at(1), source: 'pull-request', prNumber: 4100 }),
            row({ id: 'task-review', createdAt: at(2) }),
            row({ id: 'current-pr', createdAt: at(3), source: 'pull-request', prNumber: 5038 }),
        ];
        const { svc } = build(rows, [run({ id: 'r9', status: 'queued', createdAt: at(40) })]);
        expect(ids(await claim(svc, 'r9'))).toEqual(['task-review', 'current-pr']);
        expect(rows[0].consumedByRunId).toBeNull();
    });
});

describe('findings recorded on a pull request follow that pull request', () => {
    const prRows = () => [
        row({ id: 'pr', createdAt: at(1), source: 'pull-request', prNumber: 5038 }),
        row({ id: 'plain', createdAt: at(2) }),
    ];

    it.each([
        ['merged', { prState: 'merged' }],
        ['closed', { prState: 'closed' }],
        ['branch merged', { branchState: 'merged' }],
        ['branch discarded', { branchState: 'discarded' }],
        ['no pull request', { prNumber: null }],
        ['another pull request', { prNumber: 6000 }],
    ] as const)('%s: only the findings that name no pull request', async (_, task) => {
        const rows = prRows();
        const { svc } = build(rows, [run({ id: 'r2', status: 'queued', createdAt: at(30) })], task);
        expect(ids(await claim(svc, 'r2'))).toEqual(['plain']);
    });

    it('openPullRequestNumberOf reads the Task the way the workspace does', () => {
        expect(
            openPullRequestNumberOf({ prNumber: 7, prState: 'open', branchState: 'pr-open' }),
        ).toBe(7);
        expect(openPullRequestNumberOf({ prNumber: 7, prState: null, branchState: 'pushed' })).toBe(
            7,
        );
        expect(
            openPullRequestNumberOf({ prNumber: 7, prState: 'merged', branchState: 'pr-open' }),
        ).toBeNull();
        expect(
            openPullRequestNumberOf({ prNumber: null, prState: null, branchState: null }),
        ).toBeNull();
    });
});

describe('TaskReviewRejectionService.claimFeedbackForRun — who gets nothing', () => {
    it('leaves findings beyond the caps pending and says how many', async () => {
        const rows = Array.from({ length: 12 }, (_, i) =>
            row({ id: `f${i}`, createdAt: at(10 + i) }),
        );
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

    it('the common case — nothing open — costs one read', async () => {
        const { svc, rejections, tasks } = build(
            [row({ id: 'done', createdAt: at(1), consumedByRunId: 'r0', consumedAt: at(2) })],
            [run({ id: 'r2', status: 'queued', createdAt: at(30) })],
        );
        await expect(claim(svc, 'r2')).resolves.toBeNull();
        expect(rejections.hasOpenForTask).toHaveBeenCalledWith(TASK);
        expect(tasks.findById).not.toHaveBeenCalled();
        expect(rejections.findOpenForTask).not.toHaveBeenCalled();
    });

    it('never throws: a failed read starts the run without the section', async () => {
        const { svc, runRepo } = build([row({ id: 'a', createdAt: at(20) })], []);
        runRepo.findById.mockRejectedValueOnce(new Error('db down'));
        await expect(claim(svc, 'r2')).resolves.toBeNull();
    });

    it('without a run repository (a reduced graph) nothing is claimed', async () => {
        const rejections = makeRejectionStore([row({ id: 'a', createdAt: at(20) })]);
        const svc = new TaskReviewRejectionService(
            {} as never,
            rejections as never,
            {} as never,
            {} as never,
        );
        await expect(claim(svc, 'r2')).resolves.toBeNull();
        expect(rejections.hasOpenForTask).not.toHaveBeenCalled();
        expect(rejections.findOpenForTask).not.toHaveBeenCalled();
    });
});
