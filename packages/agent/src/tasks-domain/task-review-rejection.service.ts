import {
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { DomainEventPublisher } from '../domain-events/domain-event-publisher.service';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { TaskRepository } from '../database/repositories/task.repository';
import { TaskReviewRejectionRepository } from '../database/repositories/task-review-rejection.repository';
import { TaskReviewerRepository } from '../database/repositories/task-side.repositories';
import { WorkRepository } from '../database/repositories/work.repository';
import {
    selectReviewFeedback,
    type ReviewFeedbackItem,
    type RunReviewFeedback,
} from '../agents/review-feedback-brief';
import { findTaskForPullRequest } from './task-repository';
import { isAgentReviewRunScope } from './task-agent-review';
import type { AgentRun } from '../entities/agent-run.entity';
import type { Task } from '../entities/task.entity';
import type {
    TaskReviewRejection,
    TaskReviewRejectionReviewerKind,
    TaskReviewRejectionSeverity,
} from '../entities/task-review-rejection.entity';

/**
 * Review feedback reaches the next run — how many open findings one claim
 * reads. It bounds a read on the dispatch path; it is not a product limit
 * (the caps on what a run is GIVEN live in `review-feedback-brief.ts`).
 */
const REVIEW_FEEDBACK_SCAN = 50;

/** How a run ended, as the board denorm records it (`TaskRunTerminalStatus`). */
export type ReviewFeedbackRunOutcome = 'completed' | 'failed' | 'cancelled';

/**
 * Orchestration M9 — the write half of the rejection loop.
 *
 * The plan's mechanism is "when a reviewer rejects, the rejection text is
 * persisted and prepended to the resumed session's context". The READ
 * half already exists (`RunSteeringService.resume` claims pending rows);
 * this service is every way a rejection can be produced.
 *
 * ## The review record this feature had to define
 *
 * There was no durable rejection anywhere in the codebase before this.
 * `task_reviewers.reviewState` carries a three-value enum
 * (`pending | requested-changes | approved`) and **no feedback text**, and
 * nothing in product code ever wrote it — `TaskReviewerRepository.setState`
 * had zero non-test callers. The PR review loop posted its verdict to the
 * git provider and kept nothing locally.
 *
 * So the minimal record is `task_review_rejections`: Task-scoped (the run
 * that was rejected is already terminal and the next run is a new row, so
 * the Task is the only stable join), append-only, with `consumedByRunId`
 * as its entire state machine. Two existing signals feed it:
 *
 *  1. **Task review** — {@link rejectTask}. This is also where
 *     `task_reviewers.reviewState` finally gets written: rejecting flips
 *     the caller's reviewer row to `requested-changes`, so the pre-existing
 *     advisory signal and the new durable one can never disagree.
 *  2. **Pull-request state** — {@link recordPullRequestRejection}, called
 *     from the GitHub webhook bridge on a `changes_requested` review. The
 *     PR is resolved to its Task by `findTaskForPullRequest`: only Works whose
 *     TASK repository this is, every one of them — the same rule the resume
 *     path (`TaskGitLinkService`, `isTaskRepo`) reads it back with.
 */
@Injectable()
export class TaskReviewRejectionService {
    private readonly logger = new Logger(TaskReviewRejectionService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly rejections: TaskReviewRejectionRepository,
        private readonly reviewers: TaskReviewerRepository,
        private readonly works: WorkRepository,
        // Domain events (EW-P1-1 B2) — a rejection moves the reviewer's
        // `reviewState`, which the task DTO shows: `task.updated`. Appended
        // LAST + @Optional (positional-spec arity rule).
        @Optional() private readonly domainEvents?: DomainEventPublisher,
        // Review feedback reaches the next run — the run being planned and
        // the Task's earlier runs (see `claimFeedbackForRun`). Appended LAST +
        // @Optional (positional-spec arity rule); absent, no fresh run is ever
        // given feedback and nothing is settled (the resume path is unchanged).
        @Optional() private readonly runs?: AgentRunRepository,
    ) {}

    /**
     * A human rejected the agent's work on a Task.
     *
     * Owner-scoped through `findByIdAndUser`, so a Task belonging to
     * someone else is indistinguishable from a missing one (no existence
     * oracle — architecture/security §9).
     */
    async rejectTask(
        userId: string,
        taskId: string,
        feedback: string,
        opts: { runId?: string | null } = {},
    ): Promise<TaskReviewRejection> {
        const trimmed = (feedback ?? '').trim();
        if (trimmed.length === 0) {
            // A rejection with no words gives the next run nothing to act
            // on. Refuse loudly rather than persisting an empty prepend.
            throw new ForbiddenException('Rejection feedback is required.');
        }
        const task = await this.tasks.findByIdAndUser(taskId, userId);
        if (!task) throw new NotFoundException(`Task ${taskId} not found.`);

        const row = await this.rejections.record({
            taskId: task.id,
            source: 'task-review',
            feedback: trimmed,
            workId: task.workId ?? null,
            runId: opts.runId ?? null,
            reviewerUserId: userId,
            organizationId: task.organizationId ?? null,
        });
        // `record` only returns null for empty feedback, which is already
        // refused above — but the type is honest, so satisfy it honestly.
        if (!row) throw new ForbiddenException('Rejection feedback is required.');

        // Wire the PRE-EXISTING advisory signal: if this user is a
        // declared reviewer on the Task, their row now says what they
        // actually did. Best-effort — the durable rejection is the record
        // that matters, and a missing reviewer row is normal (anyone with
        // access can reject).
        await this.syncReviewerState(task.id, userId);
        if (this.domainEvents) {
            const publisher = this.domainEvents;
            await publisher
                .transaction((manager) =>
                    publisher.changed(manager, 'task', task.id, 'task.updated', {
                        changedFields: ['reviewers'],
                    }),
                )
                .catch((err) =>
                    this.logger.warn(`Could not record task.updated for ${task.id}: ${err}`),
                );
        }

        this.logger.log(`Task ${task.id}: rejection recorded by user ${userId}.`);
        return row;
    }

    /**
     * A human — or a trusted reviewer bot (R16) — rejected the agent's
     * PULL REQUEST on the git provider.
     *
     * Best-effort by contract and returns `null` on every miss: the caller
     * is a webhook handler that must answer 200 quickly, and "we could not
     * map this PR to a Task" is an ordinary outcome (the PR may belong to
     * a repo that is not a Work, or to a Task that was deleted). It is
     * never an error the delivery should fail on.
     *
     * `reviewerKind` and `severity` are the bridge's classification of the
     * author and of the bot's own marker; they are stored verbatim so the
     * resumed run can tell a CodeRabbit "Major" from a nit.
     */
    async recordPullRequestRejection(input: {
        userId: string;
        owner: string;
        repo: string;
        prNumber: number;
        feedback: string;
        reviewerLabel?: string | null;
        prUrl?: string | null;
        reviewerKind?: TaskReviewRejectionReviewerKind | null;
        severity?: TaskReviewRejectionSeverity | null;
        /** Item 11 — `review:<id>` / `<comment event>:<id>`; a redelivery records nothing. */
        sourceKey?: string | null;
    }): Promise<TaskReviewRejection | null> {
        const trimmed = (input.feedback ?? '').trim();
        if (trimmed.length === 0) return null;
        try {
            const candidates = await this.works.findByUser(input.userId);
            const found = await findTaskForPullRequest(
                candidates ?? [],
                input.owner,
                input.repo,
                input.prNumber,
                (workId, prNumber) => this.tasks.findByWorkAndPrNumber(workId, prNumber),
            );
            if (!found) return null;
            const { work, task } = found;
            const row = await this.rejections.record({
                taskId: task.id,
                source: 'pull-request',
                feedback: trimmed,
                workId: work.id,
                reviewerLabel: input.reviewerLabel ?? null,
                prNumber: input.prNumber,
                prUrl: input.prUrl ?? null,
                reviewerKind: input.reviewerKind ?? null,
                severity: input.severity ?? null,
                sourceKey: input.sourceKey ?? null,
                organizationId: task.organizationId ?? null,
            });
            if (row) {
                this.logger.log(
                    `Task ${task.id}: PR rejection recorded from ${input.owner}/${input.repo}#${input.prNumber}.`,
                );
            }
            return row;
        } catch (error) {
            this.logger.warn(
                `PR rejection record failed for ${input.owner}/${input.repo}#${input.prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * The gate gave up. Machine-authored feedback, recorded so a LATER
     * resume replays it — the iterate loop already fed it to the run that
     * was executing, but that run is terminal and its context is gone.
     */
    async recordGateRejection(input: {
        taskId: string;
        workId?: string | null;
        runId?: string | null;
        feedback: string;
        organizationId?: string | null;
    }): Promise<TaskReviewRejection | null> {
        return this.rejections.record({
            taskId: input.taskId,
            source: 'gate',
            feedback: input.feedback,
            workId: input.workId ?? null,
            runId: input.runId ?? null,
            organizationId: input.organizationId ?? null,
        });
    }

    // ── Review feedback reaches the next run (fix runs) ─────────────

    /**
     * The findings a FRESH run of this Task must address, claimed for it.
     *
     * Called where a run's prompt is built — the fleet planner and the cloud
     * worker — for every dispatch path that ends in a run of the Task (Run on
     * the board or `POST /api/tasks/:id/run`, a transition fan-out, a
     * recurring re-run, a drained or parked run). Before this, recorded
     * findings reached a RESUMED run only, and a resume refuses a completed
     * run: a new run started from the Task's standing brief and treated
     * itself as fresh work.
     *
     * What counts as open for `runId` — no timestamp inference, the rows say:
     *
     *  - not consumed (`consumedAt` NULL). A finding stays open until a run
     *    that was GIVEN it completes; nothing else retires it;
     *  - pending, already carried by this run (a re-plan of the same job), or
     *    carried by a run that ended WITHOUT finishing it — failed, cancelled,
     *    or one whose hand-back was missed ({@link carrierGaveItUp}). A run
     *    still queued or running keeps what it carries;
     *  - about the Task's CURRENT pull request when the row names one: a row
     *    recorded on a pull request that was merged, closed or replaced is
     *    about code that is no longer under review, and is not replayed
     *    ({@link openPullRequestNumberOf}). A row that names no pull request
     *    (a Task review, the platform's own gate) always counts.
     *
     * Oldest first, within the caps of `selectReviewFeedback`; what does not
     * fit stays pending for the next run. The rows are CARRIED (`consumedByRunId`
     * set, `consumedAt` not yet) and only become consumed when the run
     * completes ({@link settleFeedbackForRun}).
     *
     * Never throws: the run goes ahead without the section (and says so in
     * the log) rather than failing because a lookup hiccuped — and since no
     * run ever becomes a cutoff, a run that went ahead without the section
     * hides nothing from the next one. A review run, a run of another Task or
     * another owner, and a non-Task run get nothing.
     */
    async claimFeedbackForRun(input: {
        taskId: string;
        runId: string;
        userId: string;
    }): Promise<RunReviewFeedback | null> {
        const { taskId, runId, userId } = input;
        if (!this.runs || !taskId || !runId) return null;
        try {
            const run = await this.runs.findById(runId);
            if (!run || run.taskId !== taskId || run.userId !== userId) return null;
            if (run.triggerKind !== 'task' || isAgentReviewRunScope(run.delegationScope)) {
                return null;
            }
            // The common case — nothing was ever rejected, or all of it is
            // consumed — costs this one read.
            if (!(await this.rejections.hasOpenForTask(taskId))) return null;

            const task = await this.tasks.findById(taskId);
            if (!task || task.userId !== userId) return null;
            const open = await this.rejections.findOpenForTask(taskId, {
                openPullRequest: openPullRequestNumberOf(task),
                limit: REVIEW_FEEDBACK_SCAN,
            });
            if (open.length === 0) return null;

            const carrierIds = [
                ...new Set(
                    open
                        .map((row) => row.consumedByRunId)
                        .filter((id): id is string => !!id && id !== runId),
                ),
            ];
            const runsById = new Map<string, AgentRun>(
                carrierIds.length > 0
                    ? (await this.runs.findByIds(carrierIds)).map((row) => [row.id, row])
                    : [],
            );

            const reclaimFrom = new Set<string>();
            const finished = new Set<string>();
            const eligible = open.filter((row) => {
                const carrier = row.consumedByRunId ?? null;
                // Pending, or already this run's (a retried enqueue re-plans the job).
                if (!carrier || carrier === runId) return true;
                const carrierRun = runsById.get(carrier);
                if (carrierGaveItUp(carrierRun, runId)) {
                    reclaimFrom.add(carrier);
                    return true;
                }
                // Its run COMPLETED and its settle was missed: consumed, by that run.
                if (carrierRun?.status === 'completed') finished.add(carrier);
                return false;
            });
            // Self-heal a missed settle, so those rows stop looking open.
            for (const carrier of finished) {
                await this.rejections.markCarriedConsumed(carrier).catch(() => 0);
            }
            if (eligible.length === 0) return null;

            const { selected, omitted } = selectReviewFeedback(eligible);
            const carried = await this.rejections.carryForRun(
                selected.map((row) => row.id),
                runId,
                [...reclaimFrom],
            );
            if (carried.length === 0) return null;
            this.logger.log(
                `Run ${runId}: carries ${carried.length} review finding(s) for task ${taskId}${
                    omitted > 0 ? ` (${omitted} left for a later run)` : ''
                }.`,
            );
            return { items: carried.map(toFeedbackItem), omitted };
        } catch (error) {
            this.logger.warn(
                `Run ${runId}: review-feedback lookup failed — the run starts without it: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * The run that carried findings has ended. Completed: the findings are
     * consumed by it, so no later run is told to fix them again. Failed or
     * cancelled: they are pending again, for the next run and for the resume
     * path's own reader.
     *
     * A run that completed PARKED on an owner question did not finish them
     * either, and hands them back too: pending, they are what
     * `RunSteeringService.resume` replays into the run the owner's answer
     * starts (its first input — the resume path as it was before fresh runs
     * carried findings), or what the next fresh run is given. Keeping them on
     * the parked run stranded them: the resume clears the parked flag before
     * the successor is planned or claims anything (review of #3150).
     *
     * Called from `TaskRunDenormService.recordTerminal`, the one write both
     * runtimes make when a run ends. Best-effort: a missed settle is covered
     * by {@link claimFeedbackForRun}, which reads the carrier's own status,
     * and by the resume, which hands a parked run's rows back itself.
     * Never throws.
     */
    async settleFeedbackForRun(runId: string, outcome: ReviewFeedbackRunOutcome): Promise<void> {
        if (!runId) return;
        try {
            if (outcome === 'completed') {
                const run = this.runs ? await this.runs.findById(runId) : null;
                if (run?.awaitingInput === true) {
                    await this.rejections.releaseCarried(runId);
                    return;
                }
                await this.rejections.markCarriedConsumed(runId);
                return;
            }
            await this.rejections.releaseCarried(runId);
        } catch (error) {
            this.logger.warn(
                `Run ${runId}: review-feedback settle (${outcome}) failed — the next claim re-reads the run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Hand back the findings a run carries but was NOT shown: the fleet
     * planner shrinks the section when the Task's brief leaves too little of
     * the instructions budget, and those rows must reach the next run rather
     * than be consumed by one that never saw them. Never throws.
     */
    async releaseFeedbackForRun(runId: string, ids: readonly string[]): Promise<void> {
        if (!runId || ids.length === 0) return;
        try {
            await this.rejections.releaseCarried(runId, ids);
        } catch (error) {
            this.logger.warn(
                `Run ${runId}: could not hand back ${ids.length} review finding(s) it was not shown — the next claim takes them over once the run ends: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    // ── internals ──────────────────────────────────────────────────

    private async syncReviewerState(taskId: string, userId: string): Promise<void> {
        try {
            const rows = await this.reviewers.findByTaskId(taskId);
            const mine = rows.find(
                (row) => row.reviewerType === 'user' && row.reviewerId === userId,
            );
            if (!mine) return;
            await this.reviewers.setState(mine.id, 'requested-changes', taskId);
        } catch (error) {
            this.logger.warn(
                `Task ${taskId}: reviewer-state sync failed (rejection still recorded): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

/**
 * The Task's pull request while it is still OPEN, or `null`: the one pull
 * request whose recorded findings are still about code under review. The
 * same reading as the workspace's `openPullRequestOf` — a merged or closed
 * pull request, or a branch merged, cleaned up or discarded, has none.
 */
export function openPullRequestNumberOf(
    task: Pick<Task, 'prNumber' | 'prState' | 'branchState'>,
): number | null {
    if (typeof task.prNumber !== 'number' || task.prNumber <= 0) return null;
    if (task.prState === 'merged' || task.prState === 'closed') return null;
    if (['merged', 'cleaned', 'discarded'].includes(task.branchState ?? '')) return null;
    return task.prNumber;
}

/**
 * Did the run that carried a finding end WITHOUT finishing it, so that
 * `runId` may take it over? The run's settle hands its rows back as it ends;
 * this covers a settle that never happened. Failed and cancelled, plainly;
 * completed but parked on an owner question; and the run `runId` resumes. A
 * run row that cannot be found carries nothing. A run still queued or
 * running is working on it — never taken over.
 */
function carrierGaveItUp(carrier: AgentRun | undefined, runId: string): boolean {
    if (!carrier) return true;
    if (carrier.status === 'failed' || carrier.status === 'cancelled') return true;
    if (carrier.status === 'completed') {
        return carrier.awaitingInput === true || carrier.resumeSuccessorRunId === runId;
    }
    return false;
}

function toFeedbackItem(row: TaskReviewRejection): ReviewFeedbackItem {
    return {
        id: row.id,
        source: row.source,
        feedback: row.feedback,
        reviewerLabel: row.reviewerLabel ?? null,
        reviewerKind: row.reviewerKind ?? null,
        severity: row.severity ?? null,
        prNumber: row.prNumber ?? null,
        createdAt: row.createdAt ?? null,
    };
}
