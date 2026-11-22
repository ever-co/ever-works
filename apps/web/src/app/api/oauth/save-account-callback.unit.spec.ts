import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EW-617 — the OAuth callback half of saving a temporary account with GitHub / Google.
 *
 * `handleOAuthCallback` must send a round trip started on `/save-account` to
 * `POST /oauth/:p/claim` (which keeps the SAME user, so the Works stay) and never to the
 * sign-in exchange (which opens or creates another account); and only when the save intent
 * names the state of THIS round trip. A refused save goes back to `/save-account` with our own
 * error name, never the upstream text.
 */

const mocks = vi.hoisted(() => ({
    claimAccountWithOAuth: vi.fn(),
    connectOAuthCallback: vi.fn(),
    redirect: vi.fn(),
    revalidatePath: vi.fn(),
    setAuthCookies: vi.fn(),
    getOAuthStateCookie: vi.fn(),
    removeOAuthStateCookie: vi.fn(),
    readOAuthSaveAccountCookie: vi.fn(),
    removeOAuthSaveAccountCookie: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/api', async () => {
    const { ApiResponseError } = await import('@/lib/api/server-api');
    return {
        ApiResponseError,
        authAPI: {
            claimAccountWithOAuth: mocks.claimAccountWithOAuth,
            connectOAuthCallback: mocks.connectOAuthCallback,
        },
    };
});
vi.mock('@/lib/auth/cookies', () => ({ setAuthCookies: mocks.setAuthCookies }));
vi.mock('@/lib/auth', () => ({
    getOAuthStateCookie: mocks.getOAuthStateCookie,
    removeOAuthStateCookie: mocks.removeOAuthStateCookie,
    readOAuthSaveAccountCookie: mocks.readOAuthSaveAccountCookie,
    removeOAuthSaveAccountCookie: mocks.removeOAuthSaveAccountCookie,
    setAuthCookies: mocks.setAuthCookies,
}));
vi.mock('@/lib/auth/redirect', () => ({
    getRedirectUrl: async (_auth: unknown, href: string) => href,
}));
vi.mock('@/lib/auth/github-connect', () => ({
    addConnectGithubParam: (href: string) => href,
    isDashboardHref: () => false,
    shouldPromptGithubConnect: async () => false,
}));

import { ApiResponseError } from '@/lib/api/server-api';
import { OAuthProvider } from '@/lib/api/enums';
import { handleOAuthCallback } from './oauth-callback-handler';
import { saveAccountOAuthErrorFor, saveAccountWithOAuth } from './save-account-callback';

const TERMS = [
    { documentId: 'tos:default', version: '2026-01-01', sha256: 'a'.repeat(64), locale: 'en' },
];

/** A save intent this server sealed for the signed-in temporary account `anon-1`. */
const sealed = (state: string) => ({
    status: 'valid' as const,
    intent: { state, terms: TERMS, userId: 'anon-1' },
});

const callbackRequest = (state: string) =>
    ({
        nextUrl: { searchParams: new URLSearchParams({ code: 'code-1', state }) },
    }) as never;

describe('handleOAuthCallback routes a save-account round trip to the save', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getOAuthStateCookie.mockResolvedValue('s-1');
        mocks.claimAccountWithOAuth.mockResolvedValue({
            access_token: 'regular-session',
            user: { id: 'anon-1', email: 'v@x.co', username: 'anon-1', emailVerified: true },
        });
        mocks.connectOAuthCallback.mockResolvedValue({ access_token: 'other-account' });
    });

    it('saves THIS account when the intent names this state, and never signs in', async () => {
        mocks.readOAuthSaveAccountCookie.mockResolvedValue(sealed('s-1'));

        await handleOAuthCallback(callbackRequest('s-1'), 'github');

        expect(mocks.claimAccountWithOAuth).toHaveBeenCalledWith('github', {
            code: 'code-1',
            state: 's-1',
            // The account the sealed intent names; the API refuses any other session.
            expectedUserId: 'anon-1',
            terms: TERMS,
            emailVerificationCallbackUrl: expect.stringContaining('/api/auth/verify-email'),
        });
        expect(mocks.connectOAuthCallback).not.toHaveBeenCalled();
        expect(mocks.removeOAuthSaveAccountCookie).toHaveBeenCalled();
        expect(mocks.setAuthCookies).toHaveBeenCalledWith('regular-session');
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/?accountSaved=true&savedWith=github',
        });
    });

    it('signs in as before when an abandoned save names another state', async () => {
        mocks.readOAuthSaveAccountCookie.mockResolvedValue(sealed('old-state'));

        await handleOAuthCallback(callbackRequest('s-1'), 'github');

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.connectOAuthCallback).toHaveBeenCalledWith('github', 'code-1', 's-1');
        // The stale intent is cleared, so it cannot match a later round trip either.
        expect(mocks.removeOAuthSaveAccountCookie).toHaveBeenCalled();
    });

    it('signs in as before when there is no save intent', async () => {
        mocks.readOAuthSaveAccountCookie.mockResolvedValue({ status: 'none' });

        await handleOAuthCallback(callbackRequest('s-1'), 'google');

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.connectOAuthCallback).toHaveBeenCalledWith('google', 'code-1', 's-1');
        expect(mocks.removeOAuthSaveAccountCookie).not.toHaveBeenCalled();
    });

    // R56: a Work on a sibling subdomain plants oauth_state=S and a save intent of its own,
    // then sends the victim to the callback with the attacker's code. The intent is not sealed
    // by this server, so nothing is saved, and the attacker's code is not used to sign in either.
    it('never claims, and never signs in, with a save cookie this server did not seal', async () => {
        mocks.readOAuthSaveAccountCookie.mockResolvedValue({ status: 'invalid' });

        await handleOAuthCallback(callbackRequest('s-1'), 'github');

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.connectOAuthCallback).not.toHaveBeenCalled();
        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
        expect(mocks.removeOAuthSaveAccountCookie).toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/auth/error?error=oauth_invalid_state',
        });
    });

    it('checks the state before anything else, save or not', async () => {
        mocks.readOAuthSaveAccountCookie.mockResolvedValue(sealed('forged'));

        await handleOAuthCallback(callbackRequest('forged'), 'github');

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/auth/error?error=oauth_invalid_state',
        });
    });
});

describe('handleOAuthCallback: a refused sign-in', () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        // `loginOauth` logs the cause; keep the run quiet.
        consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.getOAuthStateCookie.mockResolvedValue('s-1');
        mocks.readOAuthSaveAccountCookie.mockResolvedValue({ status: 'none' });
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    // The API refuses to link a verified Google / GitHub sign-in into an existing account whose
    // own email was never verified (pre-hijacking guard): its own message, and no session.
    it('lands on its own error when the existing account email is unverified', async () => {
        mocks.connectOAuthCallback.mockRejectedValue(
            new ApiResponseError('unverified', 409, 'EXISTING_ACCOUNT_EMAIL_UNVERIFIED'),
        );

        await handleOAuthCallback(callbackRequest('s-1'), 'google');

        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/auth/error?error=oauth_existing_account_unverified',
        });
    });

    it('keeps the provider-conflict error for any other 409', async () => {
        mocks.connectOAuthCallback.mockRejectedValue(new ApiResponseError('conflict', 409));

        await handleOAuthCallback(callbackRequest('s-1'), 'github');

        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/auth/error?error=oauth_provider_conflict',
        });
    });
});

describe('saveAccountWithOAuth', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('adds the unconfirmed-email notice when the provider did not vouch for the address', async () => {
        mocks.claimAccountWithOAuth.mockResolvedValue({
            access_token: 't',
            user: { id: 'anon-1', email: 'v@x.co', username: 'anon-1', emailVerified: false },
        });

        await saveAccountWithOAuth(
            OAuthProvider.GOOGLE,
            'c',
            's',
            { state: 's', terms: TERMS, userId: 'anon-1' },
            'en',
        );

        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/?accountSaved=true&savedWith=google&verifyEmail=required',
        });
    });

    it('keeps the anonymous cookie when the API kept the anonymous session (no token)', async () => {
        mocks.claimAccountWithOAuth.mockResolvedValue({
            user: { id: 'a', email: 'v@x.co', username: 'visitor', emailVerified: true },
        });

        await saveAccountWithOAuth(
            OAuthProvider.GITHUB,
            'c',
            's',
            { state: 's', terms: TERMS, userId: 'anon-1' },
            'en',
        );

        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/?accountSaved=true&savedWith=github',
        });
    });

    it('sends a saved visitor whose new cookie could not be set to sign in, never to retry', async () => {
        mocks.claimAccountWithOAuth.mockResolvedValue({
            access_token: 'fresh',
            user: { id: 'a', email: 'v@x.co', username: 'visitor', emailVerified: true },
        });
        mocks.setAuthCookies.mockRejectedValueOnce(new Error('cookies() unavailable'));

        await saveAccountWithOAuth(
            OAuthProvider.GITHUB,
            'c',
            's',
            { state: 's', terms: TERMS, userId: 'anon-1' },
            'en',
        );

        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/login?accountSaved=true&savedWith=github',
        });
    });

    it('sends an ended temporary session (401) to sign in: there is nothing left to save', async () => {
        mocks.claimAccountWithOAuth.mockRejectedValue(new ApiResponseError('Unauthorized', 401));

        await saveAccountWithOAuth(
            OAuthProvider.GITHUB,
            'c',
            's',
            { state: 's', terms: TERMS, userId: 'anon-1' },
            'en',
        );

        expect(mocks.redirect).toHaveBeenCalledWith({ locale: 'en', href: '/login' });
    });

    it('drops no cache: the callback is a full navigation, so the dashboard renders fresh', async () => {
        mocks.claimAccountWithOAuth.mockResolvedValue({
            access_token: 't',
            user: { id: 'a', email: 'v@x.co', username: 'a', emailVerified: true },
        });

        await saveAccountWithOAuth(
            OAuthProvider.GITHUB,
            'c',
            's',
            { state: 's', terms: TERMS, userId: 'anon-1' },
            'en',
        );

        expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it.each([
        [new ApiResponseError('linked', 409, 'PROVIDER_ACCOUNT_ALREADY_LINKED'), 'identity_taken'],
        [new ApiResponseError('email', 409, 'EMAIL_ALREADY_IN_USE'), 'email_taken'],
        [new ApiResponseError('conflict', 409), 'identity_taken'],
        [new ApiResponseError('handle', 409, 'username_taken'), 'failed'],
        [new ApiResponseError('other', 409, 'OTHER_PROVIDER_ACCOUNT_CONNECTED'), 'other_identity'],
        [new ApiResponseError('terms store down', 503), 'failed'],
        [new ApiResponseError('not anonymous', 403), 'not_temporary'],
        [new ApiResponseError('slow down', 429), 'too_many_attempts'],
        [new ApiResponseError('invalid_grant', 400), 'rejected'],
        [new ApiResponseError('boom', 500), 'failed'],
        [new TypeError('fetch failed'), 'failed'],
    ])('sends a refused save back to /save-account as %s → %s', async (error, expected) => {
        mocks.claimAccountWithOAuth.mockRejectedValue(error);

        await saveAccountWithOAuth(
            OAuthProvider.GITHUB,
            'c',
            's',
            { state: 's', terms: TERMS, userId: 'anon-1' },
            'en',
        );

        expect(saveAccountOAuthErrorFor(error)).toBe(expected);
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: `/save-account?oauthError=${expected}&provider=github`,
        });
        // A refused save keeps the anonymous session.
        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
    });

    it('never posts a provider the page does not offer', async () => {
        await saveAccountWithOAuth(
            OAuthProvider.LINKEDIN,
            'c',
            's',
            { state: 's', terms: TERMS, userId: 'anon-1' },
            'en',
        );

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/save-account?oauthError=failed',
        });
    });
});
