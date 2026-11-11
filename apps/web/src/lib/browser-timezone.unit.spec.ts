import { describe, expect, it } from 'vitest';
import {
    BROWSER_TIMEZONE_COOKIE,
    browserTimezoneCookie,
    parseBrowserTimezone,
    readBrowserTimezoneCookie,
} from './browser-timezone';

/**
 * The browser's timezone, carried to the server-rendered dashboard in a
 * cookie so Home's "today" is the browser's day when the profile has none.
 */
describe('browser timezone cookie', () => {
    it('round-trips a zone through the cookie string', () => {
        const cookie = browserTimezoneCookie('America/Los_Angeles', { secure: true });
        expect(cookie).toBe(
            `${BROWSER_TIMEZONE_COOKIE}=America%2FLos_Angeles; path=/; max-age=31536000; SameSite=Lax; Secure`,
        );
        const header = `sidebar-collapsed=0; ${cookie.split(';')[0]}; tasks-view=board`;
        expect(readBrowserTimezoneCookie(header)).toBe('America/Los_Angeles');
    });

    it('omits Secure on plain http (local development)', () => {
        expect(browserTimezoneCookie('UTC', { secure: false })).not.toContain('Secure');
    });

    it('reads nothing usable from a missing, unknown or garbled value', () => {
        expect(readBrowserTimezoneCookie(null)).toBeNull();
        expect(readBrowserTimezoneCookie('tasks-view=board')).toBeNull();
        expect(parseBrowserTimezone('Mars%2FOlympus_Mons')).toBeNull();
        expect(parseBrowserTimezone('%E0%A4%A')).toBeNull();
        expect(parseBrowserTimezone(undefined)).toBeNull();
    });

    it('accepts a real IANA zone, encoded or not', () => {
        expect(parseBrowserTimezone('Europe%2FKyiv')).toBe('Europe/Kyiv');
        expect(parseBrowserTimezone('Europe/Kyiv')).toBe('Europe/Kyiv');
    });
});
