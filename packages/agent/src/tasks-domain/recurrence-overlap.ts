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
 * 7 days: how long a run in flight counts after it started (or was queued), an instance with no
 * pull-request outcome after it was spawned, and an open pull request the PR-status sweep no
 * longer writes after the instance's last write. So a question nobody answers, a run parked
 * behind a paused Agent, a failed run left in To do, or an open pull request on an instance taken
 * out of its Work stops holding a slot a week later even if nobody touches it. It does NOT bound
 * an open pull request the sweep keeps writing (see `recurrenceOpenInstancesWhere`).
 */
export const RECURRENCE_OPEN_INSTANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Pull-request states (`tasks.prState`) of a pull request still waiting on a reviewer. */
export const RECURRENCE_OPEN_PR_STATES = ['open', 'draft'] as const;

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

/** The template fields the open-instance rule reads. */
export type RecurrenceTemplateRef = Pick<Task, 'id'> & { workId?: string | null };

/**
 * The instances of `template` that count against its limit. An instance is OPEN while ANY of:
 *
 *  1. **a run of it is queued or running, and that run started (or, never started, was queued)
 *     in the last 7 days**: `COALESCE(startedAt, createdAt)`, the age the run sweeper measures.
 *     Any status, any pull-request state. A run waiting on a human (`awaitingInput`, which the
 *     sweeper never reaps) or held queued (a paused Agent, the global stop flag, a fleet usage
 *     limit, all exempt from the sweeper) therefore stops counting a week after it started;
 *  2. **it is not Done or Cancelled, its pull request is open or a draft, it is still on the
 *     template's Work, and the PR-status sweep read it in the last 7 days** (`ciCheckedAt`, which
 *     the sweep stamps on every read). An unreviewed pull request is the backlog the limit is
 *     for, so while the sweep keeps reading it there is no age bound: the reviewer frees the slot
 *     by merging or closing it, the owner by cancelling the instance;
 *  3. **it is not Done or Cancelled, its pull request is open or a draft, and the instance was
 *     written in the last 7 days** (`updatedAt`). Every PR-status sweep write
 *     (`TaskRepository.updatePrStatusCache`) bumps `updatedAt` too (TypeORM's update builder
 *     appends `updatedAt = CURRENT_TIMESTAMP` unless the SET names it), so this branch only ages
 *     out for an instance the sweep no longer writes: one with no Work (taken out of it, or a
 *     template with no Work, whose instances have none) or one whose reads keep failing;
 *  4. **it is not Done or Cancelled, has no pull-request outcome yet (`prState` NULL: no pull
 *     request, or one the status sweep has not read) and was spawned in the last 7 days**;
 *  5. **it is not Done or Cancelled, its pull request was closed without merging, and it changed
 *     in the last 24 hours** (by `updatedAt` or by `ciCheckedAt`, the read that saw it close):
 *     the hold a Mission's open-Tasks cap uses ({@link TASK_CLOSED_PR_SLOT_HOLD_MS}), two branches
 *     because SQL has no GREATEST on every driver.
 *
 * A merged pull request frees the slot at once (the review happened), and so does Done or
 * Cancelled.
 *
 * What ends by itself: 1 a week after the run started, 4 a week after the spawn, 5 a day after the
 * read that saw the pull request close, and 2 / 3 once the sweep sees the pull request merged or
 * closed, or (for an instance it stops writing) a week after the instance's last write.
 *
 * What does NOT end by itself: an open pull request the sweep keeps writing without ever seeing it
 * merged or closed. That is an instance moved to ANOTHER Work (read against that Work's
 * repository), or a pull request the provider answers "not found" for (deleted repository, lost
 * access, removed app: the sweep stamps the read and keeps `prState`). Such an instance holds its
 * slot until someone cancels it or forces run-now; the daily `schedule_skipped` row names it.
 *
 * Branch 2 is left out when the template has no Work (an `undefined` key would drop the
 * predicate rather than match nothing). `prState` is nullable and SQL's `<>` drops NULLs, hence
 * OR-ed branches.
 */
export function recurrenceOpenInstancesWhere(
    template: RecurrenceTemplateRef,
    opts: { now: Date; escape?: (name: string) => string },
): FindOptionsWhere<Task>[] {
    // An `undefined` key would DROP the predicate and count every Task in the table.
    if (typeof template?.id !== 'string' || template.id.length === 0) {
        throw new Error('recurrenceOpenInstancesWhere needs the template row (its id).');
    }
    const base: FindOptionsWhere<Task> = { parentRecurringTaskId: template.id };
    const unfinished: FindOptionsWhere<Task> = {
        ...base,
        status: Not(In([TaskStatus.DONE, TaskStatus.CANCELLED])),
    };
    const windowSince = new Date(opts.now.getTime() - RECURRENCE_OPEN_INSTANCE_WINDOW_MS);
    const closedSince = new Date(opts.now.getTime() - TASK_CLOSED_PR_SLOT_HOLD_MS);
    const openPr: FindOptionsWhere<Task> = {
        ...unfinished,
        prState: In([...RECURRENCE_OPEN_PR_STATES]),
    };
    const closed: FindOptionsWhere<Task> = {
        ...unfinished,
        prState: TASK_CLOSED_UNMERGED_PR_STATE,
    };
    const branches: FindOptionsWhere<Task>[] = [
        { ...base, id: recurrenceActiveRunExists(opts.escape, opts.now) },
    ];
    if (template.workId) {
        branches.push({
            ...openPr,
            workId: template.workId,
            ciCheckedAt: MoreThanOrEqual(windowSince),
        });
    }
    branches.push(
        { ...openPr, updatedAt: MoreThanOrEqual(windowSince) },
        { ...unfinished, prState: IsNull(), createdAt: MoreThanOrEqual(windowSince) },
        { ...closed, updatedAt: MoreThanOrEqual(closedSince) },
        { ...closed, ciCheckedAt: MoreThanOrEqual(closedSince) },
    );
    return branches;
}

/**
 * The run-in-flight operator of {@link recurrenceOpenInstancesWhere} (alias `overlap_run`): a
 * queued or running run that started, or was queued, in the 7 days before `now`.
 */
export function recurrenceActiveRunExists(
    escape: ((name: string) => string) | undefined,
    now: Date,
): FindOperator<string> {
    return taskActiveRunExists(escape, 'overlap_run', {
        startedSince: new Date(now.getTime() - RECURRENCE_OPEN_INSTANCE_WINDOW_MS),
    });
}

/** `YYYY-MM-DD` of an instant in UTC. */
function utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/**
 * Whether a skip writes an activity row: the FIRST skip of a stall (`previousSkipAt` null; the
 * next spawn clears it), then the first skip of each UTC day the stall lasts. At most one row
 * per template per day however fast the schedule, and a long stall still shows up every day.
 */
export function shouldRecordRecurrenceSkip(
    previousSkipAt: Date | null | undefined,
    now: Date,
): boolean {
    if (!previousSkipAt) return true;
    return utcDay(previousSkipAt) !== utcDay(now);
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
