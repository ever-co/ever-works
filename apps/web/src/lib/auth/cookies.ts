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

export async function setOAuthStateCookie(state: string) {
    const cookieStore = await cookies();
    cookieStore.set('oauth_state', state, {
        ...cookieOptions,
        maxAge: 60 * 10, // 10 minute expiry
    });
}

export async function getOAuthStateCookie() {
    const cookieStore = await cookies();
    return cookieStore.get('oauth_state')?.value;
}

export async function removeOAuthStateCookie() {
    const cookieStore = await cookies();
    cookieStore.delete('oauth_state');
}

// =================
// OAuth — saving a temporary account (EW-617)
// =================

/** HttpOnly cookie that marks an OAuth round trip started on `/save-account`. */
export const OAUTH_SAVE_ACCOUNT_COOKIE_NAME = 'oauth_save_account';

/**
 * What the save-account page hands to the OAuth callback: the `state` of the round trip it
 * started, and the legal documents the visitor ticked the box for, exactly as displayed.
 */
export interface OAuthSaveAccountIntent {
    state: string;
    terms: Array<{ documentId: string; version: string; sha256: string; locale: string }>;
}

export async function setOAuthSaveAccountCookie(intent: OAuthSaveAccountIntent) {
    const cookieStore = await cookies();
    cookieStore.set(
        OAUTH_SAVE_ACCOUNT_COOKIE_NAME,
        Buffer.from(JSON.stringify(intent), 'utf8').toString('base64url'),
        { ...cookieOptions, maxAge: 60 * 10 }, // the same 10 minutes as `oauth_state`
    );
}

/** The intent, or null when absent or not in the shape `setOAuthSaveAccountCookie` writes. */
export async function getOAuthSaveAccountCookie(): Promise<OAuthSaveAccountIntent | null> {
    const cookieStore = await cookies();
    const raw = cookieStore.get(OAUTH_SAVE_ACCOUNT_COOKIE_NAME)?.value;
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        const { state, terms } = parsed as Record<string, unknown>;
        if (typeof state !== 'string' || !state || !Array.isArray(terms)) {
            return null;
        }
        return { state, terms: terms as OAuthSaveAccountIntent['terms'] };
    } catch {
        return null;
    }
}

export async function removeOAuthSaveAccountCookie() {
    const cookieStore = await cookies();
    cookieStore.delete(OAUTH_SAVE_ACCOUNT_COOKIE_NAME);
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
