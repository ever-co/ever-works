import type { TaskAcceptanceCheck } from '@ever-works/contracts';

/**
 * Acceptance checks as the Task forms SAVE them (New Task, the Task-detail
 * Checks section): rows the API's `AcceptanceCheckDto` would refuse are made
 * valid or dropped, instead of failing the whole save with a generic 400.
 *
 *   - a row without a command is an unused row → dropped (the New Task form
 *     already did this; the Task-detail editor sent it and got a 400);
 *   - a blank name → the command (cut to 120): the DTO requires a name;
 *   - an id the DTO refuses — longer than 41 characters (the editor derives it
 *     from the name with no cap), or not slug-safe — is re-derived, cut to 41,
 *     and made unique within the list;
 *   - a timeout below 1 (the field allows typing 0) → none; above 3600 → 3600.
 *
 * Every other field (phase, mountDir, envPassthrough, …) is kept as is.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,40}$/;
const ID_MAX = 41;
const NAME_MAX = 120;
const TIMEOUT_MAX = 3600;

function slug(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, ID_MAX)
        .replace(/-+$/g, '');
}

function uniqueId(base: string, taken: Set<string>): string {
    let candidate = base || 'check';
    for (let n = 2; taken.has(candidate); n += 1) {
        const suffix = `-${n}`;
        candidate = `${(base || 'check').slice(0, ID_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
    }
    taken.add(candidate);
    return candidate;
}

export function acceptanceChecksForSave(
    checks: readonly TaskAcceptanceCheck[],
): TaskAcceptanceCheck[] {
    const taken = new Set<string>();
    const rows = checks.filter((check) => check.command.trim().length > 0);
    // Valid ids first, so a re-derived one never takes a name a valid row already holds.
    for (const check of rows) {
        if (ID_PATTERN.test(check.id)) taken.add(check.id);
    }
    return rows.map((check) => {
        const command = check.command.trim();
        const name = (check.name.trim() || command).slice(0, NAME_MAX);
        const id = ID_PATTERN.test(check.id)
            ? check.id
            : uniqueId(slug(check.id) || slug(name), taken);
        const out: TaskAcceptanceCheck = { ...check, id, name, command };
        if (check.timeoutSec !== undefined) {
            const timeout = Math.round(check.timeoutSec);
            if (!Number.isFinite(timeout) || timeout < 1) {
                delete out.timeoutSec;
            } else {
                out.timeoutSec = Math.min(timeout, TIMEOUT_MAX);
            }
        }
        return out;
    });
}
