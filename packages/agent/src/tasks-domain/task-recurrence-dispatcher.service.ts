import { Injectable, Logger, Optional } from '@nestjs/common';
import { TaskRepository } from '../database/repositories/task.repository';
import {
    TaskAssigneeRepository,
    UserTaskCounterRepository,
} from '../database/repositories/task-side.repositories';
import { computeNextTemplateOccurrence, cloneRecurringTaskAsInstance } from './recurrence';
import { TaskNotificationService } from './task-notification.service';
import { TaskTransitionService } from './task-transition.service';
import { TaskGraphFanoutService, type TaskFanoutSummary } from './task-graph-fanout.service';
import { TaskStatus, type Task } from '../entities/task.entity';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { ownershipScopeOf } from '../database/ownership-scope';
import {
    describeRecurrenceSkip,
    normalizeMaxOpenInstances,
    recurrenceFireLockKey,
    shouldRecordRecurrenceSkip,
    type OpenRecurrenceInstances,
} from './recurrence-overlap';

/**
 * The per-template claim a scheduled fire under an overlap limit holds while it counts the open
 * instances, claims the slot and inserts the instance. The same lease as run-now's
 * (`TasksService`, same key), refreshed while held.
 */
const RECURRENCE_FIRE_CLAIM_TTL_MS = 60_000;
/** Hard ceiling on one scheduled fire holding that claim (count + spawn + dispatch). */
const RECURRENCE_FIRE_CLAIM_MAX_LIFETIME_MS = 10 * 60_000;

export interface RecurrenceDispatchEntry {
    templateId: string;
    templateSlug: string;
    scheduledFor: string;
    outcome: 'spawned' | 'skipped' | 'failed';
    /**
     * Why a `skipped` entry was skipped: `cas-lost` (another dispatcher claimed the slot first),
     * `busy` (another fire of this template held its claim; the slot stays due and the next tick
     * retries it) or `over-limit` (the template is at its open-instance limit; the slot passed).
     */
    skipReason?: 'cas-lost' | 'busy' | 'over-limit';
    /** `over-limit` only — the open instances counted and the template's limit. */
    openInstances?: number;
    maxOpenInstances?: number;
    instanceId?: string;
    instanceSlug?: string;
    nextOccurrenceAt?: string | null;
    /** How the spawned instance's agent dispatch went. */
    dispatch?: 'dispatched' | 'no-agent' | 'not-attempted';
    message?: string;
}

export interface RecurrenceDispatchSummary {
    limit: number;
    dueCount: number;
    spawned: number;
    skipped: number;
    failed: number;
    entries: RecurrenceDispatchEntry[];
}

export interface ScheduleDispatchEntry {
    taskId: string;
    taskSlug: string;
    scheduledFor: string;
    outcome: 'dispatched' | 'no-agent' | 'skipped' | 'failed';
    message?: string;
}

/** EW-P2-3 — one tick of the due-soon scan. */
export interface DueSoonSummary {
    limit: number;
    windowHours: number;
    dueCount: number;
    notified: number;
    skipped: number;
    failed: number;
}

/** Hours ahead of `dueAt` the `task_due_soon` notice goes out (TASK_DUE_SOON_WINDOW_HOURS, default 24). */
export function taskDueSoonWindowHours(): number {
    const raw = Number(process.env.TASK_DUE_SOON_WINDOW_HOURS);
    return Number.isFinite(raw) && raw > 0 && raw <= 24 * 30 ? raw : 24;
}

export interface ScheduleDispatchSummary {
    limit: number;
    dueCount: number;
    dispatched: number;
    noAgent: number;
    skipped: number;
    failed: number;
    entries: ScheduleDispatchEntry[];
}

/**
 * Tasks feature — Phase 17.6 + schedule-modes upgrade.
 *
 * Cron-fed dispatcher with three scans per tick:
 *
 *  1. `dispatchDue` — recurring Task templates whose
 *     `nextOccurrenceAt <= now` (RRULE or cron cadence). CAS-claims each
 *     one, clones a fresh instance (KEEPING the owner tuple incl.
 *     agentId/teamId/goalId), COPIES the template's assignee rows, and
 *     dispatches the instance through the same gated path a board "Run"
 *     uses. Previously spawned instances carried no agent binding at all
 *     and sat inert — that is the defect this upgrade fixes.
 *
 *  2. `dispatchDueScheduled` — one-shot Tasks whose `scheduledAt <= now`
 *     and are unclaimed. CAS-claims via `scheduleClaimedAt`, then
 *     dispatches the Task itself (no clone).
 *
 *  3. `dispatchUnblockedTodo` — the task-graph fan-out (slice AH):
 *     TODO Tasks with zero OPEN blockers, started through the ordinary
 *     gated path, bounded per owner and OFF by default. It lives behind
 *     this class rather than beside it because this service is already
 *     in the worker RPC map, so a new METHOD needs no plumbing while a
 *     new service would need edits in five files.
 *
 * Both paths resolve the run agent as: agent assignees (fan-out, one run
 * per agent) → the Task's own `agentId`. When nothing resolves, the
 * `task_run_no_agent` notification fires instead of a silent skip — the
 * Task stays visibly queued (`todo`) for a human to pick up.
 *
 * The CAS guards are what stop two concurrent dispatcher workers from
 * double-spawning / double-dispatching at the same boundary. Mirrors
 * `AgentScheduleDispatcherService.dispatchDue` posture end to end.
 */
@Injectable()
export class TaskRecurrenceDispatcherService {
    private readonly logger = new Logger(TaskRecurrenceDispatcherService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly counter: UserTaskCounterRepository,
        // Third-pass fix: emit `task_recurrence_fired` after a successful
        // spawn so the dead enum branch in TaskNotificationService is
        // actually reachable. Optional() — when unbound (unit tests),
        // spawn still completes.
        @Optional() private readonly notifications?: TaskNotificationService,
        // Schedule-modes upgrade — assignee copy + agent dispatch.
        // Appended LAST + Optional so every positional construction in
        // the existing specs keeps compiling; graphs without them spawn
        // instances exactly as before (inert), never crash.
        @Optional() private readonly assignees?: TaskAssigneeRepository,
        @Optional() private readonly transitions?: TaskTransitionService,
        // Task-graph fan-out (slice AH). Appended LAST + Optional for the
        // same positional-construction reason as the two above; unbound,
        // `dispatchUnblockedTodo` reports a tick that started nothing.
        @Optional() private readonly fanout?: TaskGraphFanoutService,
        // Recurring Tasks overlap limit. Appended LAST + Optional for the same positional
        // reason. The lock is the shared DB-backed claim run-now holds (same key); unbound, a
        // per-process claim stands in. Without the activity log a skip is still made and still
        // shown on the Schedules page, it just leaves no activity row.
        @Optional() private readonly fireLock?: DistributedTaskLockService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    /** Per-process fire claims, used only when `fireLock` is unbound. */
    private readonly fireInFlight = new Set<string>();

    async dispatchDue(limit = 50, now: Date = new Date()): Promise<RecurrenceDispatchSummary> {
        const templates = await this.tasks.findDueRecurringTemplates(limit, now);
        const summary: RecurrenceDispatchSummary = {
            limit,
            dueCount: templates.length,
            spawned: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        for (const template of templates) {
            const scheduledFor = template.nextOccurrenceAt!;
            try {
                // Recurring Tasks overlap limit. NULL (the default) = no limit: the fire takes
                // exactly the path it always did, with no count and no claim.
                const maxOpen = normalizeMaxOpenInstances(template.recurrenceMaxOpenInstances);
                if (maxOpen === null) {
                    await this.fireOccurrence(template, scheduledFor, summary);
                    continue;
                }
                const held = await this.withFireClaim(template.id, () =>
                    this.fireWithinLimit(template, scheduledFor, maxOpen, now, summary),
                );
                if (!held) {
                    // A run-now (or another tick) of this template is counting and spawning
                    // right now. Nothing is claimed, so the slot stays due and the next tick
                    // decides it against the count that fire leaves behind.
                    summary.skipped += 1;
                    summary.entries.push({
                        templateId: template.id,
                        templateSlug: template.slug,
                        scheduledFor: scheduledFor.toISOString(),
                        outcome: 'skipped',
                        skipReason: 'busy',
                        message: 'Another fire of this schedule holds its claim; retried next tick',
                    });
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.error(
                    `Failed to spawn recurrence instance for ${template.id}: ${message}`,
                    err as Error,
                );
                summary.failed += 1;
                summary.entries.push({
                    templateId: template.id,
                    templateSlug: template.slug,
                    scheduledFor: scheduledFor.toISOString(),
                    outcome: 'failed',
                    message,
                });
            }
        }

        return summary;
    }

    /**
     * Schedule-modes upgrade — the one-shot half of the cron tick.
     * Walks due `scheduledAt` Tasks, CAS-claims each, and dispatches
     * the Task itself.
     */
    async dispatchDueScheduled(
        limit = 50,
        now: Date = new Date(),
    ): Promise<ScheduleDispatchSummary> {
        const due = await this.tasks.findDueScheduledTasks(limit, now);
        const summary: ScheduleDispatchSummary = {
            limit,
            dueCount: due.length,
            dispatched: 0,
            noAgent: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        for (const task of due) {
            const scheduledFor = task.scheduledAt!;
            try {
                const claimed = await this.tasks.casClaimSchedule(task.id, scheduledFor, now);
                if (!claimed) {
                    summary.skipped += 1;
                    summary.entries.push({
                        taskId: task.id,
                        taskSlug: task.slug,
                        scheduledFor: scheduledFor.toISOString(),
                        outcome: 'skipped',
                        message: 'CAS lost — another dispatcher claimed first',
                    });
                    continue;
                }

                // Make the fire visible on the board: a backlog one-shot
                // becomes actionable `todo`. Best-effort CAS — a Task
                // already moved by its owner is left alone.
                if (task.status === TaskStatus.BACKLOG) {
                    await this.tasks
                        .casUpdateStatus(task.id, TaskStatus.BACKLOG, {
                            status: TaskStatus.TODO,
                        })
                        .catch(() => false);
                }

                const outcome = await this.dispatchInstance(task);
                if (outcome === 'dispatched') {
                    summary.dispatched += 1;
                } else {
                    summary.noAgent += 1;
                }
                summary.entries.push({
                    taskId: task.id,
                    taskSlug: task.slug,
                    scheduledFor: scheduledFor.toISOString(),
                    outcome: outcome === 'dispatched' ? 'dispatched' : 'no-agent',
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.error(
                    `Failed to dispatch scheduled task ${task.id}: ${message}`,
                    err as Error,
                );
                summary.failed += 1;
                summary.entries.push({
                    taskId: task.id,
                    taskSlug: task.slug,
                    scheduledFor: scheduledFor.toISOString(),
                    outcome: 'failed',
                    message,
                });
            }
        }

        return summary;
    }

    /**
     * EW-P2-3 — the fourth scan of the tick: tell people a Task is due soon.
     *
     * Walks Tasks whose `dueAt` falls inside the next
     * {@link taskDueSoonWindowHours} hours and that have not been noticed for
     * that date, CAS-claims each (`dueSoonNotifiedAt`) and emits
     * `task_due_soon` to the owner and the Task's user assignees (watchers are
     * added by `TaskNotificationService`). Changing `dueAt` clears the claim,
     * so a moved deadline is noticed again. Never dispatches any work.
     *
     * A notice that did not reach every recipient releases its claim, so the
     * next tick tries again; notices are deduplicated per deadline, so a
     * recipient who already has one is not notified twice. With no
     * notification store bound the scan does not run at all (it would only
     * claim and release the same rows every minute).
     */
    async notifyDueSoon(limit = 100, now: Date = new Date()): Promise<DueSoonSummary> {
        const windowHours = taskDueSoonWindowHours();
        if (!this.notifications?.canDeliver()) {
            return { limit, windowHours, dueCount: 0, notified: 0, skipped: 0, failed: 0 };
        }
        const until = new Date(now.getTime() + windowHours * 3_600_000);
        const due = await this.tasks.findDueSoonTasks(limit, now, until);
        const summary: DueSoonSummary = {
            limit,
            windowHours,
            dueCount: due.length,
            notified: 0,
            skipped: 0,
            failed: 0,
        };
        for (const task of due) {
            let claimed = false;
            try {
                claimed = await this.tasks.casClaimDueSoon(task.id, task.dueAt!, now);
                if (!claimed) {
                    summary.skipped += 1;
                    continue;
                }
                const recipients = new Set<string>([task.userId]);
                const assignees = await this.assignees?.findByTaskId(task.id).catch(() => []);
                for (const assignee of assignees ?? []) {
                    if (assignee.assigneeType === 'user') recipients.add(assignee.assigneeId);
                }
                const delivery = await this.notifications.emitCounted(
                    'task_due_soon',
                    {
                        taskId: task.id,
                        taskSlug: task.slug,
                        taskTitle: task.title,
                        extra: { dueAt: task.dueAt!.toISOString() },
                    },
                    [...recipients],
                );
                if (delivery.sent < delivery.recipients) {
                    throw new Error(
                        `delivered ${delivery.sent} of ${delivery.recipients} due-soon notices`,
                    );
                }
                summary.notified += 1;
            } catch (err) {
                summary.failed += 1;
                if (claimed) {
                    // Give the notice back so the next tick retries it.
                    await this.tasks.releaseDueSoonClaim(task.id, now).catch(() => false);
                }
                this.logger.warn(
                    `Due-soon notice failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        return summary;
    }

    /**
     * Task-graph fan-out (slice AH) — the third scan of the tick.
     *
     * A thin delegation on purpose: `TaskGraphFanoutService` owns every
     * rule (the blocker predicate, the per-owner bound, the stop flag and
     * the admission probe), and this method only makes it reachable from
     * the cron through the RPC surface this class already has.
     *
     * Unbound service ⇒ a summary that plainly says nothing ran, never a
     * silent zero that reads like "there was nothing to do".
     */
    async dispatchUnblockedTodo(limit?: number): Promise<TaskFanoutSummary> {
        if (!this.fanout) {
            return {
                limit: limit ?? 0,
                candidateCount: 0,
                started: 0,
                skipped: 0,
                failed: 0,
                halted: false,
                disabled: true,
                maxStartsPerOwner: 0,
                entries: [],
            };
        }
        return this.fanout.dispatchUnblocked(limit);
    }

    // ── internals ─────────────────────────────────────────────────

    /**
     * One scheduled occurrence: CAS-claim the slot (advances `nextOccurrenceAt` and the
     * occurred count), spawn the instance, copy the assignees, dispatch it and notify. The
     * whole of a fire for a template with no overlap limit, the same steps as before the limit
     * existed; the tail of one under a limit.
     */
    private async fireOccurrence(
        template: Task,
        scheduledFor: Date,
        summary: RecurrenceDispatchSummary,
    ): Promise<void> {
        const nextSlot = computeNextTemplateOccurrence({
            rule: template.recurrenceRule ?? null,
            cron: template.recurrenceCron ?? null,
            from: scheduledFor,
            timezone: template.recurrenceTimezone ?? null,
            recurrenceEndsAt: template.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: template.recurrenceMaxOccurrences ?? null,
            recurrenceOccurredCount: (template.recurrenceOccurredCount ?? 0) + 1,
        });

        // CAS-claim — only one worker advances nextOccurrenceAt. A fire after a skipped one
        // clears the skip marker in the same write (only then, so every other claim is the
        // call it always was).
        const claimed = template.recurrenceSkippedAt
            ? await this.tasks.casClaimRecurrence(template.id, scheduledFor, nextSlot, {
                  clearSkip: true,
              })
            : await this.tasks.casClaimRecurrence(template.id, scheduledFor, nextSlot);
        if (!claimed) {
            summary.skipped += 1;
            summary.entries.push({
                templateId: template.id,
                templateSlug: template.slug,
                scheduledFor: scheduledFor.toISOString(),
                outcome: 'skipped',
                skipReason: 'cas-lost',
                message: 'CAS lost — another dispatcher claimed first',
            });
            return;
        }

        // Spawn the instance with a fresh per-user slug.
        const nextNumber = await this.counter.nextSlug(template.userId);
        const slug = `T-${nextNumber}`;
        const instanceData = {
            ...cloneRecurringTaskAsInstance(template),
            slug,
        };
        const instance = await this.tasks.create(instanceData);

        // Copy the template's assignee rows so the instance is
        // runnable by the same actors. Best-effort: a copy failure
        // must not fail the spawn (the instance still exists).
        await this.copyAssignees(template.id, instance.id);

        // Dispatch through THE gated path (concurrency valve,
        // credits precheck, denorm — all apply unchanged).
        const dispatchOutcome = await this.dispatchInstance(instance);

        summary.spawned += 1;
        summary.entries.push({
            templateId: template.id,
            templateSlug: template.slug,
            scheduledFor: scheduledFor.toISOString(),
            outcome: 'spawned',
            instanceId: instance.id,
            instanceSlug: instance.slug,
            nextOccurrenceAt: nextSlot?.toISOString() ?? null,
            dispatch: dispatchOutcome,
        });

        // Third-pass fix: in-app notification for the spawned
        // instance. Discriminator uses recurrenceOccurredCount
        // (advanced by casClaimRecurrence) so consecutive
        // occurrences don't dedup-collapse. Best-effort.
        if (this.notifications) {
            void this.notifications
                .emit(
                    'task_recurrence_fired',
                    {
                        taskId: instance.id,
                        taskSlug: instance.slug,
                        taskTitle: instance.title,
                        occurrenceCount: (template.recurrenceOccurredCount ?? 0) + 1,
                    },
                    [template.userId],
                )
                .catch(() => undefined);
        }
    }

    /**
     * Recurring Tasks overlap limit — one scheduled fire of a template that carries a limit,
     * run under the per-template claim ({@link withFireClaim}). The count, the slot claim and the
     * instance insert all happen while the claim is held, and run-now holds the same claim, so
     * two dispatcher ticks (or a tick and a run-now) can never both see "below the limit" and
     * both spawn. At the limit the slot is SKIPPED instead ({@link skipOccurrence}).
     */
    private async fireWithinLimit(
        template: Task,
        scheduledFor: Date,
        maxOpen: number,
        now: Date,
        summary: RecurrenceDispatchSummary,
    ): Promise<void> {
        const open = await this.tasks.countOpenRecurrenceInstances(template, now);
        if (open.count >= maxOpen) {
            await this.skipOccurrence(template, scheduledFor, maxOpen, open, now, summary);
            return;
        }
        await this.fireOccurrence(template, scheduledFor, summary);
    }

    /**
     * Skip one scheduled slot of a template at its limit: `nextOccurrenceAt` still advances (or
     * the slot would stay due and re-fire every minute), `recurrenceOccurredCount` does not (a
     * skipped slot is not an occurrence, so the next slot is computed from the same count), and
     * `recurrenceSkippedAt` records it for the Schedules page. The first skip of a stall, then
     * the first skip of each UTC day it lasts (`shouldRecordRecurrenceSkip`), also writes a
     * `schedule_skipped` activity row on the template naming the open instances.
     */
    private async skipOccurrence(
        template: Task,
        scheduledFor: Date,
        maxOpen: number,
        open: OpenRecurrenceInstances,
        now: Date,
        summary: RecurrenceDispatchSummary,
    ): Promise<void> {
        const nextSlot = computeNextTemplateOccurrence({
            rule: template.recurrenceRule ?? null,
            cron: template.recurrenceCron ?? null,
            from: scheduledFor,
            timezone: template.recurrenceTimezone ?? null,
            recurrenceEndsAt: template.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: template.recurrenceMaxOccurrences ?? null,
            recurrenceOccurredCount: template.recurrenceOccurredCount ?? 0,
        });
        const skipped = await this.tasks.casSkipRecurrence(
            template.id,
            scheduledFor,
            nextSlot,
            now,
        );
        summary.skipped += 1;
        if (!skipped) {
            summary.entries.push({
                templateId: template.id,
                templateSlug: template.slug,
                scheduledFor: scheduledFor.toISOString(),
                outcome: 'skipped',
                skipReason: 'cas-lost',
                message: 'CAS lost — another dispatcher claimed first',
            });
            return;
        }
        const message = describeRecurrenceSkip(open, maxOpen);
        summary.entries.push({
            templateId: template.id,
            templateSlug: template.slug,
            scheduledFor: scheduledFor.toISOString(),
            outcome: 'skipped',
            skipReason: 'over-limit',
            openInstances: open.count,
            maxOpenInstances: maxOpen,
            nextOccurrenceAt: nextSlot?.toISOString() ?? null,
            message,
        });
        if (shouldRecordRecurrenceSkip(template.recurrenceSkippedAt, now)) {
            await this.recordSkip(template, scheduledFor, nextSlot, maxOpen, open, message);
        }
    }

    /** The `schedule_skipped` activity row on the template. Best-effort: never fails a tick. */
    private async recordSkip(
        template: Task,
        scheduledFor: Date,
        nextSlot: Date | null,
        maxOpen: number,
        open: OpenRecurrenceInstances,
        summary: string,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            const scope = ownershipScopeOf(template);
            await this.activityLog.log({
                // Same posture as every other task-domain activity row: owner + scope, the Task in
                // `details` (the Task page reads `resourceType` / `resourceId`), no `workId`.
                userId: template.userId,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                actionType: ActivityActionType.SCHEDULE_SKIPPED,
                action: ActivityActionType.SCHEDULE_SKIPPED,
                status: ActivityStatus.CANCELLED,
                summary,
                details: {
                    source: 'schedule',
                    reason: 'max-open-instances',
                    scheduleId: `recurring_task:${template.id}`,
                    scheduledFor: scheduledFor.toISOString(),
                    nextOccurrenceAt: nextSlot?.toISOString() ?? null,
                    maxOpenInstances: maxOpen,
                    openInstances: open.count,
                    openInstanceIds: open.instances.map((instance) => instance.id),
                    openInstanceSlugs: open.instances.map((instance) => instance.slug),
                    resourceType: 'task',
                    resourceId: template.id,
                },
            });
        } catch (err) {
            this.logger.warn(`Skip record failed for template ${template.id}: ${err}`);
        }
    }

    /**
     * Hold the per-template fire claim for `fire`; `false` when another holder has it (nothing
     * ran). The shared DB-backed `DistributedTaskLockService` under the key run-now uses
     * (`recurrenceFireLockKey`), so the claim serialises across API replicas and against run-now;
     * a graph without it falls back to a per-process claim with the same refuse-don't-wait
     * semantics.
     */
    private async withFireClaim(templateId: string, fire: () => Promise<void>): Promise<boolean> {
        if (this.fireLock) {
            const outcome = await this.fireLock.runExclusive(
                recurrenceFireLockKey(templateId),
                fire,
                {
                    ttlMs: RECURRENCE_FIRE_CLAIM_TTL_MS,
                    maxLifetimeMs: RECURRENCE_FIRE_CLAIM_MAX_LIFETIME_MS,
                },
            );
            return outcome.acquired;
        }
        if (this.fireInFlight.has(templateId)) return false;
        this.fireInFlight.add(templateId);
        try {
            await fire();
            return true;
        } finally {
            this.fireInFlight.delete(templateId);
        }
    }

    private async copyAssignees(templateTaskId: string, instanceTaskId: string): Promise<void> {
        if (!this.assignees) return;
        try {
            const rows = await this.assignees.findByTaskId(templateTaskId);
            for (const row of rows) {
                await this.assignees
                    .add(instanceTaskId, row.assigneeType, row.assigneeId)
                    .catch((err) =>
                        this.logger.warn(
                            `Assignee copy failed for instance ${instanceTaskId}: ${err}`,
                        ),
                    );
            }
        } catch (err) {
            this.logger.warn(`Assignee lookup failed for template ${templateTaskId}: ${err}`);
        }
    }

    /**
     * Dispatch a spawned/scheduled Task through
     * `TaskTransitionService.dispatchAgentRun` — THE single dispatch
     * path, so the concurrency gate and the board denorm apply
     * unchanged. Agent resolution: agent assignees (one run per agent,
     * mirroring the drag-to-in-progress fan-out) → the Task's own
     * `agentId` column. No resolvable agent → `task_run_no_agent`
     * notification instead of a silent skip.
     */
    private async dispatchInstance(
        task: Task,
    ): Promise<'dispatched' | 'no-agent' | 'not-attempted'> {
        if (!this.transitions) return 'not-attempted';

        const agentIds = new Set<string>();
        if (this.assignees) {
            try {
                const agentRows = await this.assignees.findAgentAssignees(task.id);
                for (const row of agentRows) agentIds.add(row.assigneeId);
            } catch (err) {
                this.logger.warn(`Agent-assignee lookup failed for task ${task.id}: ${err}`);
            }
        }
        if (agentIds.size === 0 && task.agentId) {
            agentIds.add(task.agentId);
        }

        if (agentIds.size === 0) {
            if (this.notifications) {
                void this.notifications
                    .emit(
                        'task_run_no_agent',
                        {
                            taskId: task.id,
                            taskSlug: task.slug,
                            taskTitle: task.title,
                        },
                        [task.userId],
                    )
                    .catch(() => undefined);
            }
            return 'no-agent';
        }

        // Dedup discriminator: a spawned recurrence instance has a fresh
        // task id per occurrence, so the generation suffices; a RE-scheduled
        // one-shot reuses its task id, so the fired slot itself is the
        // discriminator (two fires of the same Task at different slots must
        // not dedup-collapse).
        const discriminator =
            task.scheduledAt?.getTime() ?? (task.recurrenceOccurredCount ?? 0) + 1;
        let anyDispatched = false;
        for (const agentId of agentIds) {
            // dispatchAgentRun never throws — failures are recorded on the
            // run row; a parked (gated) run still counts as dispatched
            // because it is visibly queued and will be promoted.
            const result = await this.transitions.dispatchAgentRun(task, agentId, {
                dedupKey: `${task.id}:${agentId}:schedule:${discriminator}`,
            });
            if (result.dispatched || result.parked) anyDispatched = true;
        }
        return anyDispatched ? 'dispatched' : 'no-agent';
    }
}
