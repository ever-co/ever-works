import { RunSteeringService } from '../../agents/run-steering.service';
import { TaskReviewRejectionService } from '../task-review-rejection.service';
import {
    makeRejectionStore,
    makeRunStore,
    type FakeRejectionRow,
    type FakeRun,
} from './review-feedback-store.fake';

/**
 * Review of #3150, finding 3 — a PARKED fix run's findings must reach the run
 * the owner's answer starts, through the REAL resume path.
 *
 * The bug: a fresh run carried findings, parked on an owner question, and
 * kept them ("the successor takes them over"). But `RunSteeringService.resume`
 * clears the parked flag and the successor link right after its enqueue, and
 * the successor claims much later (the cloud worker after provisioning; a
 * fleet run the gate held at drain time) — so the rows stayed "carried by the
 * parked run" for good: never consumed, never released, never shown again.
 *
 * Now a parked run hands its findings back as it settles, and `resume` hands
 * back whatever a parked source still carries before it reads; the resume
 * then replays them as the successor's first input, exactly as it replayed
 * pending rejections before fresh runs carried any. Driven here with the real
 * `RunSteeringService.resume` and the real claim/settle over one in-memory
 * table, with the successor claiming only AFTER the resume has finished.
 */

const TASK = 'task-1';
const USER = 'user-1';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 11, minute));

function harness(rows: FakeRejectionRow[], runs: FakeRun[]) {
    const rejections = makeRejectionStore(rows);
    const runStore = makeRunStore(runs);
    const seeded = new Map<string, string[] | null>();
    let created = 0;
    // One run repository for both services: the claim's reads and the
    // resume's writes land on the same rows.
    const runRepo = {
        ...runStore,
        findByIdAndUser: jest.fn(
            async (id: string, userId: string) =>
                runs.find((run) => run.id === id && run.userId === userId) ?? null,
        ),
        createQueued: jest.fn(async () => {
            created += 1;
            const next: FakeRun = {
                id: `r-resumed-${created}`,
                taskId: TASK,
                userId: USER,
                triggerKind: 'task',
                status: 'queued',
                createdAt: at(50 + created),
            };
            runs.push(next);
            return next;
        }),
        seedResumeContext: jest.fn(async (id: string, patch: { pendingInput: string[] | null }) => {
            seeded.set(id, patch.pendingInput);
        }),
        setAwaitingInput: jest.fn(async (id: string, value: boolean) => {
            const run = runs.find((r) => r.id === id);
            if (run) run.awaitingInput = value;
        }),
        setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        claimResume: jest.fn(async (id: string) => ({
            runId: id,
            token: 'claim-1',
            previousToken: null,
        })),
        releaseResumeClaim: jest.fn().mockResolvedValue(true),
        consumeResumeClaim: jest.fn(async () => {
            // The real consume clears the successor link as well.
            for (const run of runs) run.resumeSuccessorRunId = null;
            return true;
        }),
        findResumeSuccessor: jest.fn().mockResolvedValue(null),
    };
    const tasks = {
        findById: jest.fn(async () => ({ id: TASK, userId: USER, prNumber: null, prState: null })),
    };
    const feedback = new TaskReviewRejectionService(
        tasks as never,
        rejections as never,
        {} as never,
        {} as never,
        undefined,
        runRepo as never,
    );
    const steering = new RunSteeringService(
        runRepo as never,
        undefined,
        { enqueue: jest.fn().mockResolvedValue({ runId: 'trigger-1' }) } as never,
        undefined,
        undefined,
        rejections as never,
    );
    for (const svc of [feedback, steering]) {
        for (const level of ['warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
    }
    return { rejections, feedback, steering, seeded, runs };
}

const finding = (id: string, over: Partial<FakeRejectionRow> = {}): FakeRejectionRow => ({
    id,
    taskId: TASK,
    source: 'task-review',
    feedback: `Reviewer finding ${id}: the retry path drops the auth header.`,
    reviewerKind: 'human',
    prNumber: null,
    consumedByRunId: null,
    consumedAt: null,
    createdAt: at(1),
    ...over,
});

afterEach(() => jest.restoreAllMocks());

describe('a parked fix run → the owner answers → the resumed run gets the findings', () => {
    it('settle hands them back, resume replays them first, and the successor’s later claim adds nothing', async () => {
        const rows = [finding('a')];
        const runs: FakeRun[] = [
            {
                id: 'r2',
                taskId: TASK,
                userId: USER,
                triggerKind: 'task',
                status: 'running',
                createdAt: at(10),
            },
        ];
        const { feedback, steering, seeded } = harness(rows, runs);

        // r2 is planned and carries the finding…
        expect(
            (await feedback.claimFeedbackForRun({ taskId: TASK, runId: 'r2', userId: USER }))
                ?.items,
        ).toHaveLength(1);
        // …then stops to ask the owner, and its terminal write settles it.
        Object.assign(runs[0], { status: 'completed', awaitingInput: true });
        await feedback.settleFeedbackForRun('r2', 'completed');
        expect(rows[0]).toMatchObject({ consumedByRunId: null, consumedAt: null });

        // The owner answers: the REAL resume.
        const outcome = await steering.resume('r2', USER, 'Use the existing header helper.');

        expect(outcome.rejectionsReplayed).toBe(1);
        const pending = seeded.get(outcome.runId)!;
        expect(pending[0]).toContain('REJECTED');
        expect(pending[0]).toContain('Reviewer finding a');
        expect(pending[1]).toBe('Use the existing header helper.');
        expect(rows[0]).toMatchObject({ consumedByRunId: outcome.runId });
        expect(rows[0].consumedAt).toBeInstanceOf(Date);
        // The resume cleared the parked flag and the successor link…
        expect(runs[0].awaitingInput).toBe(false);
        // …and the successor's own claim, which runs only now, finds nothing
        // left to show twice.
        await expect(
            feedback.claimFeedbackForRun({ taskId: TASK, runId: outcome.runId, userId: USER }),
        ).resolves.toBeNull();
    });

    it('when the settle was MISSED, the resume itself hands the parked run’s findings back and replays them', async () => {
        // The parked run still carries the row (its terminal write never
        // settled it) — the exact state the review found stranded.
        const rows = [finding('a', { consumedByRunId: 'r2' })];
        const runs: FakeRun[] = [
            {
                id: 'r2',
                taskId: TASK,
                userId: USER,
                triggerKind: 'task',
                status: 'completed',
                awaitingInput: true,
                createdAt: at(10),
            },
        ];
        const { feedback, steering, seeded, rejections } = harness(rows, runs);

        const outcome = await steering.resume('r2', USER, 'Go ahead.');

        expect(rejections.releaseCarried).toHaveBeenCalledWith('r2');
        expect(outcome.rejectionsReplayed).toBe(1);
        expect(seeded.get(outcome.runId)![0]).toContain('Reviewer finding a');
        expect(rows[0]).toMatchObject({ consumedByRunId: outcome.runId });
        await expect(
            feedback.claimFeedbackForRun({ taskId: TASK, runId: outcome.runId, userId: USER }),
        ).resolves.toBeNull();
    });

    it('a resumed run that fails afterwards does not lose findings that arrived meanwhile', async () => {
        const rows = [finding('a')];
        const runs: FakeRun[] = [
            {
                id: 'r2',
                taskId: TASK,
                userId: USER,
                triggerKind: 'task',
                status: 'completed',
                awaitingInput: true,
                createdAt: at(10),
            },
        ];
        const { feedback, steering } = harness(rows, runs);
        const outcome = await steering.resume('r2', USER, 'Go ahead.');
        // A new finding lands while the resumed run works; it claims it…
        rows.push(finding('b', { createdAt: at(60) }));
        const successor = runs.find((r) => r.id === outcome.runId)!;
        successor.status = 'running';
        expect(
            (
                await feedback.claimFeedbackForRun({
                    taskId: TASK,
                    runId: outcome.runId,
                    userId: USER,
                })
            )?.items.map((item) => item.id),
        ).toEqual(['b']);
        // …and fails: `b` goes back for the next run.
        successor.status = 'failed';
        await feedback.settleFeedbackForRun(outcome.runId, 'failed');
        expect(rows[1]).toMatchObject({ consumedByRunId: null, consumedAt: null });
    });

    it('a run that completed normally (the CI fix loop resumes those) keeps what it consumed', async () => {
        const rows = [finding('a', { consumedByRunId: 'r2' })];
        const runs: FakeRun[] = [
            {
                id: 'r2',
                taskId: TASK,
                userId: USER,
                triggerKind: 'task',
                status: 'completed',
                createdAt: at(10),
            },
        ];
        const { steering, rejections } = harness(rows, runs);
        await steering.resume('r2', USER, 'CI is red.', undefined, { allowCompleted: true });
        expect(rejections.releaseCarried).not.toHaveBeenCalled();
        expect(rows[0].consumedByRunId).toBe('r2');
    });
});
