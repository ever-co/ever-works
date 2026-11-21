import { cache } from 'react';
import type { EverIdWireErrorCode } from '@ever-works/contracts';
import { authAPI } from '../api';
import { ApiResponseError } from '../api/server-api';
import type { UserProfile } from '../api/auth';
import { getAuthFromRequest } from './middleware';
import type { AuthUser, JwtPayload } from './middleware';
import { removeAuthAccessCookies } from './cookies';
import { rememberEverIdSignOut } from './ever-id-signed-out';
import { getDemoConfig } from '../feature-flags/demo';
import { redirect } from 'next/navigation';
import { ROUTES } from '../constants';

/** Where a visitor whose demo sandbox expired (or was swept) mid-session lands. */
export const DEMO_EXPIRED_HREF = `${ROUTES.AUTH_LOGIN}?demo=expired`;

/**
 * The route handler (`app/api/auth/demo-expired/route.ts`) a render sends that visitor
 * through on the way to {@link DEMO_EXPIRED_HREF}: it removes the stale session cookie, which a
 * render cannot, so no other page bounces the visitor back to the sign-in page. Only a render
 * goes this way; a Server Action or route handler removes the cookie itself and redirects
 * straight to {@link DEMO_EXPIRED_HREF}.
 */
export const DEMO_EXPIRED_SIGN_OUT_HREF = '/api/auth/demo-expired';

/**
 * APW-12 (Ever ID) S6 — the API answers `401 { code: 'ever_id_signed_out' }`
 * for a session that an Ever ID sign-out notice ended, instead of the plain
 * `401` an expired session gets. A type-only import keeps the literal checked
 * against the contract without adding a runtime dependency to this module,
 * which the proxy also loads.
 */
const EVER_ID_SIGNED_OUT_CODE: EverIdWireErrorCode = 'ever_id_signed_out';

/**
 * Per-request record of that answer. `cache()` scopes the object to one server
 * request, so the sign-in page — which validates the stale cookie through
 * {@link getAuthFromCookie} before rendering — can tell "you were signed out of
 * Ever ID" apart from an ordinary expiry and show the notice on that load.
 * Where the cookie could be removed (a Server Action or route handler) the
 * sign-in page has nothing left to validate, so a short-lived marker carries
 * the notice instead (`./ever-id-signed-out.ts`).
 */
const everIdSignOutNotice = cache((): { seen: boolean } => ({ seen: false }));

/** Whether this request saw the API end the session because of an Ever ID sign-out (S6). */
export function wasSignedOutByEverId(): boolean {
    return everIdSignOutNotice().seen;
}

function normalizeJwtUser(user: JwtPayload): AuthUser {
    return {
        id: user.sub,
        email: user.email,
        username: user.username,
        emailVerified: user.emailVerified,
        avatar: user.avatar,
        provider: user.provider,
        isActive: user.isActive,
    };
}

function normalizeProfileUser(user: UserProfile): AuthUser {
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        emailVerified: user.emailVerified ?? false,
        avatar: user.avatar ?? null,
    };
}

async function clearAuthCookieOnUnauthorized(
    error: unknown,
    redirectOnDemoExpiry = true,
): Promise<boolean> {
    if (error instanceof ApiResponseError && error.statusCode === 401) {
        const endedByEverId = error.code === EVER_ID_SIGNED_OUT_CODE;
        if (endedByEverId) {
            everIdSignOutNotice().seen = true;
        }
        console.warn(
            'Auth session rejected by API; clearing auth cookie. Verify web/API AUTH_SECRET values and session storage if this happens after login.',
        );
        // Best-effort. These helpers are `cache()`d and run during Server
        // Component RENDER, where Next.js refuses cookie mutation and throws
        // "Cookies can only be modified in a Server Action or Route Handler."
        // That throw used to escape from inside this catch handler and take
        // the whole render down: a session the API rejects turned EVERY
        // authenticated page — and /login itself — into a hard 500, leaving
        // the user with no way back in through the UI. Reporting the session
        // as unauthenticated is the part that matters; the redirect to login
        // follows, and the stale cookie is cleared by the next Server Action
        // or route handler (login POST, /logout) where the write is legal.
        let cleared = true;
        try {
            await removeAuthAccessCookies();
        } catch (clearError) {
            cleared = false;
            console.warn(
                'Could not clear the auth cookie from this context (expected during a Server Component render); treating the session as unauthenticated anyway.',
                clearError,
            );
        }
        if (endedByEverId) {
            await rememberEverIdSignOut();
        }
        // Demo instance: the sandbox is deleted with its session, so a 401 means it
        // expired (or the sweeper took it). Say so instead of leaving a generic
        // sign-in page. Where the cookie is already gone (a Server Action or a
        // route handler), straight there. Where it could not be removed (a
        // render), by way of the route handler that removes it, so the next page
        // that reads the session does not bounce the visitor back. Not the
        // detour from an action: Next.js follows an action's redirect on the
        // server and would show the sign-in page under the detour's address,
        // without `?demo=expired` and so without the notice. The sign-in page
        // itself opts out (`redirectOnDemoExpiry: false`), as does that route
        // handler's own check — redirecting from there would loop. Demo off:
        // nothing changes.
        if (redirectOnDemoExpiry && !endedByEverId && (await getDemoConfig()).enabled) {
            // `localePrefix: 'never'` — the plain path is the whole URL.
            redirect(cleared ? DEMO_EXPIRED_HREF : DEMO_EXPIRED_SIGN_OUT_HREF);
        }
        return true;
    }
    return false;
}

// Node.js fetch throws TypeError('fetch failed') for network-level failures
// (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, etc.). These are distinct from HTTP
// error responses that arrive as ApiResponseError. When the API is unreachable
// we treat the session as unauthenticated rather than crashing the render.
function isNetworkError(error: unknown): boolean {
    return error instanceof TypeError && error.message === 'fetch failed';
}

const getAuthFromCookieImpl = async (redirectOnDemoExpiry: boolean): Promise<AuthUser | null> => {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated || auth.isExpired) {
        return null;
    }

    if (auth.user) {
        try {
            const profile = await authAPI.getProfile();
            return {
                ...normalizeProfileUser(profile),
                provider: auth.user.provider,
                isActive: auth.user.isActive,
            };
        } catch (error) {
            if (await clearAuthCookieOnUnauthorized(error, redirectOnDemoExpiry)) return null;
            if (isNetworkError(error)) {
                console.warn('API unreachable; keeping session from JWT cookie data.');
                return normalizeJwtUser(auth.user);
            }
            throw error;
        }
    }

    // Opaque (non-JWT) token — no local user data to fall back on.
    try {
        return normalizeProfileUser(await authAPI.getProfile());
    } catch (error) {
        if (await clearAuthCookieOnUnauthorized(error, redirectOnDemoExpiry)) return null;
        if (isNetworkError(error)) {
            console.warn(
                'API unreachable during auth validation (opaque token); treating session as unauthenticated.',
            );
            return null;
        }
        throw error;
    }
};

const getAuthFromAPIImpl = async (): Promise<AuthUser | null> => {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated || auth.isExpired) {
        return null;
    }

    try {
        return normalizeProfileUser(await authAPI.getFreshProfile());
    } catch (error) {
        if (await clearAuthCookieOnUnauthorized(error)) return null;
        if (isNetworkError(error)) {
            console.warn('API unreachable; keeping session from JWT cookie data.');
            return auth.user ? normalizeJwtUser(auth.user) : null;
        }
        throw error;
    }
};

export const getAuthFromCookie = cache(() => getAuthFromCookieImpl(true));

/**
 * {@link getAuthFromCookie} for the sign-in page: identical, except a rejected
 * session never redirects to `/login?demo=expired` (it is already there). The
 * demo-expiry route handler checks with it too, on its way there.
 */
export const getAuthFromCookieOnSignIn = cache(() => getAuthFromCookieImpl(false));

export const getAuthFromAPI = cache(getAuthFromAPIImpl);

export * from './middleware';
export * from './cookies';
