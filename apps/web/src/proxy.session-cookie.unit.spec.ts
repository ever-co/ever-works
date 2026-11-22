import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from './lib/workspace-scope';

/**
 * R-16 — the proxy is where a legacy plain-name session cookie moves to
 * `__Host-everworks_auth_token` (a render cannot write cookies), and where the signed-out gate
 * expires both names. Loaded with an HTTPS public URL, as in production.
 */

const { getAuthFromRequestMock, intlMock } = vi.hoisted(() => ({
    getAuthFromRequestMock: vi.fn(),
    // A NextResponse, as next-intl's middleware returns: it has the `cookies` API.
    intlMock: vi.fn(async (_request: unknown) => NextResponse.next()),
}));

vi.mock('next-intl/middleware', () => ({ default: () => intlMock }));
vi.mock('./lib/auth', () => ({ getAuthFromRequest: getAuthFromRequestMock }));

async function loadProxy(env: Record<string, string> = {}) {
    vi.resetModules();
    vi.stubEnv('WEB_URL', 'https://app.example');
    vi.stubEnv('COOKIE_SECRET', 'x'.repeat(48));
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    return (await import('./proxy')).default;
}

function request(path: string, cookie: string): NextRequest {
    return new NextRequest(`https://app.example${path}`, {
        headers: { [BROWSER_WORKSPACE_SCOPE_HEADER]: 'personal', cookie },
    });
}

/** Every Set-Cookie line of a response. */
function setCookies(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    return headers.getSetCookie ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
}

describe('proxy — session cookie (R-16)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('moves a signed-in visitor on the legacy cookie to __Host-, once, keeping the session', async () => {
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
        const proxy = await loadProxy();

        const response = await proxy(request('/missions', 'everworks_auth_token=sealed-legacy'));

        const lines = setCookies(response);
        const moved = lines.find((line) => line.startsWith('__Host-everworks_auth_token='));
        expect(moved).toContain('__Host-everworks_auth_token=sealed-legacy');
        expect(moved).toMatch(/Secure/i);
        expect(moved).toContain('Path=/');
        expect(moved).not.toMatch(/Domain=/i);
        const expired = lines.find((line) => line.startsWith('everworks_auth_token='));
        expect(expired).toMatch(/Max-Age=0/i);
        // Signed in throughout: no redirect to sign-in.
        expect(response.status).toBe(200);
    });

    it('leaves a visitor who already has the __Host- cookie alone, whatever plain one is planted', async () => {
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
        const proxy = await loadProxy();

        const response = await proxy(
            request(
                '/missions',
                '__Host-everworks_auth_token=current; everworks_auth_token=planted',
            ),
        );

        expect(setCookies(response).some((line) => line.includes('everworks_auth_token'))).toBe(
            false,
        );
    });

    it('does not move anything with AUTH_COOKIE_LEGACY_FALLBACK=false', async () => {
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
        const proxy = await loadProxy({ AUTH_COOKIE_LEGACY_FALLBACK: 'false' });

        const response = await proxy(request('/missions', 'everworks_auth_token=sealed-legacy'));

        expect(
            setCookies(response).some((line) => line.startsWith('__Host-everworks_auth_token=')),
        ).toBe(false);
    });

    it('the signed-out gate expires both names, each with Secure and Path=/', async () => {
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: false, isExpired: false });
        const proxy = await loadProxy();

        const response = await proxy(
            request('/missions', '__Host-everworks_auth_token=stale; everworks_auth_token=stale'),
        );

        expect(new URL(response.headers.get('location') as string).pathname).toBe('/login');
        const lines = setCookies(response).filter((line) => line.includes('everworks_auth_token='));
        expect(lines.map((line) => line.split('=')[0]).sort()).toEqual([
            '__Host-everworks_auth_token',
            'everworks_auth_token',
        ]);
        for (const line of lines) {
            expect(line).toMatch(/Max-Age=0/i);
            expect(line).toMatch(/Secure/i);
            expect(line).toContain('Path=/');
        }
    });
});
