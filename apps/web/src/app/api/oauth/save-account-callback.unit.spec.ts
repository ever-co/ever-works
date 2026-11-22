import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    getOAuthSaveAccountCookie: vi.fn(),
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
    getOAuthSaveAccountCookie: mocks.getOAuthSaveAccountCookie,
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
        mocks.getOAuthSaveAccountCookie.mockResolvedValue({ state: 's-1', terms: TERMS });

        await handleOAuthCallback(callbackRequest('s-1'), 'github');

        expect(mocks.claimAccountWithOAuth).toHaveBeenCalledWith('github', {
            code: 'code-1',
            state: 's-1',
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
        mocks.getOAuthSaveAccountCookie.mockResolvedValue({ state: 'old-state', terms: TERMS });

        await handleOAuthCallback(callbackRequest('s-1'), 'github');

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.connectOAuthCallback).toHaveBeenCalledWith('github', 'code-1', 's-1');
        // The stale intent is cleared, so it cannot match a later round trip either.
        expect(mocks.removeOAuthSaveAccountCookie).toHaveBeenCalled();
    });

    it('signs in as before when there is no save intent', async () => {
        mocks.getOAuthSaveAccountCookie.mockResolvedValue(null);

        await handleOAuthCallback(callbackRequest('s-1'), 'google');

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.connectOAuthCallback).toHaveBeenCalledWith('google', 'code-1', 's-1');
        expect(mocks.removeOAuthSaveAccountCookie).not.toHaveBeenCalled();
    });

    it('checks the state before anything else, save or not', async () => {
        mocks.getOAuthSaveAccountCookie.mockResolvedValue({ state: 'forged', terms: TERMS });

        await handleOAuthCallback(callbackRequest('forged'), 'github');

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/auth/error?error=oauth_invalid_state',
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
            { state: 's', terms: TERMS },
            'en',
        );

        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/?accountSaved=true&savedWith=google&verifyEmail=required',
        });
    });

    it('re-reads the layout so the strip goes at once, then redirects', async () => {
        const order: string[] = [];
        mocks.claimAccountWithOAuth.mockResolvedValue({
            access_token: 't',
            user: { id: 'a', email: 'v@x.co', username: 'a', emailVerified: true },
        });
        mocks.revalidatePath.mockImplementation(() => order.push('revalidate'));
        mocks.redirect.mockImplementation(() => order.push('redirect'));

        await saveAccountWithOAuth(
            OAuthProvider.GITHUB,
            'c',
            's',
            { state: 's', terms: TERMS },
            'en',
        );

        expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
        expect(order).toEqual(['revalidate', 'redirect']);
    });

    it.each([
        [new ApiResponseError('linked', 409, 'PROVIDER_ACCOUNT_ALREADY_LINKED'), 'identity_taken'],
        [new ApiResponseError('email', 409, 'EMAIL_ALREADY_IN_USE'), 'email_taken'],
        [new ApiResponseError('conflict', 409), 'identity_taken'],
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
            { state: 's', terms: TERMS },
            'en',
        );

        expect(saveAccountOAuthErrorFor(error)).toBe(expected);
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: `/save-account?oauthError=${expected}&provider=github`,
        });
        // A refused save keeps the anonymous session and re-reads nothing.
        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
        expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it('never posts a provider the page does not offer', async () => {
        await saveAccountWithOAuth(
            OAuthProvider.LINKEDIN,
            'c',
            's',
            { state: 's', terms: TERMS },
            'en',
        );

        expect(mocks.claimAccountWithOAuth).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/save-account?oauthError=failed',
        });
    });
});
