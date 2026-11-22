import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Platform demo mode — the stop on the way from an expired demo session to `/login?demo=expired`.
 *
 * `getAuthFromCookie` notices the expiry while a page renders, where Next.js refuses to change a
 * cookie, so the stale session cookie used to survive the redirect and every other page that
 * reads the session bounced the visitor back to the sign-in page. This route handler may write
 * cookies: it removes the session cookie when the API rejects it, and only then.
 *
 * The real `lib/auth` and `lib/auth/cookies` run here; the cookie store, the API and the demo
 * config are doubles.
 */

const jar = vi.hoisted(() => {
    const values = new Map<string, string>();
    const deletes: string[] = [];
    return {
        values,
        deletes,
        reset() {
            values.clear();
            deletes.length = 0;
        },
        store: {
            get: (name: string) =>
                values.has(name) ? { name, value: values.get(name)! } : undefined,
            has: (name: string) => values.has(name),
            set: (name: string, value: string, options?: { maxAge?: number }) => {
                // Expiring with Max-Age=0 (how the session cookie is removed now, so the
                // `__Host-` name is removed too) is a delete, as the browser treats it.
                if (options?.maxAge === 0) {
                    deletes.push(name);
                    values.delete(name);
                    return;
                }
                values.set(name, value);
            },
            delete: (arg: string | { name: string }) => {
                const name = typeof arg === 'string' ? arg : arg.name;
                deletes.push(name);
                values.delete(name);
            },
        },
    };
});

const mocks = vi.hoisted(() => ({
    getAuthFromRequest: vi.fn(),
    getProfile: vi.fn(),
    getDemoConfig: vi.fn(),
    rememberEverIdSignOut: vi.fn(),
    nextRedirect: vi.fn((): never => {
        throw new Error('NEXT_REDIRECT (next/navigation)');
    }),
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return { ...actual, cache: <T>(fn: T) => fn };
});
vi.mock('next/headers', () => ({ cookies: async () => jar.store }));
vi.mock('next/navigation', () => ({ redirect: mocks.nextRedirect }));
vi.mock('@/lib/api', () => ({
    authAPI: { getProfile: mocks.getProfile, getFreshProfile: vi.fn() },
}));
vi.mock('@/lib/api/server-api', () => ({
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
        ) {
            super(message);
        }
    },
}));
vi.mock('@/lib/auth/middleware', () => ({ getAuthFromRequest: mocks.getAuthFromRequest }));
vi.mock('@/lib/auth/ever-id-signed-out', () => ({
    rememberEverIdSignOut: mocks.rememberEverIdSignOut,
}));
vi.mock('@/lib/feature-flags/demo', () => ({ getDemoConfig: mocks.getDemoConfig }));

import { GET } from './route';
import { AUTH_COOKIE_NAME } from '@/lib/auth/cookies';
import { ApiResponseError } from '@/lib/api/server-api';

/** Runs the handler and checks it answered the sign-in page's demo-expired address, uncached. */
async function expectLandsOnExpiredSignIn(): Promise<void> {
    const response = await GET();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/login?demo=expired');
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The sign-in variant of the check: no second trip through a redirect.
    expect(mocks.nextRedirect).not.toHaveBeenCalled();
}

describe('GET /api/auth/demo-expired', () => {
    beforeEach(() => {
        jar.reset();
        jar.values.set(AUTH_COOKIE_NAME, 'encrypted-session');
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mocks.getAuthFromRequest.mockResolvedValue({
            isAuthenticated: true,
            isExpired: false,
            isOpaqueToken: true,
            token: 'opaque',
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('demo on', () => {
        beforeEach(() => {
            mocks.getDemoConfig.mockResolvedValue({ enabled: true });
        });

        it('removes the session cookie the API rejects, then lands on /login?demo=expired', async () => {
            mocks.getProfile.mockRejectedValue(new ApiResponseError('unauthorized', 401));

            await expectLandsOnExpiredSignIn();

            expect(jar.deletes).toEqual([AUTH_COOKIE_NAME]);
            expect(jar.values.has(AUTH_COOKIE_NAME)).toBe(false);
        });

        it('keeps a session the API still accepts, so a link here signs no one out', async () => {
            mocks.getProfile.mockResolvedValue({ id: 'u1', email: 'demo@demo.ever.works' });

            // The sign-in page sends a signed-in visitor on to the dashboard.
            await expectLandsOnExpiredSignIn();

            expect(jar.deletes).toEqual([]);
            expect(jar.values.get(AUTH_COOKIE_NAME)).toBe('encrypted-session');
        });

        it('keeps the cookie and still lands on the sign-in page when the API answers 5xx', async () => {
            mocks.getProfile.mockRejectedValue(new ApiResponseError('boom', 500));

            await expectLandsOnExpiredSignIn();

            expect(jar.deletes).toEqual([]);
        });

        it('keeps the cookie and still lands on the sign-in page when the API is unreachable', async () => {
            mocks.getProfile.mockRejectedValue(new TypeError('fetch failed'));

            await expectLandsOnExpiredSignIn();

            expect(jar.deletes).toEqual([]);
            expect(jar.values.get(AUTH_COOKIE_NAME)).toBe('encrypted-session');
        });

        it('an Ever ID sign-out 401: removes the cookie and remembers the sign-out for the notice', async () => {
            mocks.getProfile.mockRejectedValue(
                new ApiResponseError('signed out', 401, 'ever_id_signed_out'),
            );

            await expectLandsOnExpiredSignIn();

            expect(jar.deletes).toEqual([AUTH_COOKIE_NAME]);
            expect(mocks.rememberEverIdSignOut).toHaveBeenCalledTimes(1);
        });

        it('asks the API nothing when there is no session cookie to check', async () => {
            mocks.getAuthFromRequest.mockResolvedValue({ isAuthenticated: false });

            await expectLandsOnExpiredSignIn();

            expect(mocks.getProfile).not.toHaveBeenCalled();
            expect(jar.deletes).toEqual([]);
        });
    });

    it('demo off: answers 404, uncached, and touches nothing, as before the route existed', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        mocks.getProfile.mockRejectedValue(new ApiResponseError('unauthorized', 401));

        const response = await GET();

        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('location')).toBeNull();
        expect(mocks.getAuthFromRequest).not.toHaveBeenCalled();
        expect(mocks.getProfile).not.toHaveBeenCalled();
        expect(jar.deletes).toEqual([]);
    });
});
