import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `saveAnonymousAccount` — the web half of EW-617 G3. It must call `POST /auth/claim` (which
 * keeps the SAME user, so the Works stay) and never `/auth/register` (a second account that
 * leaves the Works behind), with the same rules registration enforces, and must never pass
 * the upstream error text through.
 *
 * `getTranslations` echoes its key, so each branch is identified by the key it returns.
 */

const mocks = vi.hoisted(() => ({
    claimAccount: vi.fn(),
    register: vi.fn(),
    redirect: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
    authAPI: { claimAccount: mocks.claimAccount, register: mocks.register },
}));
vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));

import { ApiResponseError } from '@/lib/api/server-api';
import { saveAnonymousAccount } from './save-account';

const TERMS = [
    { documentId: 'tos:default', version: '2026-01-01', sha256: 'a'.repeat(64), locale: 'en' },
];

describe('saveAnonymousAccount', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.claimAccount.mockResolvedValue({
            id: 'u-anon-1',
            email: 'jane@example.com',
            username: 'anon-deadbeef',
            emailVerified: false,
        });
    });

    it('claims THIS account (never registers a new one) with the terms the form showed', async () => {
        await saveAnonymousAccount(' jane@example.com ', 'MySecure123!', TERMS);

        expect(mocks.register).not.toHaveBeenCalled();
        expect(mocks.claimAccount).toHaveBeenCalledWith({
            email: 'jane@example.com',
            password: 'MySecure123!',
            terms: TERMS,
            emailVerificationCallbackUrl: expect.stringContaining('/api/auth/verify-email'),
        });
    });

    it('lands on the dashboard with the saved notice and the unconfirmed-email notice', async () => {
        await saveAnonymousAccount('jane@example.com', 'MySecure123!', TERMS);

        expect(mocks.redirect).toHaveBeenCalledWith({
            locale: 'en',
            href: '/?accountSaved=true&verifyEmail=required',
        });
    });

    it('leaves the email notice off when the address is already confirmed', async () => {
        mocks.claimAccount.mockResolvedValue({
            id: 'u',
            email: 'a@b.co',
            username: 'u',
            emailVerified: true,
        });

        await saveAnonymousAccount('a@b.co', 'MySecure123!', TERMS);

        expect(mocks.redirect).toHaveBeenCalledWith({ locale: 'en', href: '/?accountSaved=true' });
    });

    it.each([
        ['an invalid email', 'nope', 'MySecure123!', TERMS, 'email', 'email.invalid'],
        ['a short password', 'a@b.co', 'short1', TERMS, 'password', 'password.minLength'],
        ['no lowercase letter', 'a@b.co', 'ABCDEFG123', TERMS, 'password', 'password.lowercase'],
        ['no terms', 'a@b.co', 'MySecure123!', [], 'terms', 'terms.required'],
    ])('refuses %s before calling the API', async (_label, email, password, terms, field, key) => {
        const result = await saveAnonymousAccount(email, password, terms);

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

        const result = await saveAnonymousAccount('jane@example.com', 'MySecure123!', TERMS);

        expect(result).toEqual({ success: false, ...expected });
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('treats a network failure as the generic error', async () => {
        mocks.claimAccount.mockRejectedValue(new TypeError('fetch failed'));

        await expect(
            saveAnonymousAccount('jane@example.com', 'MySecure123!', TERMS),
        ).resolves.toEqual({ success: false, error: 'generic' });
    });
});
