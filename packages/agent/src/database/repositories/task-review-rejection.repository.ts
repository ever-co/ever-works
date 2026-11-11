import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, type FindOptionsWhere } from 'typeorm';
import { isUniqueConstraintError } from '../../utils/db-error.utils';
import {
    TASK_REVIEW_REJECTION_MAX_FEEDBACK_CHARS,
    TaskReviewRejection,
    type TaskReviewRejectionReviewerKind,
    type TaskReviewRejectionSeverity,
    type TaskReviewRejectionSource,
} from '../../entities/task-review-rejection.entity';

export interface RecordTaskReviewRejectionInput {
    taskId: string;
    source: TaskReviewRejectionSource;
    feedback: string;
    workId?: string | null;
    runId?: string | null;
    reviewerUserId?: string | null;
    reviewerLabel?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
    organizationId?: string | null;
    /** R16 — set by the GitHub bridge for reviewer-bot findings. */
    severity?: TaskReviewRejectionSeverity | null;
    /** R16 — `human` | `bot`; absent = not stated (legacy / gate). */
    reviewerKind?: TaskReviewRejectionReviewerKind | null;
    /**
     * Item 11 — the provider object this row comes from (`review:<id>`,
     * `<comment event>:<id>`). A second record with the same key for the
     * same Task is a redelivery and records nothing (`null`).
     */
    sourceKey?: string | null;
}

/**
 * Orchestration M9 — durable rejection feedback.
 *
 * Two operations only, because the record has two moments: it is written
 * when a human says no, and it is claimed exactly once by the next
 * resumed run. Everything else (listing, resolving) is deliberately
 * absent — an unread rejection is not a queue item, it is context for the
 * run that has not happened yet.
 */
@Injectable()
export class TaskReviewRejectionRepository {
    constructor(
        @InjectRepository(TaskReviewRejection)
        private readonly repository: Repository<TaskReviewRejection>,
    ) {}

    /**
     * Persist one rejection. Feedback is capped here rather than at the
     * call sites: the writers are a webhook bridge, a chat tool and a
     * worker, and a text column with no ceiling is a DoS surface no
     * matter which one is careless.
     *
     * Returns `null` for an empty/whitespace-only body — "rejected with no
     * words" carries nothing for the next run and must not create a row
     * that would later be prepended as an empty block.
     */
    async record(input: RecordTaskReviewRejectionInput): Promise<TaskReviewRejection | null> {
        const feedback = (input.feedback ?? '').trim();
        if (feedback.length === 0) return null;
        const sourceKey =
            typeof input.sourceKey === 'string' && input.sourceKey.trim()
                ? input.sourceKey.trim().slice(0, 120)
                : null;
        // A redelivered webhook: the same source already produced a row for
        // this Task. The unique index below is the guarantee; this read only
        // spares the common case an INSERT that is known to fail.
        if (sourceKey) {
            const existing = await this.repository.findOne({
                where: { taskId: input.taskId, sourceKey },
            });
            if (existing) return null;
        }
        const row = this.repository.create({
            taskId: input.taskId,
            source: input.source,
            feedback: feedback.slice(0, TASK_REVIEW_REJECTION_MAX_FEEDBACK_CHARS),
            workId: input.workId ?? null,
            runId: input.runId ?? null,
            reviewerUserId: input.reviewerUserId ?? null,
            reviewerLabel: input.reviewerLabel ?? null,
            prNumber: input.prNumber ?? null,
            prUrl: input.prUrl ?? null,
            severity: input.severity ?? null,
            reviewerKind: input.reviewerKind ?? null,
            sourceKey,
            ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
        });
        try {
            return await this.repository.save(row);
        } catch (error) {
            // Two deliveries of the same comment raced past the read above:
            // the index let exactly one land, and this one is the duplicate.
            if (sourceKey && isUniqueConstraintError(error)) return null;
            throw error;
        }
    }

    /**
     * The pending rejections for a Task, oldest first.
     *
     * Oldest-first matters: when two reviewers rejected before anyone
     * resumed, the agent should read them in the order they were written,
     * the same way it would read a comment thread. Bounded by `limit` so
     * a Task that accumulated a rejection storm cannot blow the prompt.
     */
    async findPendingForTask(taskId: string, limit = 3): Promise<TaskReviewRejection[]> {
        return this.repository.find({
            where: { taskId, consumedByRunId: IsNull() },
            order: { createdAt: 'ASC' },
            take: Math.max(1, Math.min(20, limit)),
        });
    }

    /**
     * Claim rows for a resumed run. CAS-guarded on `consumedByRunId IS
     * NULL` so two concurrent resumes cannot both seed the same feedback:
     * the loser's UPDATE matches nothing and its run starts without it,
     * which is the correct outcome (the feedback IS being acted on, by
     * the other run).
     *
     * Returns how many rows this caller actually claimed.
     */
    async markConsumed(ids: string[], runId: string): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await this.repository
            .createQueryBuilder()
            .update(TaskReviewRejection)
            .set({ consumedByRunId: runId, consumedAt: new Date() })
            .where('id IN (:...ids)', { ids })
            .andWhere('consumedByRunId IS NULL')
            .execute();
        return result.affected ?? 0;
    }

    // ── Review feedback reaches the next run (fix runs) ─────────────────
    //
    // A FRESH run (not a resume) is given the Task's open findings and is
    // only told it fixed them once it finishes, so it CARRIES them first:
    //
    //   consumedByRunId NULL                  pending (unchanged)
    //   consumedByRunId = R, consumedAt NULL  carried by run R, outcome unknown
    //   consumedByRunId = R, consumedAt set   consumed (unchanged; `markConsumed`
    //                                         writes both at once for a resume)
    //
    // No new column: the carried state is the one combination the resume
    // path never writes. `findPendingForTask` reads a carried row as not
    // pending, which is right while its run is in flight; a run that ends
    // without completing gives its rows back (`releaseCarried`).

    /** Does the Task have any row that is not consumed yet? The dispatch path's cheap first read. */
    async hasOpenForTask(taskId: string): Promise<boolean> {
        const row = await this.repository.findOne({
            where: { taskId, consumedAt: IsNull() },
            select: { id: true },
        });
        return !!row;
    }

    /**
     * The Task's rows that are not consumed yet — pending, or carried by a
     * run whose outcome is not recorded — oldest first. The caller decides
     * which of the carried ones are really still open (their run failed, was
     * cancelled, or is the one being planned).
     *
     * No age cutoff: a finding stays open until a run that was given it
     * completes. What scopes the read is the pull request, IN the query: a
     * row recorded on a pull request (`prNumber` set) is read only while that
     * pull request is the Task's open one (`openPullRequest`); a row with no
     * pull request (a Task review, the platform's own gate) always is. So
     * rows about a pull request that was merged, closed or replaced can never
     * fill the page and hide a finding about the current one.
     */
    async findOpenForTask(
        taskId: string,
        opts: { openPullRequest?: number | null; limit?: number } = {},
    ): Promise<TaskReviewRejection[]> {
        const open: FindOptionsWhere<TaskReviewRejection> = { taskId, consumedAt: IsNull() };
        const where: FindOptionsWhere<TaskReviewRejection>[] = [{ ...open, prNumber: IsNull() }];
        if (typeof opts.openPullRequest === 'number') {
            where.push({ ...open, prNumber: opts.openPullRequest });
        }
        return this.repository.find({
            where,
            order: { createdAt: 'ASC' },
            take: Math.max(1, Math.min(100, opts.limit ?? 50)),
        });
    }

    /**
     * Claim rows for a fresh run, then answer what this run now holds,
     * oldest first. CAS-guarded twice: a row is taken only while nothing has
     * consumed it, and only from nobody, from this run (a re-plan of the same
     * job), or from a run named in `reclaimFrom` (one the caller saw end
     * without completing). Two runs planned at once cannot both carry a row.
     */
    async carryForRun(
        ids: string[],
        runId: string,
        reclaimFrom: readonly string[] = [],
    ): Promise<TaskReviewRejection[]> {
        if (ids.length === 0) return [];
        await this.repository.update(
            { id: In(ids), consumedAt: IsNull(), consumedByRunId: IsNull() },
            { consumedByRunId: runId },
        );
        const from = [...new Set(reclaimFrom.filter((id) => id && id !== runId))];
        if (from.length > 0) {
            await this.repository.update(
                { id: In(ids), consumedAt: IsNull(), consumedByRunId: In(from) },
                { consumedByRunId: runId },
            );
        }
        return this.repository.find({
            where: { id: In(ids), consumedByRunId: runId, consumedAt: IsNull() },
            order: { createdAt: 'ASC' },
        });
    }

    /** The run that carried rows COMPLETED: they are consumed, by that run. */
    async markCarriedConsumed(runId: string): Promise<number> {
        const result = await this.repository.update(
            { consumedByRunId: runId, consumedAt: IsNull() },
            { consumedAt: new Date() },
        );
        return result.affected ?? 0;
    }

    /**
     * The run that carried rows did NOT finish them — it failed, was
     * cancelled, or stopped to ask its owner a question: they are pending
     * again. With `ids`, only those rows (the ones a plan could not fit).
     */
    async releaseCarried(runId: string, ids?: readonly string[]): Promise<number> {
        if (ids && ids.length === 0) return 0;
        const result = await this.repository.update(
            {
                consumedByRunId: runId,
                consumedAt: IsNull(),
                ...(ids ? { id: In([...ids]) } : {}),
            },
            { consumedByRunId: null },
        );
        return result.affected ?? 0;
    }
}
