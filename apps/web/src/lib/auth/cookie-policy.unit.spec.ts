import { describe, expect, it } from 'vitest';
import {
    LEGACY_AUTH_COOKIE_DEFAULT_UNTIL,
    describeLegacyAuthCookieFallback,
    isPublicUrlHttps,
    legacyAuthCookieFallback,
    parseLegacyFallbackUntil,
} from './cookie-policy';

/**
 * R-16 — the legacy plain-name session cookie fallback has a hard end in code. It is decided from
 * the environment and the clock only, so it is tested here as a pure function.
 */

const HTTPS = { WEB_URL: 'https://app.ever.works' } as unknown as NodeJS.ProcessEnv;
const BEFORE_DEFAULT_END = Date.parse('2026-11-22T12:00:00.000Z');
const AFTER_DEFAULT_END = Date.parse('2026-12-06T00:00:00.000Z');

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...HTTPS, ...extra } as NodeJS.ProcessEnv;
}

describe('legacyAuthCookieFallback — the end date', () => {
    it('is on until the default end, 2026-12-06T00:00:00Z', () => {
        const policy = legacyAuthCookieFallback(env(), BEFORE_DEFAULT_END);

        expect(LEGACY_AUTH_COOKIE_DEFAULT_UNTIL).toBe('2026-12-06T00:00:00.000Z');
        expect(policy).toEqual({
            active: true,
            state: 'on',
            until: LEGACY_AUTH_COOKIE_DEFAULT_UNTIL,
            warnings: [],
        });
    });

    it('ends at the default end, whatever the flag says', () => {
        for (const flag of [undefined, 'true', 'on', '1', 'yes']) {
            const policy = legacyAuthCookieFallback(
                env(flag === undefined ? {} : { AUTH_COOKIE_LEGACY_FALLBACK: flag }),
                AFTER_DEFAULT_END,
            );
            expect(policy.active).toBe(false);
            expect(policy.state).toBe('ended');
            expect(policy.until).toBe(LEGACY_AUTH_COOKIE_DEFAULT_UNTIL);
        }
    });

    it('a later AUTH_COOKIE_LEGACY_FALLBACK_UNTIL extends it', () => {
        const policy = legacyAuthCookieFallback(
            env({ AUTH_COOKIE_LEGACY_FALLBACK_UNTIL: '2026-12-20T00:00:00Z' }),
            AFTER_DEFAULT_END,
        );

        expect(policy.active).toBe(true);
        expect(policy.until).toBe('2026-12-20T00:00:00.000Z');
    });

    it('an earlier AUTH_COOKIE_LEGACY_FALLBACK_UNTIL ends it sooner', () => {
        const policy = legacyAuthCookieFallback(
            env({ AUTH_COOKIE_LEGACY_FALLBACK_UNTIL: '2026-11-01' }),
            BEFORE_DEFAULT_END,
        );

        expect(policy.active).toBe(false);
        expect(policy.state).toBe('ended');
        expect(policy.until).toBe('2026-11-01T00:00:00.000Z');
    });

    it('an unreadable date keeps the default end and is reported', () => {
        const policy = legacyAuthCookieFallback(
            env({ AUTH_COOKIE_LEGACY_FALLBACK_UNTIL: 'next tuesday' }),
            BEFORE_DEFAULT_END,
        );

        expect(policy.active).toBe(true);
        expect(policy.until).toBe(LEGACY_AUTH_COOKIE_DEFAULT_UNTIL);
        expect(policy.warnings).toEqual([
            expect.stringContaining(
                'AUTH_COOKIE_LEGACY_FALLBACK_UNTIL="next tuesday" is not an ISO 8601 date',
            ),
        ]);
    });
});

// Minor 2 (R60): only an unambiguous instant moves the end. Date.parse alone takes "0", "1" or
// "2026", rolls 02-30 over to March, and reads a time without an offset as the pod's local time.
describe('parseLegacyFallbackUntil — strict ISO 8601', () => {
    it.each([
        ['2026-12-20', '2026-12-20T00:00:00.000Z'],
        ['2026-12-20T00:00:00Z', '2026-12-20T00:00:00.000Z'],
        ['2026-12-20T10:30Z', '2026-12-20T10:30:00.000Z'],
        ['2026-12-20T10:30:15.250Z', '2026-12-20T10:30:15.250Z'],
        ['2026-12-20T01:00:00+01:00', '2026-12-20T00:00:00.000Z'],
        ['2026-12-19T19:00:00-05:00', '2026-12-20T00:00:00.000Z'],
        ['2028-02-29', '2028-02-29T00:00:00.000Z'],
    ])('reads %j as %s', (raw, iso) => {
        expect(new Date(parseLegacyFallbackUntil(raw)!).toISOString()).toBe(iso);
    });

    it.each([
        '0',
        '1',
        '2026',
        '2026-12',
        '20261220',
        '2026-12-20T00:00:00',
        '2026-12-20T00:00',
        '2026-12-20 00:00:00Z',
        '2026-12-20t00:00:00z',
        '2026-12-20T00:00:00+0100',
        '2026-02-30',
        '2027-02-29',
        '2026-13-01',
        '2026-12-20T24:00:00Z',
        '2026-12-20T00:60:00Z',
        '2026-12-20T00:00:00+25:00',
        'Dec 20 2026',
        'next tuesday',
    ])('refuses %j', (raw) => {
        expect(parseLegacyFallbackUntil(raw)).toBeNull();
    });

    it.each(['0', '2026', '2026-12-20T00:00:00'])(
        'an ambiguous AUTH_COOKIE_LEGACY_FALLBACK_UNTIL=%j keeps the default end and warns',
        (raw) => {
            const policy = legacyAuthCookieFallback(
                env({ AUTH_COOKIE_LEGACY_FALLBACK_UNTIL: raw }),
                BEFORE_DEFAULT_END,
            );

            expect(policy.until).toBe(LEGACY_AUTH_COOKIE_DEFAULT_UNTIL);
            expect(policy.active).toBe(true);
            expect(policy.warnings).toHaveLength(1);
            expect(policy.warnings[0]).toContain(`AUTH_COOKIE_LEGACY_FALLBACK_UNTIL="${raw}"`);
        },
    );
});

describe('legacyAuthCookieFallback — the switch', () => {
    it.each(['false', '0', 'off', 'no', ' FALSE '])(
        'AUTH_COOKIE_LEGACY_FALLBACK=%j ends it early',
        (flag) => {
            const policy = legacyAuthCookieFallback(
                env({ AUTH_COOKIE_LEGACY_FALLBACK: flag }),
                BEFORE_DEFAULT_END,
            );

            expect(policy).toMatchObject({ active: false, state: 'off-by-flag', warnings: [] });
        },
    );

    it.each(['', 'true', '1', 'on', 'yes', 'TRUE'])(
        'AUTH_COOKIE_LEGACY_FALLBACK=%j leaves it on, silently',
        (flag) => {
            const policy = legacyAuthCookieFallback(
                env({ AUTH_COOKIE_LEGACY_FALLBACK: flag }),
                BEFORE_DEFAULT_END,
            );

            expect(policy).toMatchObject({ active: true, state: 'on', warnings: [] });
        },
    );

    // M3: a typo must not pass unnoticed. It keeps the safe-for-users default (on, until the end).
    it('an unknown value ("flase") leaves it on and is reported', () => {
        const policy = legacyAuthCookieFallback(
            env({ AUTH_COOKIE_LEGACY_FALLBACK: 'flase' }),
            BEFORE_DEFAULT_END,
        );

        expect(policy.active).toBe(true);
        expect(policy.warnings).toEqual([
            'AUTH_COOKIE_LEGACY_FALLBACK="flase" is not a known value (use true or false); treating it as on',
        ]);
    });

    it('an unknown value is still reported after the end date', () => {
        const policy = legacyAuthCookieFallback(
            env({ AUTH_COOKIE_LEGACY_FALLBACK: 'flase' }),
            AFTER_DEFAULT_END,
        );

        expect(policy.state).toBe('ended');
        expect(policy.warnings).toHaveLength(1);
    });
});

describe('legacyAuthCookieFallback — http', () => {
    it('never applies on http, where the plain name is the live one', () => {
        const policy = legacyAuthCookieFallback(
            { WEB_URL: 'http://localhost:3000' } as unknown as NodeJS.ProcessEnv,
            BEFORE_DEFAULT_END,
        );

        expect(policy).toEqual({ active: false, state: 'http', until: null, warnings: [] });
    });

    it('takes the scheme from the configured public URL, never a request', () => {
        expect(isPublicUrlHttps({ WEB_URL: 'https://app.ever.works' } as never)).toBe(true);
        expect(isPublicUrlHttps({ NEXT_PUBLIC_WEB_URL: 'http://localhost:3000' } as never)).toBe(
            false,
        );
        expect(isPublicUrlHttps({ NODE_ENV: 'production' } as never)).toBe(true);
        expect(isPublicUrlHttps({ NODE_ENV: 'development' } as never)).toBe(false);
    });
});

describe('describeLegacyAuthCookieFallback — the boot log line', () => {
    it('names the effective end while it is on', () => {
        expect(
            describeLegacyAuthCookieFallback(legacyAuthCookieFallback(env(), BEFORE_DEFAULT_END)),
        ).toBe(
            '[auth-cookie] session cookie: __Host-everworks_auth_token; legacy fallback ON until 2026-12-06T00:00:00.000Z (AUTH_COOKIE_LEGACY_FALLBACK_UNTIL)',
        );
    });

    it('says when it ended, when the flag turned it off, and when it does not apply', () => {
        expect(
            describeLegacyAuthCookieFallback(legacyAuthCookieFallback(env(), AFTER_DEFAULT_END)),
        ).toContain('legacy fallback ENDED at 2026-12-06T00:00:00.000Z');
        expect(
            describeLegacyAuthCookieFallback(
                legacyAuthCookieFallback(
                    env({ AUTH_COOKIE_LEGACY_FALLBACK: 'false' }),
                    BEFORE_DEFAULT_END,
                ),
            ),
        ).toContain('legacy fallback OFF (AUTH_COOKIE_LEGACY_FALLBACK)');
        expect(
            describeLegacyAuthCookieFallback(
                legacyAuthCookieFallback(
                    { WEB_URL: 'http://localhost:3000' } as never,
                    BEFORE_DEFAULT_END,
                ),
            ),
        ).toContain('plain name (http public URL)');
    });
});
