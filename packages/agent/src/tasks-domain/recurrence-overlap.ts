import {
    In,
    IsNull,
    MoreThanOrEqual,
    Not,
    type FindOperator,
    type FindOptionsWhere,
} from 'typeorm';
import { TaskStatus, type Task } from '../entities/task.entity';
import {
    TASK_CLOSED_PR_SLOT_HOLD_MS,
    TASK_CLOSED_UNMERGED_PR_STATE,
    taskActiveRunExists,
} from './task-open-work';

/**
 * Recurring Tasks — the per-template overlap limit (`tasks.recurrenceMaxOpenInstances`).
 *
 * Every fire of a recurring template spawns a NEW Task instance with its own run, branch and
 * pull request. Without a limit a daily loop opens a pull request every day whatever its review
 * backlog is. `recurrenceMaxOpenInstances = N` means "at most N instances of this template may
 * be unfinished": a scheduled fire at the limit is SKIPPED (its slot passes, nothing spawns),
 * and run-now answers 409 `SCHEDULE_TOO_MANY_OPEN` unless the owner forces it. NULL (every row,
 * and the default) = no limit, exactly today's behaviour.
 *
 * Pure rules only (typeorm operators and constants); the count runs in
 * `TaskRepository.countOpenRecurrenceInstances`, the decisions in
 * `TaskRecurrenceDispatcherService.dispatchDue` and `TasksService.runRecurringNow`.
 */

/** The largest limit a template may carry. A bound, not a recommendation. */
export const RECURRENCE_MAX_OPEN_INSTANCES_LIMIT = 100;

/**
 * How long an instance with NO pull-request outcome (no pull request yet, or one the status
 * sweep has not read) counts as open: 7 days after it was spawned. This is the rule that keeps
 * the limit from stalling a schedule for good: a run that failed and left its instance in To do,
 * or a pull request on a provider the sweep can no longer read, stops holding a slot a week
 * later even if nobody touches it.
 */
export const RECURRENCE_OPEN_INSTANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Pull-request states (`tasks.prState`) of a pull request still waiting on a reviewer. */
export const RECURRENCE_OPEN_PR_STATES = ['open', 'draft'] as const;

/**
 * A skip writes an activity row when it starts a run of skips, or comes at least this long after
 * the previous skip. So an hourly or slower schedule records every skip, and a faster one only
 * the first of a run of skips (the Schedules page still shows the latest one).
 */
export const RECURRENCE_SKIP_RECORD_GAP_MS = 55 * 60_000;

/** At most this many open instances are named in a skip record or a 409 body. */
export const RECURRENCE_OPEN_INSTANCES_NAMED = 10;

/** One open instance, as a skip record and the run-now refusal name it. */
export interface OpenRecurrenceInstance {
    id: string;
    slug: string;
    title: string;
    status: TaskStatus;
    prNumber: number | null;
    prUrl: string | null;
    prState: string | null;
    createdAt: Date;
}

/** What `TaskRepository.countOpenRecurrenceInstances` answers. */
export interface OpenRecurrenceInstances {
    count: number;
    /** The oldest {@link RECURRENCE_OPEN_INSTANCES_NAMED} of them. */
    instances: OpenRecurrenceInstance[];
}

/**
 * The stored limit as the dispatcher reads it: a whole number from 1 to
 * {@link RECURRENCE_MAX_OPEN_INSTANCES_LIMIT}, or `null` = no limit. A hand-edited row with
 * anything else (0, a negative, a fraction) reads as no limit, never as "nothing may run"; a
 * value above the bound reads as the bound.
 */
export function normalizeMaxOpenInstances(raw: unknown): number | null {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return null;
    return Math.min(raw, RECURRENCE_MAX_OPEN_INSTANCES_LIMIT);
}

/**
 * The per-template claim a scheduled fire under a limit and a run-now both hold while they count
 * the open instances and insert the new one, so neither two dispatcher ticks nor a tick and a
 * run-now can both pass the count. One key for both paths (`TasksService.withRunNowClaim`).
 */
export function recurrenceFireLockKey(templateId: string): string {
    return `schedule-run-now:${templateId}`;
}

/**
 * The instances of `templateId` that count against its limit. An instance is OPEN while ANY of:
 *
 *  1. **a run of it is queued or running** (any status, any pull-request state; a run waiting on
 *     a human's answer is still running) — work in flight always counts;
 *  2. **it is not Done or Cancelled and its pull request is open or a draft** — an unreviewed pull
 *     request is exactly the backlog the limit is for, so this branch has NO age bound: the
 *     reviewer frees the slot by merging or closing it, the owner by cancelling the instance;
 *  3. **it is not Done or Cancelled, has no pull-request outcome yet (`prState` NULL: no pull
 *     request, or one the status sweep has not read) and was spawned in the last 7 days**
 *     ({@link RECURRENCE_OPEN_INSTANCE_WINDOW_MS});
 *  4. **it is not Done or Cancelled, its pull request was closed without merging, and it changed
 *     in the last 24 hours** (by `updatedAt` or by `ciCheckedAt`, the read that saw it close) —
 *     the hold a Mission's open-Tasks cap uses ({@link TASK_CLOSED_PR_SLOT_HOLD_MS}), two branches
 *     because SQL has no GREATEST on every driver.
 *
 * A merged pull request frees the slot at once (the review happened), and so does Done or
 * Cancelled. Every branch but 1 and 2 is bounded in time, and those two end by themselves (a
 * run finishes or is reaped; a pull request is merged or closed), so no instance holds a slot
 * forever. `prState` is nullable and SQL's `<>` drops NULLs, hence OR-ed branches.
 */
export function recurrenceOpenInstancesWhere(
    templateId: string,
    opts: { now: Date; activeRunExists?: FindOperator<string> },
): FindOptionsWhere<Task>[] {
    const base: FindOptionsWhere<Task> = { parentRecurringTaskId: templateId };
    const unfinished: FindOptionsWhere<Task> = {
        ...base,
        status: Not(In([TaskStatus.DONE, TaskStatus.CANCELLED])),
    };
    const freshSince = new Date(opts.now.getTime() - RECURRENCE_OPEN_INSTANCE_WINDOW_MS);
    const closedSince = new Date(opts.now.getTime() - TASK_CLOSED_PR_SLOT_HOLD_MS);
    const closed: FindOptionsWhere<Task> = {
        ...unfinished,
        prState: TASK_CLOSED_UNMERGED_PR_STATE,
    };
    return [
        { ...base, id: opts.activeRunExists ?? taskActiveRunExists(undefined, 'overlap_run') },
        { ...unfinished, prState: In([...RECURRENCE_OPEN_PR_STATES]) },
        { ...unfinished, prState: IsNull(), createdAt: MoreThanOrEqual(freshSince) },
        { ...closed, updatedAt: MoreThanOrEqual(closedSince) },
        { ...closed, ciCheckedAt: MoreThanOrEqual(closedSince) },
    ];
}

/** `escape`-aware run operator for {@link recurrenceOpenInstancesWhere}, alias `overlap_run`. */
export function recurrenceActiveRunExists(escape?: (name: string) => string): FindOperator<string> {
    return taskActiveRunExists(escape, 'overlap_run');
}

/**
 * Whether a skip writes an activity row: the first skip of a run of skips (`previousSkipAt`
 * null), or one at least {@link RECURRENCE_SKIP_RECORD_GAP_MS} after the previous skip.
 */
export function shouldRecordRecurrenceSkip(
    previousSkipAt: Date | null | undefined,
    now: Date,
): boolean {
    if (!previousSkipAt) return true;
    return now.getTime() - previousSkipAt.getTime() >= RECURRENCE_SKIP_RECORD_GAP_MS;
}

/** `T-12, T-15 and 1 more` — the open instances a skip or a refusal names. */
export function nameOpenInstances(open: OpenRecurrenceInstances): string {
    const slugs = open.instances.map((instance) => instance.slug);
    const shown = slugs.slice(0, 5).join(', ');
    const more = open.count - Math.min(slugs.length, 5);
    return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * The activity summary of a skipped scheduled fire, e.g.
 * `Skipped: 3 instances still open (T-12, T-15, T-18); at most 3 at a time.`
 */
export function describeRecurrenceSkip(open: OpenRecurrenceInstances, max: number): string {
    const noun = open.count === 1 ? 'instance' : 'instances';
    const names = nameOpenInstances(open);
    return `Skipped: ${open.count} ${noun} still open${names ? ` (${names})` : ''}; at most ${max} at a time.`;
}

/** The run-now refusal message (409 `SCHEDULE_TOO_MANY_OPEN`). */
export function describeRecurrenceRefusal(open: OpenRecurrenceInstances, max: number): string {
    const noun = open.count === 1 ? 'instance is' : 'instances are';
    const names = nameOpenInstances(open);
    return (
        `At most ${max} ${max === 1 ? 'instance' : 'instances'} of this schedule may be open at a time, ` +
        `and ${open.count} ${noun} still open${names ? ` (${names})` : ''}. ` +
        'Review or close them, or run it anyway with force.'
    );
}
