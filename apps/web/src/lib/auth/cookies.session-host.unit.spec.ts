import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R-16 — the web session cookie is host-only on HTTPS.
 *
 * User Works and apps live on sibling hosts (`<slug>.ever.works`), which can plant a cookie with
 * `Domain=ever.works`. A planted plain-name `everworks_auth_token` would sign a visitor in to the
 * attacker's account (login CSRF). On HTTPS the live name is `__Host-everworks_auth_token`
 * (Secure, `Path=/`, no Domain: only this exact host can set it). A legacy plain-name cookie from
 * before the rename is honoured, once, while `AUTH_COOKIE_LEGACY_FALLBACK` is on (the default),
 * and moved to the new name by the proxy. Plain names stay on http (dev, e2e).
 */

const jar = vi.hoisted(() => {
    type Cookie = { value: string; options?: Record<string, unknown> };
    const values = new Map<string, Cookie>();
    const sets: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
    return {
        values,
        sets,
        reset() {
            values.clear();
            sets.length = 0;
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

vi.mock('next/headers', () => ({ cookies: async () => jar.store }));

const SECRET = 'x'.repeat(48);
const ORIGINAL_ENV = { ...process.env };

async function load(webUrl: string, fallback?: string) {
    vi.resetModules();
    process.env.COOKIE_SECRET = SECRET;
    process.env.AUTH_SECRET = SECRET;
    process.env.WEB_URL = webUrl;
    if (fallback === undefined) delete process.env.AUTH_COOKIE_LEGACY_FALLBACK;
    else process.env.AUTH_COOKIE_LEGACY_FALLBACK = fallback;
    return import('./cookies');
}

/** A minimal request / response pair, as the proxy hands them over. */
function proxyPair(requestCookies: Record<string, string>) {
    const written: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
    return {
        request: {
            cookies: {
                get: (name: string) =>
                    name in requestCookies ? { value: requestCookies[name] } : undefined,
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
});

describe('migrateLegacyAuthCookie (proxy, once)', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('copies the same sealed value to __Host- and KEEPS the plain one (old pods still read it)', async () => {
        const cookies = await load('https://app.ever.works');
        const pair = proxyPair({ everworks_auth_token: 'sealed-legacy' });

        expect(cookies.migrateLegacyAuthCookie(pair.request, pair.response)).toBe(true);

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

        expect(cookies.migrateLegacyAuthCookie(pair.request, pair.response)).toBe(false);
        expect(pair.written).toEqual([]);
    });

    it('does nothing with the fallback off, on http, or with no legacy cookie', async () => {
        let cookies = await load('https://app.ever.works', 'false');
        let pair = proxyPair({ everworks_auth_token: 'legacy' });
        expect(cookies.migrateLegacyAuthCookie(pair.request, pair.response)).toBe(false);

        cookies = await load('http://localhost:3000');
        pair = proxyPair({ everworks_auth_token: 'plain' });
        expect(cookies.migrateLegacyAuthCookie(pair.request, pair.response)).toBe(false);

        cookies = await load('https://app.ever.works');
        pair = proxyPair({});
        expect(cookies.migrateLegacyAuthCookie(pair.request, pair.response)).toBe(false);
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
