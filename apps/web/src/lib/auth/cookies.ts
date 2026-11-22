import 'server-only';
import { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies } from 'next/headers';
import { encrypt, decrypt } from './crypto';

/**
 * The session cookie's PLAIN name: the only one on http (dev, e2e), and the legacy one on HTTPS,
 * where the live name is `__Host-everworks_auth_token` (`authCookieName()`). R-16: user Works and
 * apps live on sibling hosts (`<slug>.ever.works`), which can plant a plain-name cookie with
 * `Domain=ever.works` and sign a visitor in to the attacker's account (login CSRF).
 */
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

/**
 * A cookie name that only this exact host can set (R-16). In production (HTTPS) the `__Host-`
 * prefix makes the browser accept the cookie only with Secure, `Path=/` and no `Domain`, so a
 * page on a sibling subdomain (a user's Work on `{slug}.ever.works`) cannot plant one with
 * `Domain=ever.works` ("cookie tossing"). Plain on http localhost (dev, e2e), where browsers
 * refuse a `__Host-` cookie. Decided from the configured public URL only (`isPublicUrlHttps`),
 * never from a request header. Every cookie named with it must be set with Secure, `Path=/` and
 * no Domain (`cookieOptions` has all three).
 */
export function hostOnlyCookieName(name: string): string {
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

// =================
// Session cookie (R-16)
// =================

/** The live session cookie name: `__Host-everworks_auth_token` on HTTPS, plain on http. */
export function authCookieName(): string {
    return hostOnlyCookieName(AUTH_COOKIE_NAME);
}

/**
 * Whether a legacy plain-name session cookie is still honoured on HTTPS, so nobody signed in
 * before the rename is signed out by it. On (the default) until `AUTH_COOKIE_LEGACY_FALLBACK` is
 * `false` / `0` / `off` / `no`, which is safe once every legacy cookie has expired (the session
 * cookie lives 7 days). Meaningless on http, where the plain name IS the live one.
 */
export function legacyAuthCookieFallbackEnabled(): boolean {
    if (!isPublicUrlHttps()) return false;
    const flag = process.env.AUTH_COOKIE_LEGACY_FALLBACK?.trim().toLowerCase();
    return !(flag === 'false' || flag === '0' || flag === 'off' || flag === 'no');
}

/** The session cookie's attributes, for code that writes a response's cookies directly (proxy). */
export function authCookieOptions(): Partial<ResponseCookie> {
    return { ...cookieOptions };
}

export async function setAuthAccessCookie(token: string) {
    const cookieStore = await cookies();
    const encryptedToken = await encrypt(token);
    cookieStore.set(authCookieName(), encryptedToken, cookieOptions);
    // A fresh sign-in on HTTPS leaves no legacy plain-name cookie behind to fall back to.
    if (authCookieName() !== AUTH_COOKIE_NAME && cookieStore.get(AUTH_COOKIE_NAME)) {
        cookieStore.set(AUTH_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
    }
}

/**
 * The sealed session cookie's value: the `__Host-` one when it exists (a plain-name cookie next to
 * it is ignored, whoever planted it), else, while the fallback is on, a legacy plain-name one.
 * Reads only: the proxy moves a legacy cookie to the new name (`migrateLegacyAuthCookie`), since a
 * render cannot write cookies.
 */
async function readSealedAuthCookie(): Promise<string | undefined> {
    const cookieStore = await cookies();
    const current = cookieStore.get(authCookieName())?.value;
    if (current) return current;
    if (legacyAuthCookieFallbackEnabled()) {
        return cookieStore.get(AUTH_COOKIE_NAME)?.value || undefined;
    }
    return undefined;
}

export async function getAuthAccessCookie() {
    const encryptedValue = await readSealedAuthCookie();
    if (!encryptedValue) return undefined;

    try {
        return await decrypt(encryptedValue);
    } catch (error) {
        console.error('Failed to decrypt auth cookie:', error);
        return undefined;
    }
}

/** Signs out on this browser: the live cookie and, on HTTPS, a legacy plain-name one. */
export async function removeAuthAccessCookie() {
    await expireCookie(authCookieName());
    if (authCookieName() !== AUTH_COOKIE_NAME) {
        await expireCookie(AUTH_COOKIE_NAME);
    }
}

type RequestCookieReader = { cookies: { get(name: string): { value: string } | undefined } };
type ResponseCookieWriter = {
    cookies: { set(name: string, value: string, options?: Partial<ResponseCookie>): unknown };
};

/**
 * The one-time move of a legacy plain-name session cookie to `__Host-everworks_auth_token`, in
 * the proxy (where a response's cookies can be written). Only while the fallback is on, only
 * when there is no `__Host-` cookie yet (once there is, the plain name is ignored for good), and
 * only for a request the auth gate let through. Re-sets the same sealed value under the new name
 * and expires the host-only legacy cookie. Returns whether it moved one.
 */
export function migrateLegacyAuthCookie(
    request: RequestCookieReader,
    response: ResponseCookieWriter,
): boolean {
    if (!legacyAuthCookieFallbackEnabled() || !response.cookies) return false;
    const name = authCookieName();
    if (request.cookies.get(name)?.value) return false;
    const legacy = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    if (!legacy) return false;
    response.cookies.set(name, legacy, cookieOptions);
    response.cookies.set(AUTH_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
    return true;
}

/**
 * Expires every session cookie name on a response (the proxy's signed-out gate): the live one
 * and, on HTTPS, a legacy plain-name one, each with the attributes it was set with.
 */
export function expireAuthCookies(response: ResponseCookieWriter): void {
    response.cookies.set(authCookieName(), '', { ...cookieOptions, maxAge: 0 });
    if (authCookieName() !== AUTH_COOKIE_NAME) {
        response.cookies.set(AUTH_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
    }
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

/** The plain name of the setup's browser-binding nonce cookie (the live one on http). */
export const GITHUB_APP_SETUP_COOKIE_NAME = 'ew_github_app_setup';

/**
 * The binding nonce's cookie name: `__Host-ew_github_app_setup` on HTTPS (R-16), so a sibling
 * subdomain cannot plant its own setup binding. `__Host-` requires `Path=/`, so on HTTPS the cookie
 * is no longer scoped to `/api/github-app` (it is HttpOnly, lives at most 15 minutes, and only the
 * two App routes read it); on http it keeps the old name and path, unchanged.
 */
export function githubAppSetupCookieName(): string {
    return hostOnlyCookieName(GITHUB_APP_SETUP_COOKIE_NAME);
}

/** The cookie's options: Lax so GitHub's top-level redirect back carries it. */
export function githubAppSetupCookieOptions(maxAgeSeconds: number): Partial<ResponseCookie> {
    return {
        httpOnly: true,
        secure: isPublicUrlHttps(),
        sameSite: 'lax',
        path: isPublicUrlHttps() ? '/' : '/api/github-app',
        maxAge: Math.max(60, Math.min(maxAgeSeconds, 60 * 15)),
    };
}

// =================
// Redirects
// =================

/** Where to go after signing in; `__Host-redirect_url` on HTTPS (R-16). */
export function redirectCookieName(): string {
    return hostOnlyCookieName('redirect_url');
}

export async function setRedirectCookie(url: string) {
    const cookieStore = await cookies();
    cookieStore.set(redirectCookieName(), url, {
        ...cookieOptions,
        maxAge: 60 * 10, // 10 minute expiry
    });
}

export async function getRedirectCookie() {
    const cookieStore = await cookies();
    return cookieStore.get(redirectCookieName())?.value;
}

export async function removeRedirectCookie() {
    await expireCookie(redirectCookieName());
}
