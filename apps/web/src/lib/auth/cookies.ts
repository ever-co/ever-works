import 'server-only';
import { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies } from 'next/headers';
import { encrypt, decrypt } from './crypto';

export const AUTH_COOKIE_NAME = 'everworks_auth_token';

// M-21: in preview / staging deploys that serve over HTTPS but happen to
// run with NODE_ENV !== 'production', the previous `secure: NODE_ENV ===
// 'production'` flag would let the cookie travel over HTTP. Anchor on the
// public URL scheme instead so any HTTPS deploy gets the secure flag.
// `WEB_URL` is already required at boot for the API; mirror that here.
// Exported so the Ever ID flow cookies (`./ever-id-cookies.ts`) take their
// `secure` flag from exactly the same rule.
export function isPublicUrlHttps(): boolean {
    const url = process.env.WEB_URL || process.env.NEXT_PUBLIC_WEB_URL;
    if (url) {
        try {
            return new URL(url).protocol === 'https:';
        } catch {
            // fall through
        }
    }
    return process.env.NODE_ENV === 'production';
}

const cookieOptions: Partial<ResponseCookie> = {
    httpOnly: true,
    secure: isPublicUrlHttps(),
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
};

export async function setAuthAccessCookie(token: string) {
    const cookieStore = await cookies();
    const encryptedToken = await encrypt(token);
    cookieStore.set(AUTH_COOKIE_NAME, encryptedToken, cookieOptions);
}

export async function getAuthAccessCookie() {
    const cookieStore = await cookies();
    const encryptedValue = cookieStore.get(AUTH_COOKIE_NAME)?.value;
    if (!encryptedValue) return undefined;

    try {
        return await decrypt(encryptedValue);
    } catch (error) {
        console.error('Failed to decrypt auth cookie:', error);
        return undefined;
    }
}

export async function removeAuthAccessCookie() {
    const cookieStore = await cookies();
    cookieStore.delete(AUTH_COOKIE_NAME);
}

// =================
// All cookies
// =================

export async function setAuthCookies(access_token: string) {
    await setAuthAccessCookie(access_token);
}

export async function removeAuthAccessCookies() {
    await removeAuthAccessCookie();
}

// =================
// OAuth
// =================

/**
 * A cookie name that only this exact host can set. In production (HTTPS) the `__Host-` prefix
 * makes the browser accept the cookie only with Secure, `Path=/` and no `Domain`, so a page on
 * a sibling subdomain (a user's Work on `{slug}.ever.works`) cannot plant one with
 * `Domain=ever.works` ("cookie tossing"). Plain on http localhost (dev, e2e), where browsers
 * refuse a `__Host-` cookie. `cookieOptions` already has Secure, `Path=/` and no Domain.
 */
function hostOnlyCookieName(name: string): string {
    return isPublicUrlHttps() ? `__Host-${name}` : name;
}

/**
 * Deletes a cookie with the attributes it was set with. A bare `delete(name)` sends no Secure
 * attribute, and a browser ignores that for a `__Host-` cookie, so it would linger.
 */
async function expireCookie(name: string) {
    const cookieStore = await cookies();
    cookieStore.set(name, '', { ...cookieOptions, maxAge: 0 });
}

/** The host-scoped mirror of the OAuth `state` (C-03); `__Host-oauth_state` in production. */
export function oauthStateCookieName(): string {
    return hostOnlyCookieName('oauth_state');
}

export async function setOAuthStateCookie(state: string) {
    const cookieStore = await cookies();
    cookieStore.set(oauthStateCookieName(), state, {
        ...cookieOptions,
        maxAge: 60 * 10, // 10 minute expiry
    });
}

export async function getOAuthStateCookie() {
    const cookieStore = await cookies();
    return cookieStore.get(oauthStateCookieName())?.value;
}

export async function removeOAuthStateCookie() {
    await expireCookie(oauthStateCookieName());
}

// =================
// OAuth — saving a temporary account (EW-617)
// =================

/**
 * HttpOnly cookie that marks an OAuth round trip started on `/save-account`;
 * `__Host-oauth_save_account` in production.
 */
export function oauthSaveAccountCookieName(): string {
    return hostOnlyCookieName('oauth_save_account');
}

/**
 * What the save-account page hands to the OAuth callback: the `state` of the round trip it
 * started, the legal documents the visitor ticked the box for (exactly as displayed), and the
 * temporary account it is FOR. Sealed with the key that encrypts the session cookie, so nobody
 * but this server can mint one; the callback checks the user against the session server-side.
 */
export interface OAuthSaveAccountIntent {
    state: string;
    terms: Array<{ documentId: string; version: string; sha256: string; locale: string }>;
    userId: string;
}

/** How long a save intent lives: the same 10 minutes as the state. */
const OAUTH_SAVE_ACCOUNT_TTL_SECONDS = 60 * 10;
/**
 * Bound into the seal, as `ever-connect-provision-cookie.ts` does: a value this server sealed for
 * another purpose (the same key seals the session cookie) never reads as a save intent, and a
 * seal past `exp` is refused even if the browser kept the cookie.
 */
const OAUTH_SAVE_ACCOUNT_PURPOSE = 'oauth-save-account';

export async function setOAuthSaveAccountCookie(intent: OAuthSaveAccountIntent) {
    const cookieStore = await cookies();
    const sealed = {
        v: 1,
        purpose: OAUTH_SAVE_ACCOUNT_PURPOSE,
        exp: Math.floor(Date.now() / 1000) + OAUTH_SAVE_ACCOUNT_TTL_SECONDS,
        ...intent,
    };
    cookieStore.set(oauthSaveAccountCookieName(), await encrypt(JSON.stringify(sealed)), {
        ...cookieOptions,
        maxAge: OAUTH_SAVE_ACCOUNT_TTL_SECONDS,
    });
}

/**
 * The save intent of this round trip:
 * - `none`: no save was started (a normal sign-in);
 * - `invalid`: a cookie is there but this server did not seal it, sealed it for another purpose,
 *   it expired, or it is not in the shape it writes (forged, tossed from a sibling subdomain, or
 *   tampered). Never act on it;
 * - `valid`: the sealed intent.
 */
export type OAuthSaveAccountCookie =
    | { status: 'none' }
    | { status: 'invalid' }
    | { status: 'valid'; intent: OAuthSaveAccountIntent };

export async function readOAuthSaveAccountCookie(): Promise<OAuthSaveAccountCookie> {
    const cookieStore = await cookies();
    const raw = cookieStore.get(oauthSaveAccountCookieName())?.value;
    if (!raw) {
        return { status: 'none' };
    }
    try {
        const parsed = JSON.parse(await decrypt(raw)) as unknown;
        if (!parsed || typeof parsed !== 'object') {
            return { status: 'invalid' };
        }
        const { v, purpose, exp, state, terms, userId } = parsed as Record<string, unknown>;
        if (
            v !== 1 ||
            purpose !== OAUTH_SAVE_ACCOUNT_PURPOSE ||
            typeof exp !== 'number' ||
            exp <= Math.floor(Date.now() / 1000) ||
            typeof state !== 'string' ||
            !state ||
            !Array.isArray(terms) ||
            typeof userId !== 'string' ||
            !userId
        ) {
            return { status: 'invalid' };
        }
        return {
            status: 'valid',
            intent: { state, terms: terms as OAuthSaveAccountIntent['terms'], userId },
        };
    } catch {
        return { status: 'invalid' };
    }
}

export async function removeOAuthSaveAccountCookie() {
    await expireCookie(oauthSaveAccountCookieName());
}

// =================
// GitHub App setup — browser binding (10-09 handover item 13)
// =================

/** HttpOnly cookie holding the setup's browser-binding nonce, scoped to the App routes. */
export const GITHUB_APP_SETUP_COOKIE_NAME = 'ew_github_app_setup';

/** The cookie's options: Lax so GitHub's top-level redirect back carries it. */
export function githubAppSetupCookieOptions(maxAgeSeconds: number): Partial<ResponseCookie> {
    return {
        httpOnly: true,
        secure: isPublicUrlHttps(),
        sameSite: 'lax',
        path: '/api/github-app',
        maxAge: Math.max(60, Math.min(maxAgeSeconds, 60 * 15)),
    };
}

// =================
// Redirects
// =================

export async function setRedirectCookie(url: string) {
    const cookieStore = await cookies();
    cookieStore.set('redirect_url', url, {
        ...cookieOptions,
        maxAge: 60 * 10, // 10 minute expiry
    });
}

export async function getRedirectCookie() {
    const cookieStore = await cookies();
    return cookieStore.get('redirect_url')?.value;
}

export async function removeRedirectCookie() {
    const cookieStore = await cookies();
    cookieStore.delete('redirect_url');
}
