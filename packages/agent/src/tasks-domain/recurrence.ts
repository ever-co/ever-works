import { RRule } from 'rrule';
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
 * the result back to an instant.
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

/** `instant`'s wall-clock time in `timeZone`, as a Date whose UTC fields hold it. */
export function toFloatingTime(instant: Date, timeZone: string): Date {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(instant);
    const field = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value ?? 0);
    return new Date(
        Date.UTC(
            field('year'),
            field('month') - 1,
            field('day'),
            field('hour'),
            field('minute'),
            field('second'),
            instant.getUTCMilliseconds(),
        ),
    );
}

/**
 * The instant whose wall-clock time in `timeZone` is `floating`'s UTC fields.
 * A wall time that does not exist (the spring-forward gap) lands just after
 * the gap.
 */
export function fromFloatingTime(floating: Date, timeZone: string): Date {
    let guess = floating.getTime();
    for (let i = 0; i < 4; i += 1) {
        const offset = toFloatingTime(new Date(guess), timeZone).getTime() - guess;
        const next = floating.getTime() - offset;
        if (next === guess) break;
        guess = next;
    }
    return new Date(guess);
}

export interface NextOccurrenceContext {
    rule: string;
    from: Date;
    /** IANA zone the rule's wall-clock times are in (`recurrenceTimezone`); UTC when absent. */
    timezone?: string | null;
    recurrenceEndsAt?: Date | null;
    recurrenceMaxOccurrences?: number | null;
    recurrenceOccurredCount?: number;
}

/**
 * Compute the next occurrence strictly after `from`. Honors
 * `recurrenceEndsAt` + `recurrenceMaxOccurrences` caps. Returns
 * null when the recurrence is exhausted (no more fires).
 */
export function computeNextOccurrence(ctx: NextOccurrenceContext): Date | null {
    if (
        ctx.recurrenceMaxOccurrences != null &&
        (ctx.recurrenceOccurredCount ?? 0) >= ctx.recurrenceMaxOccurrences
    ) {
        return null;
    }
    const timeZone = cadenceTimeZone(ctx.timezone);
    const from = timeZone ? toFloatingTime(ctx.from, timeZone) : ctx.from;
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
            options.dtstart = new Date(Math.floor(from.getTime() / 60_000) * 60_000);
        }
        parsed = new RRule(options);
    } catch {
        return null;
    }
    const floatingNext = parsed.after(from, false);
    if (!floatingNext) return null;
    const next = timeZone ? fromFloatingTime(floatingNext, timeZone) : floatingNext;
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
    from: Date;
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
    const timeZone = cadenceTimeZone(ctx.timezone);
    const nextIso = computeNextCronFire(
        ctx.cron,
        timeZone ? toFloatingTime(ctx.from, timeZone) : ctx.from,
    );
    if (!nextIso) return null;
    const next = timeZone ? fromFloatingTime(new Date(nextIso), timeZone) : new Date(nextIso);
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
