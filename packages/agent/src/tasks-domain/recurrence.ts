import { RRule } from 'rrule';
import { fleetZonedInstant } from '@ever-works/contracts';
import { TaskStatus, type Task } from '../entities/task.entity';
import { parseCron } from '../missions/cron-matcher';
import { computeNextCronFire } from '../schedules/cadence';

/**
 * Tasks feature — Phase 17.2 / 17.3.
 *
 * RRULE validation + next-occurrence computation. Wraps the `rrule`
 * package so the rest of the platform doesn't need to import its
 * surface directly.
 *
 * Cadences are evaluated in the template's `recurrenceTimezone` (UTC when
 * unset): "every Monday 09:00" in Europe/Berlin fires at 09:00 Berlin time,
 * across DST. The zone used to be "a hint for UI rendering" only: the UI
 * sends the browser's zone with the rule, yet the math ran in UTC, so every
 * user east or west of UTC got their Tasks an hour or more off. The math runs
 * on "floating" dates (UTC fields = wall-clock time in the zone) and converts
 * the result back to an instant the RFC 5545 way, with the same helper the
 * Fleet schedule preview uses (`fleetZonedInstant`): a time the clock skips
 * (spring forward) runs as far past the jump as it was written into the gap
 * (02:30 → 03:30), and a time the clock repeats (fall back) runs once, the
 * first time. The next run is always strictly after both the slot that fired
 * and "now".
 *
 * RRULE strings follow RFC 5545 (e.g. `FREQ=DAILY;BYHOUR=9`).
 */

export function validateRecurrenceRule(
    rule: string,
): { valid: true } | { valid: false; reason: string } {
    if (!rule || typeof rule !== 'string') {
        return { valid: false, reason: 'recurrenceRule is required when isRecurring=true.' };
    }
    if (rule.length > 200) {
        return { valid: false, reason: 'recurrenceRule exceeds 200 characters.' };
    }
    try {
        const parsed = RRule.fromString(rule);
        if (!parsed.options.freq && parsed.options.freq !== 0) {
            return { valid: false, reason: 'RRULE missing FREQ.' };
        }
        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            reason: `RRULE parse error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Schedule-modes upgrade — validate a 5-field cron expression for the
 * `recurrenceCron` alternative cadence. Reuses the Mission tick worker's
 * `parseCron` so accepted syntax matches what the dispatcher later
 * evaluates via `computeNextCronFire` exactly.
 */
export function validateRecurrenceCron(
    expr: string,
): { valid: true } | { valid: false; reason: string } {
    if (!expr || typeof expr !== 'string') {
        return { valid: false, reason: 'recurrenceCron is required when provided.' };
    }
    if (expr.length > 120) {
        return { valid: false, reason: 'recurrenceCron exceeds 120 characters.' };
    }
    try {
        parseCron(expr.trim());
        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            reason: `Cron parse error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/** The zone to evaluate a cadence in, or null for UTC (also for an unknown zone). */
function cadenceTimeZone(timezone: string | null | undefined): string | null {
    if (!timezone || timezone === 'UTC' || timezone === 'Etc/UTC') return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return timezone;
    } catch {
        return null;
    }
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = wallClockFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        if (wallClockFormatters.size > 200) wallClockFormatters.clear();
        wallClockFormatters.set(timeZone, formatter);
    }
    return formatter;
}

/** `instant`'s wall-clock time in `timeZone`, as a Date whose UTC fields hold it. */
export function toFloatingTime(instant: Date, timeZone: string): Date {
    const parts = wallClockFormatter(timeZone).formatToParts(instant);
    const field = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value ?? 0);
    return new Date(
        Date.UTC(
            field('year'),
            field('month') - 1,
            field('day'),
            field('hour') % 24,
            field('minute'),
            field('second'),
            instant.getUTCMilliseconds(),
        ),
    );
}

/**
 * The instant whose wall-clock time in `timeZone` is `floating`'s UTC fields,
 * read the RFC 5545 (§3.3.5) way through `fleetZonedInstant` (#3138), so a
 * recurring Task and the Fleet schedule preview agree on every clock change:
 *
 *  - a wall time the clock skips (spring forward) is read with the offset in
 *    force BEFORE the jump, so it lands as far past the jump as it was written
 *    into the gap: 02:30 in New York on 2026-03-08 is 03:30 EDT;
 *  - a wall time the clock repeats (fall back) is its FIRST occurrence: 02:30
 *    in Berlin on 2026-10-25 is 02:30 CEST (00:30Z), not 02:30 CET.
 *
 * The old fixed-point iteration stopped wherever its count left it inside a
 * gap, which west of UTC was an hour BEFORE the gap: the next run came out as
 * the slot that had just fired, and the template fired every minute.
 */
export function fromFloatingTime(floating: Date, timeZone: string): Date {
    const minute = fleetZonedInstant(
        floating.getUTCFullYear(),
        floating.getUTCMonth() + 1,
        floating.getUTCDate(),
        floating.getUTCHours(),
        floating.getUTCMinutes(),
        timeZone,
    );
    return new Date(minute + floating.getUTCSeconds() * 1000 + floating.getUTCMilliseconds());
}

/** `timeZone`'s offset from UTC at `ms`, in ms (Berlin in summer: +7 200 000). */
function zoneOffsetMs(ms: number, timeZone: string): number {
    return toFloatingTime(new Date(ms), timeZone).getTime() - ms;
}

const DAY_MS = 86_400_000;

/**
 * How far BEFORE the wall-clock time of "after" a slot can be and still run
 * after it: a slot written into a spring-forward gap runs past the jump (02:30
 * is still owed at 03:10 EDT). Two hours covers every gap there is (the
 * same margin as `nextFleetScheduleFire`).
 */
const GAP_SLACK_MS = 2 * 60 * 60_000;

/** Upper bound on slots looked at for one answer; a real search needs a few hundred at most. */
const MAX_SLOTS_SCANNED = 100_000;

/**
 * The first slot of a cadence that runs STRICTLY after `after`. `nextSlot(c)`
 * answers the cadence's first floating slot strictly after the floating time
 * `c` (slots are wall-clock times in `timeZone`).
 *
 * Wall-clock order is not run order around a clock change, so instead of
 * converting one slot and trusting it, slots are walked in order until one
 * runs after `after`. That is what makes the answer strictly later than the
 * slot that fired and than "now" in every zone: a slot that resolves to the
 * same instant as `after` (or earlier, in a repeated hour) is passed over.
 * Near a clock change the walk starts {@link GAP_SLACK_MS} earlier, for the
 * gap slots that run after the jump.
 */
function firstZonedSlotAfter(
    nextSlot: (cursor: Date) => Date | null,
    after: Date,
    timeZone: string,
): Date | null {
    const afterMs = after.getTime();
    const clockChangesNear =
        zoneOffsetMs(afterMs - DAY_MS, timeZone) !== zoneOffsetMs(afterMs + DAY_MS, timeZone);
    let cursor = new Date(
        toFloatingTime(after, timeZone).getTime() - (clockChangesNear ? GAP_SLACK_MS : 0),
    );
    for (let scanned = 0; scanned < MAX_SLOTS_SCANNED; scanned += 1) {
        const slot = nextSlot(cursor);
        if (!slot || slot.getTime() <= cursor.getTime()) return null;
        const at = fromFloatingTime(slot, timeZone);
        if (at.getTime() > afterMs) return at;
        cursor = slot;
    }
    return null;
}

/** The later of the slot that fired and "now": the next run is searched from there. */
function searchStart(from: Date, now: Date | null | undefined): Date {
    return now && now.getTime() > from.getTime() ? now : from;
}

export interface NextOccurrenceContext {
    rule: string;
    /** The slot that just fired (or "now" for a new cadence): the series is anchored on it. */
    from: Date;
    /**
     * The current time. The next run is strictly after the later of `from` and
     * `now`, so slots missed while the dispatcher was down are NOT replayed one
     * per tick: after an outage a template fires once (the overdue slot) and
     * then resumes its schedule from now. Absent = `from`.
     */
    now?: Date | null;
    /** IANA zone the rule's wall-clock times are in (`recurrenceTimezone`); UTC when absent. */
    timezone?: string | null;
    recurrenceEndsAt?: Date | null;
    recurrenceMaxOccurrences?: number | null;
    recurrenceOccurredCount?: number;
}

/**
 * Compute the next occurrence strictly after `from` (and after `now` when
 * given). Honors `recurrenceEndsAt` + `recurrenceMaxOccurrences` caps.
 * Returns null when the recurrence is exhausted (no more fires).
 */
export function computeNextOccurrence(ctx: NextOccurrenceContext): Date | null {
    if (
        ctx.recurrenceMaxOccurrences != null &&
        (ctx.recurrenceOccurredCount ?? 0) >= ctx.recurrenceMaxOccurrences
    ) {
        return null;
    }
    const timeZone = cadenceTimeZone(ctx.timezone);
    const anchor = timeZone ? toFloatingTime(ctx.from, timeZone) : ctx.from;
    let parsed: RRule;
    try {
        const options = RRule.parseString(ctx.rule);
        // Times at a whole minute: an hour without minutes means :00, and no
        // seconds ever. Without a DTSTART the rule took both from "now" (a
        // 09:00 rule fired at 09:00:35, or at 09:37 when BYMINUTE was absent).
        if (options.byhour != null && options.byminute == null) options.byminute = 0;
        if (options.bysecond == null) options.bysecond = 0;
        // Anchor the series on `from` (the slot that just fired), not on the
        // moment this runs, so a rule's default time of day does not drift by
        // however late the dispatcher ran.
        if (!options.dtstart) {
            options.dtstart = new Date(Math.floor(anchor.getTime() / 60_000) * 60_000);
        }
        parsed = new RRule(options);
    } catch {
        return null;
    }
    const start = searchStart(ctx.from, ctx.now);
    const next = timeZone
        ? firstZonedSlotAfter((cursor) => parsed.after(cursor, false), start, timeZone)
        : parsed.after(start, false);
    if (!next) return null;
    if (ctx.recurrenceEndsAt && next.getTime() > ctx.recurrenceEndsAt.getTime()) {
        return null;
    }
    return next;
}

export interface TemplateCadenceContext {
    /** RFC 5545 RRULE — XOR with `cron`. */
    rule?: string | null;
    /** 5-field cron expression — XOR with `rule`. */
    cron?: string | null;
    /** The slot that just fired (or "now" for a new cadence). */
    from: Date;
    /** The current time: the next run is strictly after the later of `from` and `now` (see {@link NextOccurrenceContext.now}). */
    now?: Date | null;
    /** IANA zone the cadence's wall-clock times are in (`recurrenceTimezone`); UTC when absent. */
    timezone?: string | null;
    recurrenceEndsAt?: Date | null;
    recurrenceMaxOccurrences?: number | null;
    recurrenceOccurredCount?: number;
}

/**
 * Cadence-dialect-agnostic next occurrence: RRULE templates go through
 * {@link computeNextOccurrence}, cron templates through
 * `schedules/cadence.ts#computeNextCronFire`. Same caps
 * (`recurrenceEndsAt` / `recurrenceMaxOccurrences`) apply to both, so
 * the dispatcher does not need to know which dialect a template uses.
 */
export function computeNextTemplateOccurrence(ctx: TemplateCadenceContext): Date | null {
    if (ctx.rule) {
        return computeNextOccurrence({
            rule: ctx.rule,
            from: ctx.from,
            now: ctx.now ?? null,
            timezone: ctx.timezone ?? null,
            recurrenceEndsAt: ctx.recurrenceEndsAt ?? null,
            recurrenceMaxOccurrences: ctx.recurrenceMaxOccurrences ?? null,
            recurrenceOccurredCount: ctx.recurrenceOccurredCount ?? 0,
        });
    }
    if (!ctx.cron) return null;
    if (
        ctx.recurrenceMaxOccurrences != null &&
        (ctx.recurrenceOccurredCount ?? 0) >= ctx.recurrenceMaxOccurrences
    ) {
        return null;
    }
    // `computeNextCronFire` reads UTC fields, so it runs on floating times too.
    const cron = ctx.cron;
    const timeZone = cadenceTimeZone(ctx.timezone);
    const start = searchStart(ctx.from, ctx.now);
    const nextCronSlot = (cursor: Date): Date | null => {
        const iso = computeNextCronFire(cron, cursor);
        return iso ? new Date(iso) : null;
    };
    const next = timeZone
        ? firstZonedSlotAfter(nextCronSlot, start, timeZone)
        : nextCronSlot(start);
    if (!next) return null;
    if (ctx.recurrenceEndsAt && next.getTime() > ctx.recurrenceEndsAt.getTime()) {
        return null;
    }
    return next;
}

/**
 * Phase 17.5 — clone a recurring template Task into a fresh
 * instance. Returns the partial entity ready to insert. Caller
 * (`TaskRecurrenceDispatcherService.dispatchDue`) sets the slug +
 * userTaskCounter increment.
 *
 * The clone:
 *   - copies identity (title, description, priority, labels, FULL owner
 *     tuple — mission/idea/work AND team/agent/goal, so a spawned
 *     instance keeps the agent binding that lets it dispatch)
 *   - resets state (status=todo — instances are actionable, not parked
 *     in backlog; startedAt/completedAt=null, previousStatus=null)
 *   - sets parentRecurringTaskId = template.id
 *   - clears recurring + scheduled columns (the instance is NOT itself
 *     recurring, nor a one-shot)
 *   - clears parentTaskId (recurrence ≠ sub-task; service-layer
 *     callers can re-link if needed)
 *
 * Schedule-modes fix: previously the clone dropped teamId/agentId/goalId
 * (and the dispatcher copied no assignees), so spawned instances sat
 * inert with nothing to run them. Assignee rows are copied by the
 * dispatcher (`TaskRecurrenceDispatcherService`) since they live in a
 * side table this pure function cannot reach.
 *
 * Record visibility (review 2026-10-17 F1): the instance carries the
 * template's title and description, so it keeps the template's
 * `visibility` + `visibilityExplicit`. Without them the insert-time
 * default turned every instance of a private template into an
 * `organization` row (and a Team template's into one too, when its Team
 * came through `team_resources`, which the instance does not get).
 */
export function cloneRecurringTaskAsInstance(template: Task): Partial<Task> {
    const visibility: Partial<Task> = {};
    if (template.visibility) {
        visibility.visibility = template.visibility;
        visibility.visibilityExplicit = template.visibilityExplicit ?? false;
    }
    return {
        ...visibility,
        userId: template.userId,
        tenantId: template.tenantId ?? null,
        organizationId: template.organizationId ?? null,
        title: template.title,
        description: template.description ?? null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: template.priority,
        labels: template.labels ?? null,
        missionId: template.missionId ?? null,
        ideaId: template.ideaId ?? null,
        workId: template.workId ?? null,
        teamId: template.teamId ?? null,
        agentId: template.agentId ?? null,
        goalId: template.goalId ?? null,
        parentTaskId: null,
        createdByType: template.createdByType,
        createdById: template.createdById,
        requireAllApprovers: template.requireAllApprovers,
        startedAt: null,
        completedAt: null,
        // Recurring columns — the instance is not itself a template.
        isRecurring: false,
        recurrenceRule: null,
        recurrenceCron: null,
        recurrenceTimezone: null,
        nextOccurrenceAt: null,
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        // Overlap limit — a template setting, never an instance's.
        recurrenceMaxOpenInstances: null,
        recurrenceSkippedAt: null,
        parentRecurringTaskId: template.id,
        // One-shot columns — never inherited.
        scheduledAt: null,
        scheduleClaimedAt: null,
    };
}
