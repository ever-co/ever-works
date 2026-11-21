import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Demo mode — a session the API rejects (the sandbox expired or was swept)
 * lands the visitor on `/login?demo=expired`, through `/api/auth/demo-expired`,
 * which can remove the stale cookie a render cannot. Demo off, and the sign-in
 * page itself, behave exactly as before.
 */

const mocks = vi.hoisted(() => ({
    getAuthFromRequest: vi.fn(),
    getProfile: vi.fn(),
    removeAuthAccessCookies: vi.fn(),
    getDemoConfig: vi.fn(),
    redirect: vi.fn((): never => {
        throw new Error('NEXT_REDIRECT');
    }),
}));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return { ...actual, cache: <T>(fn: T) => fn };
});
vi.mock('../api', () => ({ authAPI: { getProfile: mocks.getProfile, getFreshProfile: vi.fn() } }));
vi.mock('../api/server-api', () => ({
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
vi.mock('./middleware', () => ({ getAuthFromRequest: mocks.getAuthFromRequest }));
vi.mock('./cookies', () => ({ removeAuthAccessCookies: mocks.removeAuthAccessCookies }));
vi.mock('./ever-id-signed-out', () => ({ rememberEverIdSignOut: vi.fn() }));
vi.mock('../feature-flags/demo', () => ({ getDemoConfig: mocks.getDemoConfig }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import {
    DEMO_EXPIRED_HREF,
    DEMO_EXPIRED_SIGN_OUT_HREF,
    getAuthFromCookie,
    getAuthFromCookieOnSignIn,
} from './index';
import { ApiResponseError } from '../api/server-api';

describe('getAuthFromCookie — demo expiry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mocks.getAuthFromRequest.mockResolvedValue({
            isAuthenticated: true,
            isExpired: false,
            isOpaqueToken: true,
            token: 'opaque',
        });
        mocks.getProfile.mockRejectedValue(new ApiResponseError('unauthorized', 401));
    });

    it('redirects through /api/auth/demo-expired on a 401 when the instance is a demo', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: true });
        await expect(getAuthFromCookie()).rejects.toThrow('NEXT_REDIRECT');
        expect(mocks.removeAuthAccessCookies).toHaveBeenCalledTimes(1);
        // The route handler removes the cookie (a render cannot), then lands on /login?demo=expired.
        expect(mocks.redirect).toHaveBeenCalledWith('/api/auth/demo-expired');
        expect(DEMO_EXPIRED_SIGN_OUT_HREF).toBe('/api/auth/demo-expired');
        expect(DEMO_EXPIRED_HREF).toBe('/login?demo=expired');
    });

    it('a cookie that cannot be removed during the render still redirects (no 500)', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: true });
        mocks.removeAuthAccessCookies.mockRejectedValueOnce(
            new Error('Cookies can only be modified in a Server Action or Route Handler.'),
        );
        await expect(getAuthFromCookie()).rejects.toThrow('NEXT_REDIRECT');
        expect(mocks.redirect).toHaveBeenCalledWith('/api/auth/demo-expired');
    });

    it('demo off: clears the cookie and reports signed out, no redirect (as before)', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        await expect(getAuthFromCookie()).resolves.toBeNull();
        expect(mocks.removeAuthAccessCookies).toHaveBeenCalledTimes(1);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('the sign-in page variant never redirects, even on a demo (no loop)', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: true });
        await expect(getAuthFromCookieOnSignIn()).resolves.toBeNull();
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('does not ask the config or redirect for a non-401 failure', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: true });
        mocks.getProfile.mockRejectedValue(new ApiResponseError('boom', 500));
        await expect(getAuthFromCookie()).rejects.toThrow('boom');
        expect(mocks.redirect).not.toHaveBeenCalled();
    });
});
