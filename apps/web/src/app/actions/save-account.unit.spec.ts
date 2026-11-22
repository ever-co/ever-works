import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `saveAnonymousAccount` — the web half of EW-617 G3. It must call `POST /auth/claim` (which
 * keeps the SAME user, so the Works stay) and never `/auth/register` (a second account that
 * leaves the Works behind), with the same rules registration enforces, store the session the
 * API rotated to, and never pass the upstream error text through.
 *
 * `getTranslations` echoes its key, so each branch is identified by the key it returns.
 */

const mocks = vi.hoisted(() => ({
    claimAccount: vi.fn(),
    register: vi.fn(),
    redirect: vi.fn(),
    refresh: vi.fn(),
    revalidatePath: vi.fn(),
    setAuthCookies: vi.fn(),
    getOAuthAuthUrl: vi.fn(),
    setOAuthStateCookie: vi.fn(),
    setOAuthSaveAccountCookie: vi.fn(),
}));

vi.mock('next/cache', () => ({ refresh: mocks.refresh, revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/api', () => ({
    authAPI: {
        claimAccount: mocks.claimAccount,
        register: mocks.register,
        getOAuthAuthUrl: mocks.getOAuthAuthUrl,
    },
}));
vi.mock('@/lib/auth/cookies', () => ({
    setOAuthStateCookie: mocks.setOAuthStateCookie,
    setOAuthSaveAccountCookie: mocks.setOAuthSaveAccountCookie,
}));
vi.mock('@/lib/auth', () => ({ setAuthCookies: mocks.setAuthCookies }));
vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));

import { ApiResponseError } from '@/lib/api/server-api';
import {
    saveAnonymousAccount,
    startSavingWithProvider,
    type SaveAccountInput,
} from './save-account';
import { OAuthProvider } from '@/lib/api/enums';

const TERMS = [
    { documentId: 'tos:default', version: '2026-01-01', sha256: 'a'.repeat(64), locale: 'en' },
];

const input = (overrides: Partial<SaveAccountInput> = {}): SaveAccountInput => ({
    email: 'jane@example.com',
    password: 'MySecure123!',
    terms: TERMS,
    ...overrides,
});

describe('saveAnonymousAccount', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.claimAccount.mockResolvedValue({
            id: 'u-anon-1',
            email: 'jane@example.com',
            username: 'jane',
            emailVerified: false,
            access_token: 'fresh-token',
        });
    });

    it('claims THIS account (never registers a new one) with the terms the form showed', async () => {
        await saveAnonymousAccount(input({ email: ' jane@example.com ' }));

        expect(mocks.register).not.toHaveBeenCalled();
        expect(mocks.claimAccount).toHaveBeenCalledWith({
            email: 'jane@example.com',
            password: 'MySecure123!',
            terms: TERMS,
            emailVerificationCallbackUrl: expect.stringContaining('/api/auth/verify-email'),
        });
    });

    it('sends a typed username (trimmed), and none when it is left empty', async () => {
        await saveAnonymousAccount(input({ username: '  jane-doe ' }));
        expect(mocks.claimAccount.mock.calls[0][0]).toMatchObject({ username: 'jane-doe' });

        await saveAnonymousAccount(input({ username: '   ' }));
        expect(mocks.claimAccount.mock.calls[1][0]).not.toHaveProperty('username');
    });

    // The anonymous session ends with the anonymous TTL; the API rotates it on claim.
    it('stores the session the API rotated to, before redirecting', async () => {
        const order: string[] = [];
        mocks.setAuthCookies.mockImplementation(async () => order.push('cookie'));
        mocks.redirect.mockImplementation(() => order.push('redirect'));

        await saveAnonymousAccount(input());

        expect(mocks.setAuthCookies).toHaveBeenCalledWith('fresh-token');
        expect(order).toEqual(['cookie', 'redirect']);
    });

    it('keeps the current cookie when the API could not issue a fresh session', async () => {
        mocks.claimAccount.mockResolvedValue({
            id: 'u',
            email: 'jane@example.com',
            username: 'jane',
            emailVerified: false,
        });

        await saveAnonymousAccount(input());

        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
        expect(mocks.redirect).toHaveBeenCalled();
    });

    it('lands on the dashboard with the saved notice and the unconfirmed-email notice', async () => {
        await saveAnonymousAccount(input());

        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/?accountSaved=true&verifyEmail=required',
        });
    });

    // Seen on the local stack: the strip lives in the dashboard layout, which the redirect
    // reused from the router cache, so it stayed on screen after saving until a reload.
    it("refreshes this visitor's view before redirecting, never every route's cache", async () => {
        const order: string[] = [];
        mocks.refresh.mockImplementation(() => order.push('refresh'));
        mocks.redirect.mockImplementation(() => order.push('redirect'));

        await saveAnonymousAccount(input());

        expect(order).toEqual(['refresh', 'redirect']);
        expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it('refreshes nothing and stores nothing when the save fails', async () => {
        mocks.claimAccount.mockRejectedValue(new ApiResponseError('taken', 409));

        await saveAnonymousAccount(input());

        expect(mocks.refresh).not.toHaveBeenCalled();
        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
    });

    it('leaves the email notice off when the address is already confirmed', async () => {
        mocks.claimAccount.mockResolvedValue({
            id: 'u',
            email: 'a@b.co',
            username: 'u',
            emailVerified: true,
        });

        await saveAnonymousAccount(input({ email: 'a@b.co' }));

        expect(mocks.redirect).toHaveBeenCalledWith({ locale: 'en', href: '/?accountSaved=true' });
    });

    it.each([
        ['an invalid email', { email: 'nope' }, 'email', 'email.invalid'],
        ['a short password', { password: 'short1' }, 'password', 'password.minLength'],
        ['no lowercase letter', { password: 'ABCDEFG123' }, 'password', 'password.lowercase'],
        ['a 2-character username', { username: 'jd' }, 'username', 'usernameTooShort'],
        ['a username with nothing usable', { username: '!!!' }, 'username', 'usernameTooShort'],
        ['no terms', { terms: [] }, 'terms', 'terms.required'],
    ])('refuses %s before calling the API', async (_label, overrides, field, key) => {
        const result = await saveAnonymousAccount(input(overrides as Partial<SaveAccountInput>));

        expect(result).toEqual({ success: false, error: key, field });
        expect(mocks.claimAccount).not.toHaveBeenCalled();
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it.each([
        [409, { error: 'emailTaken', field: 'email' }],
        [403, { error: 'notTemporary' }],
        [429, { error: 'tooManyAttempts' }],
        [400, { error: 'rejected' }],
        [500, { error: 'generic' }],
    ])('maps an API %i to its own words, never the upstream text', async (status, expected) => {
        mocks.claimAccount.mockRejectedValue(
            new ApiResponseError('Email is already in use by another account (pg detail)', status),
        );

        const result = await saveAnonymousAccount(input());

        expect(result).toEqual({ success: false, ...expected });
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('says a taken username belongs to the username field, with the free suggestion', async () => {
        mocks.claimAccount.mockRejectedValue(
            new ApiResponseError('Username is already taken', 409, 'username_taken', {
                suggestion: 'jane-doe-2',
            }),
        );

        await expect(saveAnonymousAccount(input({ username: 'jane-doe' }))).resolves.toEqual({
            success: false,
            error: 'usernameTakenWithSuggestion',
            field: 'username',
        });
    });

    it('sends the normalized handle the API would make of it', async () => {
        await saveAnonymousAccount(input({ username: 'Jane Doe' }));

        expect(mocks.claimAccount.mock.calls[0][0]).toMatchObject({ username: 'jane-doe' });
    });

    it("puts the API's username refusal (400) on the username field", async () => {
        mocks.claimAccount.mockRejectedValue(
            new ApiResponseError('Username must be at least 3 characters', 400),
        );

        await expect(saveAnonymousAccount(input({ username: 'abc' }))).resolves.toEqual({
            success: false,
            error: 'usernameTooShort',
            field: 'username',
        });
    });

    // Review of #3300: once the API answered 200 the account IS saved. A failure to store the
    // rotated session must not read as "try again" (a retry would only meet the revoked one).
    it('treats a saved account whose cookie cannot be stored as saved: off to sign in', async () => {
        mocks.setAuthCookies.mockRejectedValue(new Error('cookies() unavailable'));

        await saveAnonymousAccount(input());

        expect(mocks.redirect).toHaveBeenCalledTimes(1);
        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/login?accountSaved=true',
        });
        expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it('tells an ended temporary session apart from "try again"', async () => {
        mocks.claimAccount.mockRejectedValue(new ApiResponseError('Unauthorized', 401));

        await expect(saveAnonymousAccount(input())).resolves.toEqual({
            success: false,
            error: 'sessionEnded',
            reason: 'session_ended',
        });
    });

    it('treats a network failure as the generic error', async () => {
        mocks.claimAccount.mockRejectedValue(new TypeError('fetch failed'));

        await expect(saveAnonymousAccount(input())).resolves.toEqual({
            success: false,
            error: 'generic',
        });
    });
});

/**
 * `startSavingWithProvider` — the start of saving with GitHub / Google (EW-617). It must start
 * the SAME C-03 round trip as sign-in, and mark it as a save bound to that very state, with the
 * terms the form showed, so the callback attaches the identity to this account.
 */
describe('startSavingWithProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getOAuthAuthUrl.mockResolvedValue({
            url: 'https://github.com/login/oauth/authorize?state=s-1',
            state: 's-1',
        });
    });

    it('mirrors the state and binds the save intent, with the terms, to that state', async () => {
        const result = await startSavingWithProvider(OAuthProvider.GITHUB, TERMS);

        expect(result).toEqual({
            success: true,
            url: 'https://github.com/login/oauth/authorize?state=s-1',
        });
        expect(mocks.getOAuthAuthUrl).toHaveBeenCalledWith('github');
        expect(mocks.setOAuthStateCookie).toHaveBeenCalledWith('s-1');
        expect(mocks.setOAuthSaveAccountCookie).toHaveBeenCalledWith({
            state: 's-1',
            terms: TERMS,
        });
    });

    it('refuses to start without the terms, before asking the API', async () => {
        const result = await startSavingWithProvider(OAuthProvider.GOOGLE, []);

        expect(result).toEqual({ success: false, error: 'terms.required', field: 'terms' });
        expect(mocks.getOAuthAuthUrl).not.toHaveBeenCalled();
        expect(mocks.setOAuthSaveAccountCookie).not.toHaveBeenCalled();
    });

    it('offers only GitHub and Google', async () => {
        const result = await startSavingWithProvider(OAuthProvider.FACEBOOK, TERMS);

        expect(result).toEqual({ success: false, error: 'providerFailed' });
        expect(mocks.getOAuthAuthUrl).not.toHaveBeenCalled();
    });

    it('answers its own words when the API cannot start the round trip, and sets nothing', async () => {
        mocks.getOAuthAuthUrl.mockRejectedValue(new ApiResponseError('client id missing', 400));

        const result = await startSavingWithProvider(OAuthProvider.GITHUB, TERMS);

        expect(result).toEqual({ success: false, error: 'providerFailed' });
        expect(mocks.setOAuthStateCookie).not.toHaveBeenCalled();
        expect(mocks.setOAuthSaveAccountCookie).not.toHaveBeenCalled();
    });
});
