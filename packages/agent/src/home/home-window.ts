import type { HomeDayWindow } from '@ever-works/contracts';
import { isValidTimezone, resolveRunWindow } from '../agents/run-window';

/**
 * Home (AW-19) — which timezone "today" means, and the day it covers.
 *
 * The day window is the Runs ledger's own day window (`resolveRunWindow`), so
 * the `done today` / `failed today` counters and the ledger they link to can
 * never disagree about where today starts, including across a DST change.
 * A timezone the ledger accepts is a timezone Home accepts.
 */

/** A timezone was named explicitly and is not one the runtime knows. */
export class InvalidHomeTimezoneError extends Error {
    readonly code = 'invalid-timezone';

    constructor(timezone: string) {
        super(`Unknown timezone: ${timezone.slice(0, 64)}`);
        this.name = 'InvalidHomeTimezoneError';
    }
}

export interface ResolvedHomeTimezone {
    timezone: string;
    /** True when no usable timezone was known and UTC was used instead. */
    fallback: boolean;
}

/**
 * Resolution order:
 *
 *  1. the explicit `candidate` (`?tz=`) — an override that wins over
 *     everything, and that is refused when it is not a real zone rather than
 *     silently replaced: a wrong day boundary is a wrong number;
 *  2. the profile timezone — the account's own choice, so it wins over
 *     whatever zone the device happens to be in;
 *  3. the `browserTimezone` hint (`?browserTz=`, what the dashboard sends
 *     for an account with no profile zone) — used only when the profile has
 *     none, and simply ignored when it is not a real zone: a hint is never a
 *     reason to refuse the page;
 *  4. UTC, reported as the fallback.
 *
 * A stale profile value falls through to the hint, then to UTC.
 */
export function resolveHomeTimezone(
    candidate: string | null | undefined,
    profileTimezone: string | null | undefined,
    browserTimezone?: string | null,
): ResolvedHomeTimezone {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
        const trimmed = candidate.trim();
        if (!isValidTimezone(trimmed)) {
            throw new InvalidHomeTimezoneError(trimmed);
        }
        return { timezone: trimmed, fallback: false };
    }
    if (isValidTimezone(profileTimezone)) {
        return { timezone: profileTimezone, fallback: false };
    }
    const hint = typeof browserTimezone === 'string' ? browserTimezone.trim() : '';
    if (hint.length > 0 && isValidTimezone(hint)) {
        return { timezone: hint, fallback: false };
    }
    return { timezone: 'UTC', fallback: true };
}

/** The user's local calendar day containing `now`, as `[from, to)` instants. */
export function buildHomeDay(timezone: string, now: Date): HomeDayWindow {
    const window = resolveRunWindow({ granularity: 'day', timezone, now });
    return { date: window.anchorDate, from: window.from, to: window.to };
}
