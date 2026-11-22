/**
 * Cookie policy decided from the environment only, with no Next.js request API, so the boot hook
 * (`instrumentation.ts`) can report it and `./cookies.ts` can apply it. Never from a request header.
 */

// M-21: in preview / staging deploys that serve over HTTPS but happen to
// run with NODE_ENV !== 'production', the previous `secure: NODE_ENV ===
// 'production'` flag would let the cookie travel over HTTP. Anchor on the
// public URL scheme instead so any HTTPS deploy gets the secure flag.
// `WEB_URL` is already required at boot for the API; mirror that here.
// Re-exported from `./cookies.ts`, so the Ever ID flow cookies
// (`./ever-id-cookies.ts`) take their `secure` flag from exactly the same rule.
export function isPublicUrlHttps(env: NodeJS.ProcessEnv = process.env): boolean {
    const url = env.WEB_URL || env.NEXT_PUBLIC_WEB_URL;
    if (url) {
        try {
            return new URL(url).protocol === 'https:';
        } catch {
            // fall through
        }
    }
    return env.NODE_ENV === 'production';
}

/**
 * R-16: the default hard end of the legacy plain-name session cookie fallback, about 14 days after
 * the change shipped. After it the plain name is never read or written again on HTTPS, whatever
 * `AUTH_COOKIE_LEGACY_FALLBACK` says; `AUTH_COOKIE_LEGACY_FALLBACK_UNTIL` moves it.
 */
export const LEGACY_AUTH_COOKIE_DEFAULT_UNTIL = '2026-12-06T00:00:00.000Z';

const FLAG_OFF = new Set(['false', '0', 'off', 'no']);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function isCalendarDate(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1) return false;
    return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `AUTH_COOKIE_LEGACY_FALLBACK_UNTIL` as an instant, or null when it is not one of exactly two
 * shapes: a plain date `YYYY-MM-DD` (UTC midnight) or a full ISO 8601 date-time with `Z` or an
 * explicit `±HH:MM` offset (`2026-12-06T00:00:00Z`, `2026-12-06T01:00+01:00`). `Date.parse` alone
 * would take `0`, `1` or `2026`, roll `02-30` over to March, and read a time with no offset as the
 * pod's local time.
 */
export function parseLegacyFallbackUntil(raw: string): number | null {
    const date = ISO_DATE.exec(raw);
    if (date) {
        const [year, month, day] = date.slice(1, 4).map(Number);
        return isCalendarDate(year, month, day) ? Date.UTC(year, month - 1, day) : null;
    }
    const dateTime = ISO_DATE_TIME.exec(raw);
    if (!dateTime) return null;
    const [year, month, day, hour, minute] = dateTime.slice(1, 6).map(Number);
    const second = Number(dateTime[6] ?? '0');
    const offset = dateTime[7];
    if (!isCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
    if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
        return null;
    }
    const instant = Date.parse(raw);
    return Number.isNaN(instant) ? null : instant;
}
const FLAG_ON = new Set(['', 'true', '1', 'on', 'yes']);

export interface LegacyAuthCookieFallback {
    /** Whether the plain session cookie name is read as a fallback and written as a mirror now. */
    active: boolean;
    /** Why: on, switched off by the flag, past its end date, or not applicable (http). */
    state: 'on' | 'off-by-flag' | 'ended' | 'http';
    /** The effective end (ISO 8601); null on http. */
    until: string | null;
    /** Misconfigurations worth one log line (an unknown flag value, an unreadable date). */
    warnings: string[];
}

/**
 * The legacy plain-name session cookie fallback (R-16), as configured:
 *
 * - only on HTTPS (on http the plain name IS the live one);
 * - `AUTH_COOKIE_LEGACY_FALLBACK` = `false` / `0` / `off` / `no` ends it early; `true` / `1` /
 *   `on` / `yes` or unset leaves it on; any other value leaves it on and is reported (M3);
 * - it ends for good at `AUTH_COOKIE_LEGACY_FALLBACK_UNTIL` ({@link parseLegacyFallbackUntil}:
 *   `YYYY-MM-DD` as UTC midnight, or a date-time with `Z` / an offset), default
 *   {@link LEGACY_AUTH_COOKIE_DEFAULT_UNTIL}; any other value falls back to the default and is
 *   reported. A later date extends it, an earlier one ends it sooner.
 */
export function legacyAuthCookieFallback(
    env: NodeJS.ProcessEnv = process.env,
    now: number = Date.now(),
): LegacyAuthCookieFallback {
    const warnings: string[] = [];

    const rawUntil = env.AUTH_COOKIE_LEGACY_FALLBACK_UNTIL?.trim();
    let untilMs = Date.parse(LEGACY_AUTH_COOKIE_DEFAULT_UNTIL);
    if (rawUntil) {
        const parsed = parseLegacyFallbackUntil(rawUntil);
        if (parsed === null) {
            warnings.push(
                `AUTH_COOKIE_LEGACY_FALLBACK_UNTIL="${rawUntil}" is not an ISO 8601 date (YYYY-MM-DD) or date-time with Z or an offset; using ${LEGACY_AUTH_COOKIE_DEFAULT_UNTIL}`,
            );
        } else {
            untilMs = parsed;
        }
    }
    const until = new Date(untilMs).toISOString();

    if (!isPublicUrlHttps(env)) {
        return { active: false, state: 'http', until: null, warnings };
    }

    const flag = (env.AUTH_COOKIE_LEGACY_FALLBACK ?? '').trim().toLowerCase();
    if (FLAG_OFF.has(flag)) {
        return { active: false, state: 'off-by-flag', until, warnings };
    }
    if (!FLAG_ON.has(flag)) {
        warnings.push(
            `AUTH_COOKIE_LEGACY_FALLBACK="${env.AUTH_COOKIE_LEGACY_FALLBACK}" is not a known value (use true or false); treating it as on`,
        );
    }

    if (now >= untilMs) {
        return { active: false, state: 'ended', until, warnings };
    }
    return { active: true, state: 'on', until, warnings };
}

/** One boot log line describing the fallback, for the pod logs. */
export function describeLegacyAuthCookieFallback(policy: LegacyAuthCookieFallback): string {
    switch (policy.state) {
        case 'http':
            return '[auth-cookie] session cookie: plain name (http public URL); no legacy fallback';
        case 'off-by-flag':
            return '[auth-cookie] session cookie: __Host-everworks_auth_token; legacy fallback OFF (AUTH_COOKIE_LEGACY_FALLBACK)';
        case 'ended':
            return `[auth-cookie] session cookie: __Host-everworks_auth_token; legacy fallback ENDED at ${policy.until}`;
        case 'on':
            return `[auth-cookie] session cookie: __Host-everworks_auth_token; legacy fallback ON until ${policy.until} (AUTH_COOKIE_LEGACY_FALLBACK_UNTIL)`;
    }
}
