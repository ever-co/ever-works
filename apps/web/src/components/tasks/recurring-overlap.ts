/**
 * Recurring Tasks overlap limit — the "At most N open at a time" field's text, as the API wants
 * it (`recurrenceMaxOpenInstances`). Pure, so the rule is unit-tested without rendering.
 *
 * Mirrors the API bound (`RECURRENCE_MAX_OPEN_INSTANCES_LIMIT` in
 * `packages/agent/src/tasks-domain/recurrence-overlap.ts`); the server validates again.
 */
export const MAX_OPEN_INSTANCES_LIMIT = 100;

export type MaxOpenInstancesInput = { ok: true; value: number | null } | { ok: false };

/** Blank = no limit (`null`); a whole number 1..100 = that limit; anything else is invalid. */
export function parseMaxOpenInstances(text: string): MaxOpenInstancesInput {
    const trimmed = text.trim();
    if (trimmed === '') return { ok: true, value: null };
    if (!/^\d+$/.test(trimmed)) return { ok: false };
    const value = Number(trimmed);
    if (value < 1 || value > MAX_OPEN_INSTANCES_LIMIT) return { ok: false };
    return { ok: true, value };
}

/** The field's text for a stored limit: blank for none. */
export function formatMaxOpenInstances(value: number | null | undefined): string {
    return value == null ? '' : String(value);
}
