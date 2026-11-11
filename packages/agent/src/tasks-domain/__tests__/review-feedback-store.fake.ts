/**
 * Test helper (not a spec) — an in-memory `task_review_rejections` that
 * answers the repository methods the review-feedback lifecycle uses with the
 * SAME semantics as the SQL in `task-review-rejection.repository.ts`, so a
 * spec can drive claim → settle → resume → claim against one table and read
 * the rows back, instead of trusting a mock's canned answer.
 */

export type FakeRejectionRow = {
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

export type FakeRun = {
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

const oldestFirst = (a: FakeRejectionRow, b: FakeRejectionRow) =>
    a.createdAt.getTime() - b.createdAt.getTime();

export function makeRejectionStore(rows: FakeRejectionRow[]) {
    return {
        rows,
        hasOpenForTask: jest.fn(async (taskId: string) =>
            rows.some((row) => row.taskId === taskId && row.consumedAt === null),
        ),
        // `consumedAt IS NULL AND (prNumber IS NULL OR prNumber = :openPullRequest)`.
        findOpenForTask: jest.fn(
            async (
                taskId: string,
                opts: { openPullRequest?: number | null; limit?: number } = {},
            ) =>
                rows
                    .filter((row) => row.taskId === taskId && row.consumedAt === null)
                    .filter(
                        (row) =>
                            row.prNumber === null ||
                            row.prNumber === undefined ||
                            (typeof opts.openPullRequest === 'number' &&
                                row.prNumber === opts.openPullRequest),
                    )
                    .sort(oldestFirst)
                    .slice(0, opts.limit ?? 50),
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
                .sort(oldestFirst);
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
        releaseCarried: jest.fn(async (runId: string, ids?: readonly string[]) => {
            let n = 0;
            for (const row of rows) {
                if (ids && !ids.includes(row.id)) continue;
                if (row.consumedByRunId === runId && row.consumedAt === null) {
                    row.consumedByRunId = null;
                    n += 1;
                }
            }
            return n;
        }),
        // The RESUME path's two methods (orchestration M9), unchanged by this feature.
        findPendingForTask: jest.fn(async (taskId: string, limit = 3) =>
            rows
                .filter(
                    (row) =>
                        row.taskId === taskId &&
                        row.consumedByRunId === null &&
                        row.consumedAt === null,
                )
                .sort(oldestFirst)
                .slice(0, Math.max(1, Math.min(20, limit))),
        ),
        markConsumed: jest.fn(async (ids: string[], runId: string) => {
            let n = 0;
            for (const row of rows) {
                if (ids.includes(row.id) && row.consumedByRunId === null) {
                    row.consumedByRunId = runId;
                    row.consumedAt = new Date();
                    n += 1;
                }
            }
            return n;
        }),
    };
}

export function makeRunStore(runs: FakeRun[]) {
    return {
        runs,
        findById: jest.fn(async (id: string) => runs.find((run) => run.id === id) ?? null),
        findByIds: jest.fn(async (ids: string[]) => runs.filter((run) => ids.includes(run.id))),
    };
}
