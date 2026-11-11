/**
 * The browser's own IANA timezone, carried to server-rendered pages in a
 * cookie.
 *
 * Home's "Today" is a local calendar day. The API resolves which day in this
 * order (`packages/agent/src/home/home-window.ts`): an explicit `?tz=`
 * override, then the PROFILE timezone, then `?browserTz=` (this value), then
 * UTC. So an account that set a profile timezone keeps it on every device,
 * and an account that did not gets its browser's day instead of UTC — which,
 * late in the UTC day, used to make every schedule fall outside "today".
 *
 * A cookie (not localStorage) because the dashboard is server-rendered: the
 * server reads it before the first paint. Same cookie shape as the dashboard's
 * `tasks-view` / `sidebar-collapsed` preferences. The value is a hint, never
 * an account setting: nothing here writes the profile.
 *
 * Client-safe: no server imports.
 */

import { isHomeTimezone } from '@ever-works/contracts';

export const BROWSER_TIMEZONE_COOKIE = 'ew-browser-tz';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** A cookie value as a timezone the runtime can compute a day in, or `null`. */
export function parseBrowserTimezone(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let decoded = value.trim();
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        return null;
    }
    return isHomeTimezone(decoded) ? decoded : null;
}

/** The zone this browser reports, or `null` when it reports none usable. */
export function detectBrowserTimezone(): string | null {
    try {
        return parseBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
        return null;
    }
}

/** Read the cookie out of a `document.cookie` string. */
export function readBrowserTimezoneCookie(cookieHeader: string | null | undefined): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === BROWSER_TIMEZONE_COOKIE) return parseBrowserTimezone(rest.join('='));
    }
    return null;
}

/** The `document.cookie` assignment that remembers the zone for a year. */
export function browserTimezoneCookie(timezone: string, opts: { secure: boolean }): string {
    const secure = opts.secure ? '; Secure' : '';
    return `${BROWSER_TIMEZONE_COOKIE}=${encodeURIComponent(timezone)}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure}`;
}
