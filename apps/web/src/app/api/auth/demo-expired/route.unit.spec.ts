import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Platform demo mode — the stop on the way from an expired demo session to `/login?demo=expired`.
 *
 * `getAuthFromCookie` notices the expiry while a page renders, where Next.js refuses to change a
 * cookie, so the stale session cookie used to survive the redirect and every other page that
 * reads the session bounced the visitor back to the sign-in page. This route handler may write
 * cookies: it removes the session cookie when the API rejects it, and only then.
 *
 * The real `lib/auth` and `lib/auth/cookies` run here; the cookie store, the API, the demo
 * config and the redirect are doubles.
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
            set: (name: string, value: string) => {
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
    redirect: vi.fn((): never => {
        throw new Error('NEXT_REDIRECT');
    }),
    nextRedirect: vi.fn((): never => {
        throw new Error('NEXT_REDIRECT (next/navigation)');
    }),
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return { ...actual, cache: <T>(fn: T) => fn };
});
vi.mock('next/headers', () => ({ cookies: async () => jar.store }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('next/navigation', () => ({ redirect: mocks.nextRedirect }));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));
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

/** Runs the handler; the href it redirected to, or the response it answered with. */
async function run(): Promise<{ href?: string; response?: Response }> {
    try {
        const response = await GET();
        return { response };
    } catch (error) {
        expect((error as Error).message).toBe('NEXT_REDIRECT');
        expect(mocks.redirect).toHaveBeenCalledTimes(1);
        const [{ locale, href }] = mocks.redirect.mock.calls[0] as unknown as [
            { locale: string; href: string },
        ];
        expect(locale).toBe('en');
        return { href };
    }
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

            const { href } = await run();

            expect(href).toBe('/login?demo=expired');
            expect(jar.deletes).toEqual([AUTH_COOKIE_NAME]);
            expect(jar.values.has(AUTH_COOKIE_NAME)).toBe(false);
            // The sign-in variant of the check: no second trip through a redirect.
            expect(mocks.nextRedirect).not.toHaveBeenCalled();
        });

        it('keeps a session the API still accepts, so a link here signs no one out', async () => {
            mocks.getProfile.mockResolvedValue({ id: 'u1', email: 'demo@demo.ever.works' });

            const { href } = await run();

            // The sign-in page sends a signed-in visitor on to the dashboard.
            expect(href).toBe('/login?demo=expired');
            expect(jar.deletes).toEqual([]);
            expect(jar.values.get(AUTH_COOKIE_NAME)).toBe('encrypted-session');
        });

        it('keeps the cookie and still lands on the sign-in page when the API cannot answer', async () => {
            mocks.getProfile.mockRejectedValue(new ApiResponseError('boom', 500));

            const { href } = await run();

            expect(href).toBe('/login?demo=expired');
            expect(jar.deletes).toEqual([]);
        });

        it('asks the API nothing when there is no session cookie to check', async () => {
            mocks.getAuthFromRequest.mockResolvedValue({ isAuthenticated: false });

            const { href } = await run();

            expect(href).toBe('/login?demo=expired');
            expect(mocks.getProfile).not.toHaveBeenCalled();
            expect(jar.deletes).toEqual([]);
        });
    });

    it('demo off: answers 404 and touches nothing, as before the route existed', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        mocks.getProfile.mockRejectedValue(new ApiResponseError('unauthorized', 401));

        const { response, href } = await run();

        expect(href).toBeUndefined();
        expect(response?.status).toBe(404);
        expect(mocks.getAuthFromRequest).not.toHaveBeenCalled();
        expect(mocks.getProfile).not.toHaveBeenCalled();
        expect(jar.deletes).toEqual([]);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });
});
