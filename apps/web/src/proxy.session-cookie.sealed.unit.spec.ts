import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from './lib/workspace-scope';

/**
 * R-16 — the whole chain with real sealed (`Fe26.2*`) session cookies: the real proxy, the real
 * auth gate (`getAuthFromRequest` → `getAuthAccessCookie` → iron-session unseal) and the real
 * migration. Only `next/headers` is bridged to the request under test (in Next the proxy adapter
 * gives `cookies()` / `headers()` that request), and next-intl is stubbed. HTTPS public URL, and a
 * clock before the fallback's default end (2026-12-06T00:00:00Z) unless a test moves it.
 */

const { current, intlMock } = vi.hoisted(() => ({
    current: { req: null as null | { cookies: unknown; headers: Headers } },
    intlMock: vi.fn(async (_request: unknown) => NextResponse.next()),
}));

vi.mock('next-intl/middleware', () => ({ default: () => intlMock }));
vi.mock('next/headers', () => ({
    cookies: async () => {
        if (!current.req) throw new Error('no request in scope');
        return current.req.cookies;
    },
    headers: async () => {
        if (!current.req) throw new Error('no request in scope');
        return current.req.headers;
    },
}));

const SECRET = 'x'.repeat(48);

async function load(env: Record<string, string> = {}) {
    vi.resetModules();
    vi.stubEnv('WEB_URL', 'https://app.example');
    vi.stubEnv('COOKIE_SECRET', SECRET);
    vi.stubEnv('AUTH_SECRET', SECRET);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const proxy = (await import('./proxy')).default;
    const { encrypt } = await import('./lib/auth/crypto');
    return { proxy, encrypt };
}

/** An unsigned JWT-shaped session token (the gate decodes, never verifies, it), valid for a day. */
function sessionToken(sub: string): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    return [part({ alg: 'HS256', typ: 'JWT' }), part({ sub, email: null, exp }), 'sig'].join('.');
}

async function run(proxy: (req: NextRequest) => Promise<Response>, path: string, cookie: string) {
    const req = new NextRequest(`https://app.example${path}`, {
        headers: { [BROWSER_WORKSPACE_SCOPE_HEADER]: 'personal', cookie },
    });
    current.req = req;
    try {
        return await proxy(req);
    } finally {
        current.req = null;
    }
}

function sessionCookieLines(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const lines = headers.getSetCookie ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
    return lines.filter((line) => line.includes('everworks_auth_token='));
}

function redirectPath(response: Response): string | null {
    const location = response.headers.get('location');
    return location ? new URL(location).pathname : null;
}

describe('proxy with real sealed session cookies (R-16)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('lets a visitor on a legacy sealed cookie in and copies it to __Host-, keeping the plain one', async () => {
        const { proxy, encrypt } = await load();
        const sealed = await encrypt(sessionToken('user-1'));
        expect(sealed.startsWith('Fe26.2*')).toBe(true);

        const response = await run(proxy, '/missions', `everworks_auth_token=${sealed}`);

        expect(response.status).toBe(200);
        expect(redirectPath(response)).toBeNull();
        const lines = sessionCookieLines(response);
        expect(lines).toHaveLength(1);
        expect(lines[0].startsWith(`__Host-everworks_auth_token=${sealed};`)).toBe(true);
        expect(lines[0]).toMatch(/Secure/i);
        expect(lines[0]).toContain('Path=/');
        expect(lines[0]).not.toMatch(/Domain=/i);
    });

    it('lets a visitor with a __Host- cookie in and ignores a sealed plain one planted next to it', async () => {
        const { proxy, encrypt } = await load();
        const mine = await encrypt(sessionToken('user-1'));
        const planted = await encrypt(sessionToken('attacker'));

        const response = await run(
            proxy,
            '/missions',
            `everworks_auth_token=${planted}; __Host-everworks_auth_token=${mine}`,
        );

        expect(response.status).toBe(200);
        expect(sessionCookieLines(response)).toEqual([]);
    });

    // I2b: a tossed `Domain=` cookie next to the visitor's own plain one. Neither is trusted; the
    // visitor signs in again (and then has a `__Host-` cookie, which a tossed one cannot beat).
    it('refuses a plain session name sent twice: no sign-in on it and no migration', async () => {
        const { proxy, encrypt } = await load();
        const mine = await encrypt(sessionToken('user-1'));
        const tossed = await encrypt(sessionToken('attacker'));

        const response = await run(
            proxy,
            '/missions',
            `everworks_auth_token=${mine}; everworks_auth_token=${tossed}`,
        );

        expect(redirectPath(response)).toBe('/login');
        const lines = sessionCookieLines(response);
        expect(lines.some((line) => line.startsWith('__Host-everworks_auth_token=Fe26'))).toBe(
            false,
        );
        for (const line of lines) expect(line).toMatch(/Max-Age=0/i);
    });

    it('after the end date, a legacy-only sealed cookie no longer signs anyone in', async () => {
        vi.setSystemTime(new Date('2026-12-06T00:00:00.000Z'));
        const { proxy, encrypt } = await load();
        const sealed = await encrypt(sessionToken('user-1'));

        const response = await run(proxy, '/missions', `everworks_auth_token=${sealed}`);

        expect(redirectPath(response)).toBe('/login');
        expect(
            sessionCookieLines(response)
                .map((line) => line.split('=')[0])
                .sort(),
        ).toEqual(['__Host-everworks_auth_token', 'everworks_auth_token']);
    });

    it('a plain cookie that does not unseal signs nobody in and is not copied', async () => {
        const { proxy } = await load();

        const response = await run(proxy, '/missions', 'everworks_auth_token=Fe26.2*forged');

        expect(redirectPath(response)).toBe('/login');
        expect(
            sessionCookieLines(response).some((line) =>
                line.startsWith('__Host-everworks_auth_token=Fe26'),
            ),
        ).toBe(false);
    });
});
