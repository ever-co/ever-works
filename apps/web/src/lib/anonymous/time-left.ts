/**
 * How long an anonymous account has left before the nightly cleanup deletes it with its Works,
 * in the units the save-account strip and page print. Client-safe and pure: the strip re-reads
 * it from the clock on the client, so it takes `now` as an argument for tests.
 */
export type TimeLeft =
    | { kind: 'days'; days: number; hours: number }
    | { kind: 'hours'; hours: number }
    | { kind: 'soon' }
    | { kind: 'unknown' };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Rounded down, so the strip never promises more time than there is. Under an hour, or already
 * past (the cleanup runs once a day, so an account can outlive its expiry by hours), reads
 * "soon" rather than 0 or a negative number. A missing or unreadable expiry is `unknown`.
 */
export function timeLeft(expiresAt: string | null | undefined, now: number = Date.now()): TimeLeft {
    if (!expiresAt) return { kind: 'unknown' };
    const at = new Date(expiresAt).getTime();
    if (!Number.isFinite(at)) return { kind: 'unknown' };

    const ms = at - now;
    if (ms < HOUR_MS) return { kind: 'soon' };
    if (ms < DAY_MS) return { kind: 'hours', hours: Math.floor(ms / HOUR_MS) };
    return {
        kind: 'days',
        days: Math.floor(ms / DAY_MS),
        hours: Math.floor((ms % DAY_MS) / HOUR_MS),
    };
}
