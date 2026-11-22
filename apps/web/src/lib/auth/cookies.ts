import 'server-only';
import { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies, headers } from 'next/headers';
import { encrypt, decrypt } from './crypto';
import { isPublicUrlHttps, legacyAuthCookieFallback } from './cookie-policy';

// Decided from the configured public URL only (`./cookie-policy.ts`); re-exported so every
// caller of `@/lib/auth/cookies` keeps importing it from here.
export { isPublicUrlHttps };

/**
 * The session cookie's PLAIN name: the only one on http (dev, e2e), and the legacy one on HTTPS,
 * where the live name is `__Host-everworks_auth_token` (`authCookieName()`). R-16: user Works and
 * apps live on sibling hosts (`<slug>.ever.works`), which can plant a plain-name cookie with
 * `Domain=ever.works` and sign a visitor in to the attacker's account (login CSRF).
 */
export const AUTH_COOKIE_NAME = 'everworks_auth_token';

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
 * Whether the plain session cookie name still works on HTTPS: read as a fallback when there is no
 * `__Host-` cookie (nobody signed in before the rename is signed out by it), and written as a
 * mirror next to the `__Host-` one (a pod still on the previous release during a rolling deploy
 * reads only the plain name). It has a hard end in code (`AUTH_COOKIE_LEGACY_FALLBACK_UNTIL`,
 * default `LEGACY_AUTH_COOKIE_DEFAULT_UNTIL`), `AUTH_COOKIE_LEGACY_FALLBACK=false` ends it sooner,
 * and it never applies on http, where the plain name IS the live one (`./cookie-policy.ts`).
 */
export function legacyAuthCookieFallbackEnabled(): boolean {
    return legacyAuthCookieFallback().active;
}

/**
 * How many cookies called `name` a raw `Cookie` header carries. A browser sends both a host-only
 * cookie and one a sibling subdomain set with `Domain=ever.works` under the same name, and the
 * cookie APIs keep only one of them (the last), so a tossed cookie could win over the visitor's
 * own. Two or more plain session cookies is therefore never trusted (I2b).
 */
export function countCookieName(cookieHeader: string | null | undefined, name: string): number {
    if (!cookieHeader) return 0;
    let count = 0;
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if ((eq < 0 ? part : part.slice(0, eq)).trim() === name) count += 1;
    }
    return count;
}

export async function setAuthAccessCookie(token: string) {
    const cookieStore = await cookies();
    const encryptedToken = await encrypt(token);
    cookieStore.set(authCookieName(), encryptedToken, cookieOptions);
    if (authCookieName() === AUTH_COOKIE_NAME) return;
    if (legacyAuthCookieFallbackEnabled()) {
        // Rolling-deploy skew: a pod still on the previous release reads only the plain name, so
        // while the fallback is on the session is mirrored there too, or a visitor who signed in
        // on a new pod would look signed out on an old one. New pods read `__Host-` first and
        // ignore the mirror, so it adds nothing a tossed cookie could use.
        cookieStore.set(AUTH_COOKIE_NAME, encryptedToken, cookieOptions);
    } else if (cookieStore.get(AUTH_COOKIE_NAME)) {
        // Fallback off: no plain-name cookie is written, and a left-over one is expired.
        cookieStore.set(AUTH_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
    }
}

/**
 * The sealed session cookie's value: the `__Host-` one when it exists (a plain-name cookie next to
 * it is ignored, whoever planted it), else, while the fallback is on, a legacy plain-name one.
 * Reads only: the proxy moves a legacy cookie to the new name (`reconcileLegacyAuthCookie`), since a
 * render cannot write cookies.
 */
async function readSealedAuthCookie(): Promise<string | undefined> {
    const cookieStore = await cookies();
    const current = cookieStore.get(authCookieName())?.value;
    if (current) return current;
    if (!legacyAuthCookieFallbackEnabled()) return undefined;
    const legacy = cookieStore.get(AUTH_COOKIE_NAME)?.value;
    if (!legacy) return undefined;
    // Never trust a plain session name that appears more than once (a tossed Domain cookie next to
    // the visitor's own): which one the cookie API kept is not ours to choose. Fail closed when the
    // raw header cannot be read.
    try {
        const raw = (await headers()).get('cookie');
        return countCookieName(raw, AUTH_COOKIE_NAME) === 1 ? legacy : undefined;
    } catch {
        return undefined;
    }
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

type RequestCookieReader = {
    cookies: { get(name: string): { value: string } | undefined };
    headers: { get(name: string): string | null };
};
type ResponseCookieWriter = {
    cookies: { set(name: string, value: string, options?: Partial<ResponseCookie>): unknown };
};

/**
 * What the proxy does with the plain session name for a request the auth gate let through
 * (the only place a page request can write cookies):
 *
 * - `migrated`: while the fallback is on and there is no `__Host-` cookie yet, the same sealed
 *   value is copied to `__Host-everworks_auth_token`. The plain cookie is KEPT: a pod still on
 *   the previous release (rolling deploy) reads only the plain name. Once the `__Host-` cookie
 *   exists, new pods ignore the plain one. Never when the plain name appears more than once.
 * - `expired`: once the fallback is over (end date or flag) on HTTPS, a left-over host-only plain
 *   cookie is expired. (A tossed `Domain=` one cannot be cleared from here; it is ignored.)
 * - `none`: nothing to do.
 */
export function reconcileLegacyAuthCookie(
    request: RequestCookieReader,
    response: ResponseCookieWriter,
): 'migrated' | 'expired' | 'none' {
    if (!response.cookies) return 'none';
    const name = authCookieName();
    if (name === AUTH_COOKIE_NAME) return 'none';
    const legacy = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    if (!legacyAuthCookieFallbackEnabled()) {
        if (!legacy) return 'none';
        response.cookies.set(AUTH_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
        return 'expired';
    }
    if (request.cookies.get(name)?.value) return 'none';
    if (!legacy) return 'none';
    if (countCookieName(request.headers.get('cookie'), AUTH_COOKIE_NAME) !== 1) return 'none';
    response.cookies.set(name, legacy, cookieOptions);
    return 'migrated';
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
