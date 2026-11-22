import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R-16 — the web session cookie is host-only on HTTPS.
 *
 * User Works and apps live on sibling hosts (`<slug>.ever.works`), which can plant a cookie with
 * `Domain=ever.works`. A planted plain-name `everworks_auth_token` would sign a visitor in to the
 * attacker's account (login CSRF). On HTTPS the live name is `__Host-everworks_auth_token`
 * (Secure, `Path=/`, no Domain: only this exact host can set it). A legacy plain-name cookie from
 * before the rename is honoured, once, while the fallback lasts (`AUTH_COOKIE_LEGACY_FALLBACK`, on
 * by default, until `AUTH_COOKIE_LEGACY_FALLBACK_UNTIL`, default 2026-12-06), and moved to the new
 * name by the proxy. A plain name that appears more than once is never trusted. Plain names stay
 * on http (dev, e2e). The clock is pinned before the default end, so the suite does not change
 * meaning after that date.
 */

const jar = vi.hoisted(() => {
    type Cookie = { value: string; options?: Record<string, unknown> };
    const values = new Map<string, Cookie>();
    const sets: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
    /** The raw `Cookie` header when a test sets one (a duplicate name); else built from the jar. */
    const raw = { header: undefined as string | undefined };
    return {
        values,
        sets,
        raw,
        reset() {
            values.clear();
            sets.length = 0;
            raw.header = undefined;
        },
        cookieHeader() {
            if (raw.header !== undefined) return raw.header;
            return [...values].map(([name, cookie]) => `${name}=${cookie.value}`).join('; ');
        },
        store: {
            get: (name: string) => {
                const cookie = values.get(name);
                return cookie ? { name, value: cookie.value } : undefined;
            },
            set: (name: string, value: string, options?: Record<string, unknown>) => {
                sets.push({ name, value, options });
                if (options?.maxAge === 0) values.delete(name);
                else values.set(name, { value, options });
            },
            delete: (name: string) => {
                values.delete(name);
            },
        },
    };
});

vi.mock('next/headers', () => ({
    cookies: async () => jar.store,
    headers: async () => ({
        get: (name: string) =>
            name.toLowerCase() === 'cookie' ? jar.cookieHeader() || null : null,
    }),
}));

const SECRET = 'x'.repeat(48);
const ORIGINAL_ENV = { ...process.env };
/** Before the default end of the fallback (2026-12-06T00:00:00Z). */
const DURING_FALLBACK = new Date('2026-11-22T12:00:00.000Z');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DURING_FALLBACK);
});
afterEach(() => {
    vi.useRealTimers();
});

async function load(webUrl: string, fallback?: string, until?: string) {
    vi.resetModules();
    process.env.COOKIE_SECRET = SECRET;
    process.env.AUTH_SECRET = SECRET;
    process.env.WEB_URL = webUrl;
    if (fallback === undefined) delete process.env.AUTH_COOKIE_LEGACY_FALLBACK;
    else process.env.AUTH_COOKIE_LEGACY_FALLBACK = fallback;
    if (until === undefined) delete process.env.AUTH_COOKIE_LEGACY_FALLBACK_UNTIL;
    else process.env.AUTH_COOKIE_LEGACY_FALLBACK_UNTIL = until;
    return import('./cookies');
}

/**
 * A minimal request / response pair, as the proxy hands them over. The raw `Cookie` header is
 * built from the cookies unless a test passes one (to send a name twice).
 */
function proxyPair(requestCookies: Record<string, string>, rawCookieHeader?: string) {
    const written: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
    const header =
        rawCookieHeader ??
        Object.entries(requestCookies)
            .map(([name, value]) => `${name}=${value}`)
            .join('; ');
    return {
        request: {
            cookies: {
                get: (name: string) =>
                    name in requestCookies ? { value: requestCookies[name] } : undefined,
            },
            headers: {
                get: (name: string) => (name.toLowerCase() === 'cookie' ? header || null : null),
            },
        },
        response: {
            cookies: {
                set: (name: string, value: string, options?: Record<string, unknown>) => {
                    written.push({ name, value, options });
                },
            },
        },
        written,
    };
}

describe('session cookie names and attributes', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('is __Host-everworks_auth_token on HTTPS: Secure, Path=/, no Domain, HttpOnly', async () => {
        const cookies = await load('https://app.ever.works');

        await cookies.setAuthAccessCookie('token-1');

        expect(jar.sets[0].name).toBe('__Host-everworks_auth_token');
        expect(jar.sets[0].options).toMatchObject({ secure: true, path: '/', httpOnly: true });
        expect(jar.sets[0].options).not.toHaveProperty('domain');
        expect(await cookies.getAuthAccessCookie()).toBe('token-1');
    });

    it('keeps the plain name on http (dev, e2e): nothing changes there', async () => {
        const cookies = await load('http://localhost:3000');

        await cookies.setAuthAccessCookie('token-1');

        expect(jar.sets.map((s) => s.name)).toEqual(['everworks_auth_token']);
        expect(cookies.authCookieName()).toBe('everworks_auth_token');
        expect(cookies.legacyAuthCookieFallbackEnabled()).toBe(false);
        expect(await cookies.getAuthAccessCookie()).toBe('token-1');
    });

    // Rolling deploy: for a few minutes old pods (plain name only) and new pods serve side by side.
    it('mirrors the session under the plain name while the fallback is on, so an old pod still sees it', async () => {
        const cookies = await load('https://app.ever.works');

        await cookies.setAuthAccessCookie('token-1');

        expect(jar.sets.map((s) => s.name)).toEqual([
            '__Host-everworks_auth_token',
            'everworks_auth_token',
        ]);
        // What a pod on the previous release reads: the plain name, the same sealed session.
        const { decrypt } = await import('./crypto');
        expect(await decrypt(jar.values.get('everworks_auth_token')!.value)).toBe('token-1');
        expect(jar.values.get('everworks_auth_token')!.value).toBe(
            jar.values.get('__Host-everworks_auth_token')!.value,
        );
    });

    it('with the fallback off, writes only __Host- and expires a left-over plain cookie', async () => {
        const cookies = await load('https://app.ever.works', 'false');
        jar.values.set('everworks_auth_token', { value: 'old' });

        await cookies.setAuthAccessCookie('token-1');

        expect(jar.values.has('everworks_auth_token')).toBe(false);
        expect(jar.sets.at(-1)).toMatchObject({
            name: 'everworks_auth_token',
            value: '',
            options: expect.objectContaining({ maxAge: 0, path: '/', secure: true }),
        });
    });

    it('after the end date, writes only __Host- and expires a left-over plain cookie (no mirror)', async () => {
        vi.setSystemTime(new Date('2026-12-06T00:00:00.000Z'));
        const cookies = await load('https://app.ever.works');
        jar.values.set('everworks_auth_token', { value: 'old' });

        expect(cookies.legacyAuthCookieFallbackEnabled()).toBe(false);
        await cookies.setAuthAccessCookie('token-1');

        expect(jar.sets.map((s) => [s.name, s.value === '' ? 'expired' : 'set'])).toEqual([
            ['__Host-everworks_auth_token', 'set'],
            ['everworks_auth_token', 'expired'],
        ]);
        expect(jar.values.has('everworks_auth_token')).toBe(false);
    });

    it('a later AUTH_COOKIE_LEGACY_FALLBACK_UNTIL keeps the mirror past the default end', async () => {
        vi.setSystemTime(new Date('2026-12-10T00:00:00.000Z'));
        const cookies = await load('https://app.ever.works', undefined, '2026-12-20T00:00:00Z');

        await cookies.setAuthAccessCookie('token-1');

        expect(jar.sets.map((s) => s.name)).toEqual([
            '__Host-everworks_auth_token',
            'everworks_auth_token',
        ]);
    });
});

describe('reading the session: a __Host- cookie wins, a legacy one only as a fallback', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('ignores a planted plain-name cookie when a __Host- one exists', async () => {
        const cookies = await load('https://app.ever.works');
        await cookies.setAuthAccessCookie('mine');
        const { encrypt } = await import('./crypto');
        jar.values.set('everworks_auth_token', { value: await encrypt('attacker') });

        expect(await cookies.getAuthAccessCookie()).toBe('mine');
    });

    it('reads a legacy plain-name cookie while the fallback is on (the default)', async () => {
        const cookies = await load('https://app.ever.works');
        const { encrypt } = await import('./crypto');
        jar.values.set('everworks_auth_token', { value: await encrypt('legacy') });

        expect(cookies.legacyAuthCookieFallbackEnabled()).toBe(true);
        expect(await cookies.getAuthAccessCookie()).toBe('legacy');
    });

    it.each(['false', '0', 'off', 'no', 'FALSE'])(
        'never reads the legacy name with AUTH_COOKIE_LEGACY_FALLBACK=%s',
        async (flag) => {
            const cookies = await load('https://app.ever.works', flag);
            const { encrypt } = await import('./crypto');
            jar.values.set('everworks_auth_token', { value: await encrypt('legacy') });

            expect(cookies.legacyAuthCookieFallbackEnabled()).toBe(false);
            expect(await cookies.getAuthAccessCookie()).toBeUndefined();
        },
    );

    it('never reads the legacy name after the end date', async () => {
        vi.setSystemTime(new Date('2026-12-06T00:00:01.000Z'));
        const cookies = await load('https://app.ever.works');
        const { encrypt } = await import('./crypto');
        jar.values.set('everworks_auth_token', { value: await encrypt('legacy') });

        expect(await cookies.getAuthAccessCookie()).toBeUndefined();
    });

    // I2b: a tossed `Domain=ever.works` cookie next to the visitor's own host-only one arrives under
    // the same name, and the cookie API keeps only one of them; neither is trusted.
    it('refuses the legacy fallback when the plain name appears more than once', async () => {
        const cookies = await load('https://app.ever.works');
        const { encrypt } = await import('./crypto');
        const mine = await encrypt('mine');
        const tossed = await encrypt('attacker');
        jar.values.set('everworks_auth_token', { value: tossed });
        jar.raw.header = `everworks_auth_token=${mine}; everworks_auth_token=${tossed}`;

        expect(await cookies.getAuthAccessCookie()).toBeUndefined();
    });

    it('a duplicate plain name does not matter to a visitor with a __Host- cookie', async () => {
        const cookies = await load('https://app.ever.works');
        await cookies.setAuthAccessCookie('mine');
        jar.raw.header =
            '__Host-everworks_auth_token=x; everworks_auth_token=a; everworks_auth_token=b';

        expect(await cookies.getAuthAccessCookie()).toBe('mine');
    });
});

describe('countCookieName', () => {
    it('counts exact names in a raw Cookie header', async () => {
        const { countCookieName } = await load('https://app.ever.works');

        expect(countCookieName(null, 'everworks_auth_token')).toBe(0);
        expect(countCookieName('everworks_auth_token=a', 'everworks_auth_token')).toBe(1);
        expect(
            countCookieName(
                'everworks_auth_token=a;everworks_auth_token=b; __Host-everworks_auth_token=c',
                'everworks_auth_token',
            ),
        ).toBe(2);
        // A prefixed or longer name is not the same cookie.
        expect(
            countCookieName(
                '__Host-everworks_auth_token=c; everworks_auth_token_x=d',
                'everworks_auth_token',
            ),
        ).toBe(0);
    });
});

describe('reconcileLegacyAuthCookie (proxy, once)', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('copies the same sealed value to __Host- and KEEPS the plain one (old pods still read it)', async () => {
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair({ everworks_auth_token: 'sealed-legacy' });

        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('migrated');

        expect(pair.written).toEqual([
            {
                name: '__Host-everworks_auth_token',
                value: 'sealed-legacy',
                options: expect.objectContaining({ secure: true, path: '/', httpOnly: true }),
            },
        ]);
        expect(pair.written[0].options).not.toHaveProperty('domain');
    });

    it('does nothing once a __Host- cookie exists, even next to a plain one', async () => {
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair({
            '__Host-everworks_auth_token': 'current',
            everworks_auth_token: 'planted',
        });

        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('none');
        expect(pair.written).toEqual([]);
    });

    it('does nothing on http, or with no legacy cookie', async () => {
        let cookies = await load('http://localhost:3000');
        let pair = proxyPair({ everworks_auth_token: 'plain' });
        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('none');

        cookies = await load('https://app.ever.works');
        pair = proxyPair({});
        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('none');
        expect(pair.written).toEqual([]);
    });

    it('refuses to migrate when the plain name appears more than once (I2b)', async () => {
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair(
            { everworks_auth_token: 'tossed' },
            'everworks_auth_token=mine; everworks_auth_token=tossed',
        );

        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('none');
        expect(pair.written).toEqual([]);
    });

    it.each([
        ['the flag is off', 'false', undefined, '2026-11-22T12:00:00.000Z'],
        ['the end date passed', undefined, undefined, '2026-12-06T00:00:00.000Z'],
        [
            'an earlier end date passed',
            undefined,
            '2026-11-01T00:00:00Z',
            '2026-11-22T12:00:00.000Z',
        ],
    ])(
        'expires a left-over plain cookie once %s, without writing __Host-',
        async (_why, flag, until, now) => {
            vi.setSystemTime(new Date(now));
            const cookies = await load('https://app.ever.works', flag, until);
            const pair = proxyPair({
                '__Host-everworks_auth_token': 'current',
                everworks_auth_token: 'left-over',
            });

            expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('expired');
            expect(pair.written).toEqual([
                {
                    name: 'everworks_auth_token',
                    value: '',
                    options: expect.objectContaining({ maxAge: 0, path: '/', secure: true }),
                },
            ]);
        },
    );

    // Minor 1 (R60): a migrated plain cookie keeps the expiry of the original sign-in. When the
    // browser drops it, the next page visit puts the mirror back, so a rollback still finds it.
    it('puts the plain mirror back next to a __Host- cookie that has none, while the fallback is on', async () => {
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair({ '__Host-everworks_auth_token': 'current' });

        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('mirrored');
        expect(pair.written).toEqual([
            {
                name: 'everworks_auth_token',
                value: 'current',
                options: expect.objectContaining({
                    secure: true,
                    path: '/',
                    httpOnly: true,
                    maxAge: 60 * 60 * 24 * 7,
                }),
            },
        ]);
        expect(pair.written[0].options).not.toHaveProperty('domain');
    });

    it('does not re-mirror over a plain cookie with another value (newer from an old pod, or planted)', async () => {
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair({
            '__Host-everworks_auth_token': 'current',
            everworks_auth_token: 'other',
        });

        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('none');
        expect(pair.written).toEqual([]);
    });

    it.each([
        ['the flag is off', 'false', '2026-11-22T12:00:00.000Z'],
        ['the end date passed', undefined, '2026-12-06T00:00:00.000Z'],
    ])('does not re-mirror once %s', async (_why, flag, now) => {
        vi.setSystemTime(new Date(now));
        const cookies = await load('https://app.ever.works', flag);
        const pair = proxyPair({ '__Host-everworks_auth_token': 'current' });

        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('none');
        expect(pair.written).toEqual([]);
    });

    it('after the end, does nothing without a plain cookie', async () => {
        vi.setSystemTime(new Date('2026-12-07T00:00:00.000Z'));
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair({ '__Host-everworks_auth_token': 'current' });

        expect(cookies.reconcileLegacyAuthCookie(pair.request, pair.response)).toBe('none');
        expect(pair.written).toEqual([]);
    });
});

describe('signing out clears both names', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('logout expires the __Host- cookie and a legacy plain one, with matching attributes', async () => {
        const cookies = await load('https://app.ever.works');
        await cookies.setAuthAccessCookie('mine');
        jar.values.set('everworks_auth_token', { value: 'legacy' });

        await cookies.removeAuthAccessCookies();

        expect(jar.values.has('__Host-everworks_auth_token')).toBe(false);
        expect(jar.values.has('everworks_auth_token')).toBe(false);
        for (const set of jar.sets.filter((s) => s.value === '')) {
            expect(set.options).toMatchObject({ maxAge: 0, secure: true, path: '/' });
        }
    });

    it('logout on http expires only the plain name', async () => {
        const cookies = await load('http://localhost:3000');
        await cookies.setAuthAccessCookie('mine');
        jar.sets.length = 0;

        await cookies.removeAuthAccessCookies();

        expect(jar.sets.map((s) => s.name)).toEqual(['everworks_auth_token']);
    });

    it('the proxy gate expires both names on a response', async () => {
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair({});

        cookies.expireAuthCookies(pair.response);

        expect(pair.written.map((w) => w.name)).toEqual([
            '__Host-everworks_auth_token',
            'everworks_auth_token',
        ]);
        for (const w of pair.written) {
            expect(w.options).toMatchObject({ maxAge: 0, secure: true, path: '/' });
        }
    });
});

describe('other auth cookies are host-only on HTTPS too', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('names the post-sign-in redirect and the GitHub App binding with __Host-', async () => {
        const cookies = await load('https://app.ever.works');

        await cookies.setRedirectCookie('/works/1');

        expect(jar.sets[0].name).toBe('__Host-redirect_url');
        expect(await cookies.getRedirectCookie()).toBe('/works/1');
        expect(cookies.githubAppSetupCookieName()).toBe('__Host-ew_github_app_setup');
        expect(cookies.githubAppSetupCookieOptions(600)).toMatchObject({ path: '/', secure: true });
    });

    it('keeps their plain names and the GitHub App path on http', async () => {
        const cookies = await load('http://localhost:3000');

        expect(cookies.redirectCookieName()).toBe('redirect_url');
        expect(cookies.githubAppSetupCookieName()).toBe('ew_github_app_setup');
        expect(cookies.githubAppSetupCookieOptions(600)).toMatchObject({
            path: '/api/github-app',
            secure: false,
        });
    });
});
