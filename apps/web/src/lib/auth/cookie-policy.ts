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
 * - it ends for good at `AUTH_COOKIE_LEGACY_FALLBACK_UNTIL` (an ISO 8601 date), default
 *   {@link LEGACY_AUTH_COOKIE_DEFAULT_UNTIL}; an unreadable date falls back to the default and is
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
        const parsed = Date.parse(rawUntil);
        if (Number.isNaN(parsed)) {
            warnings.push(
                `AUTH_COOKIE_LEGACY_FALLBACK_UNTIL="${rawUntil}" is not a date; using ${LEGACY_AUTH_COOKIE_DEFAULT_UNTIL}`,
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
