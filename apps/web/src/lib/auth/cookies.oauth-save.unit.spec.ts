import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealData } from 'iron-session';

/**
 * EW-617 — the OAuth state mirror and the save-account intent cookies.
 *
 * A user's Work is served on a sibling subdomain (`{slug}.ever.works`), which can plant cookies
 * with `Domain=ever.works`. So in production both cookies are `__Host-` (Secure, `Path=/`, no
 * Domain: only this exact host can set them), and the save intent is SEALED with the session
 * cookie's key and names the account it is for. A plain, forged or foreign-sealed intent reads
 * as `invalid`, which the callback never acts on.
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

async function load(webUrl: string) {
    vi.resetModules();
    process.env.COOKIE_SECRET = SECRET;
    process.env.AUTH_SECRET = SECRET;
    process.env.WEB_URL = webUrl;
    return import('./cookies');
}

const INTENT = {
    state: 'state-1',
    terms: [
        { documentId: 'tos:ever-works', version: '1.0.0', sha256: 'a'.repeat(64), locale: 'en' },
    ],
    userId: 'anon-user-1',
};

describe('OAuth cookies — __Host- names in production, plain on http localhost', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('uses __Host- names with Secure, Path=/ and no Domain on HTTPS', async () => {
        const cookies = await load('https://app.ever.works');

        await cookies.setOAuthStateCookie('state-1');
        await cookies.setOAuthSaveAccountCookie(INTENT);

        expect(jar.sets.map((s) => s.name)).toEqual([
            '__Host-oauth_state',
            '__Host-oauth_save_account',
        ]);
        for (const { options } of jar.sets) {
            expect(options).toMatchObject({ secure: true, path: '/', httpOnly: true });
            expect(options).not.toHaveProperty('domain');
        }
        expect(await cookies.getOAuthStateCookie()).toBe('state-1');
    });

    it('ignores a plain-named cookie on HTTPS (what a sibling subdomain could plant)', async () => {
        const cookies = await load('https://app.ever.works');
        jar.values.set('oauth_state', { value: 'tossed' });

        expect(await cookies.getOAuthStateCookie()).toBeUndefined();
    });

    it('keeps the plain names on http localhost (dev, e2e)', async () => {
        const cookies = await load('http://localhost:3000');

        await cookies.setOAuthStateCookie('state-1');

        expect(jar.sets[0].name).toBe('oauth_state');
        expect(cookies.oauthSaveAccountCookieName()).toBe('oauth_save_account');
    });

    it('expires a __Host- cookie with the attributes it was set with', async () => {
        const cookies = await load('https://app.ever.works');
        await cookies.setOAuthStateCookie('state-1');

        await cookies.removeOAuthStateCookie();

        expect(jar.sets.at(-1)).toMatchObject({
            name: '__Host-oauth_state',
            value: '',
            options: expect.objectContaining({ maxAge: 0, secure: true, path: '/' }),
        });
        expect(await cookies.getOAuthStateCookie()).toBeUndefined();
    });
});

describe('the save intent is sealed and names its account', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('round-trips a sealed intent; the cookie value is not readable JSON', async () => {
        const cookies = await load('https://app.ever.works');

        await cookies.setOAuthSaveAccountCookie(INTENT);

        const raw = jar.values.get('__Host-oauth_save_account')!.value;
        expect(raw).not.toContain('anon-user-1');
        expect(() => JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))).toThrow();
        expect(await cookies.readOAuthSaveAccountCookie()).toEqual({
            status: 'valid',
            intent: INTENT,
        });
    });

    it('reads none when there is no save intent', async () => {
        const cookies = await load('https://app.ever.works');

        expect(await cookies.readOAuthSaveAccountCookie()).toEqual({ status: 'none' });
    });

    it('reads a forged, unsealed intent (plain base64 JSON) as invalid', async () => {
        const cookies = await load('https://app.ever.works');
        jar.values.set('__Host-oauth_save_account', {
            value: Buffer.from(JSON.stringify(INTENT), 'utf8').toString('base64url'),
        });

        expect(await cookies.readOAuthSaveAccountCookie()).toEqual({ status: 'invalid' });
    });

    it('reads an intent sealed with any other key as invalid', async () => {
        const cookies = await load('https://app.ever.works');
        jar.values.set('__Host-oauth_save_account', {
            value: await sealData(JSON.stringify(INTENT), { password: 'y'.repeat(48), ttl: 0 }),
        });

        expect(await cookies.readOAuthSaveAccountCookie()).toEqual({ status: 'invalid' });
    });

    it('reads a sealed intent that names no account as invalid', async () => {
        const cookies = await load('https://app.ever.works');
        jar.values.set('__Host-oauth_save_account', {
            value: await sealData(JSON.stringify({ state: 's', terms: [] }), {
                password: SECRET,
                ttl: 0,
            }),
        });

        expect(await cookies.readOAuthSaveAccountCookie()).toEqual({ status: 'invalid' });
    });
});
