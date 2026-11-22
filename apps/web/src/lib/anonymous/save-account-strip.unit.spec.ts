import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@/lib/api/auth';

const mocks = vi.hoisted(() => ({
    getDemoConfig: vi.fn(),
    getFreshProfile: vi.fn(),
    getAuthFromRequest: vi.fn(),
}));

vi.mock('@/lib/feature-flags/demo', () => ({ getDemoConfig: mocks.getDemoConfig }));
vi.mock('@/lib/api/auth', () => ({ authAPI: { getFreshProfile: mocks.getFreshProfile } }));
vi.mock('@/lib/auth/middleware', () => ({ getAuthFromRequest: mocks.getAuthFromRequest }));

import {
    buildSaveAccountStrip,
    getSaveAccountStripForRequest,
    hasSavableAnonymousSession,
} from './save-account-strip';

const EXPIRES = '2026-11-24T22:30:45.000Z';

const anonymous: Partial<UserProfile> = {
    isAnonymous: true,
    anonymousExpiresAt: EXPIRES,
    registrationProvider: 'anonymous',
    demo: null,
};

describe('buildSaveAccountStrip — who sees the temporary-account strip', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
    });

    it('shows it to an anonymous account, with the real expiry', async () => {
        await expect(buildSaveAccountStrip(anonymous)).resolves.toEqual({ expiresAt: EXPIRES });
    });

    it('keeps showing it without a known expiry (the strip then prints no countdown)', async () => {
        await expect(
            buildSaveAccountStrip({ ...anonymous, anonymousExpiresAt: null }),
        ).resolves.toEqual({ expiresAt: null });
    });

    it.each([
        ['a registered account', { ...anonymous, isAnonymous: false, anonymousExpiresAt: null }],
        ['a profile without the field', { registrationProvider: 'local' }],
        ['a profile that could not be read', null],
        ['no profile at all', undefined],
    ])('never shows it to %s, and asks nothing', async (_label, profile) => {
        await expect(
            buildSaveAccountStrip(profile as Partial<UserProfile> | null | undefined),
        ).resolves.toBeNull();
        expect(mocks.getDemoConfig).not.toHaveBeenCalled();
    });

    it('never shows it to a demo sandbox (its own strip covers sign-up), without asking', async () => {
        const sandbox = {
            ...anonymous,
            registrationProvider: 'demo',
            demo: { expiresAt: EXPIRES, aiQuotaExhausted: false, recordedGoalId: null },
        };

        await expect(buildSaveAccountStrip(sandbox)).resolves.toBeNull();
        await expect(buildSaveAccountStrip({ ...sandbox, demo: null })).resolves.toBeNull();
        expect(mocks.getDemoConfig).not.toHaveBeenCalled();
    });

    it('never shows it on a demo instance, even to a plain anonymous account', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: true });

        await expect(buildSaveAccountStrip(anonymous)).resolves.toBeNull();
    });
});

describe('hasSavableAnonymousSession — the /register guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        mocks.getAuthFromRequest.mockResolvedValue({ isAuthenticated: true, isExpired: false });
    });

    it('is false for a signed-out visitor, without reading the profile', async () => {
        mocks.getAuthFromRequest.mockResolvedValue({ isAuthenticated: false, isExpired: false });

        await expect(hasSavableAnonymousSession()).resolves.toBe(false);
        expect(mocks.getFreshProfile).not.toHaveBeenCalled();
    });

    it('is true for a signed-in anonymous account', async () => {
        mocks.getFreshProfile.mockResolvedValue(anonymous);

        await expect(hasSavableAnonymousSession()).resolves.toBe(true);
    });

    it('is false for a registered account and when the profile cannot be read', async () => {
        mocks.getFreshProfile.mockResolvedValueOnce({ ...anonymous, isAnonymous: false });
        await expect(hasSavableAnonymousSession()).resolves.toBe(false);

        mocks.getFreshProfile.mockRejectedValueOnce(new Error('down'));
        await expect(hasSavableAnonymousSession()).resolves.toBe(false);
    });
});

describe('getSaveAccountStripForRequest — the strip on pages outside the dashboard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
    });

    it('is null for a signed-out visitor (or an expired cookie), without asking the API', async () => {
        mocks.getAuthFromRequest.mockResolvedValueOnce({
            isAuthenticated: false,
            isExpired: false,
        });
        await expect(getSaveAccountStripForRequest()).resolves.toBeNull();
        mocks.getAuthFromRequest.mockResolvedValueOnce({ isAuthenticated: true, isExpired: true });
        await expect(getSaveAccountStripForRequest()).resolves.toBeNull();
        expect(mocks.getFreshProfile).not.toHaveBeenCalled();
    });

    it('answers the strip for an anonymous session, under the dashboard rules', async () => {
        mocks.getAuthFromRequest.mockResolvedValue({ isAuthenticated: true, isExpired: false });
        mocks.getFreshProfile.mockResolvedValue(anonymous);

        await expect(getSaveAccountStripForRequest()).resolves.toEqual({ expiresAt: EXPIRES });

        mocks.getDemoConfig.mockResolvedValue({ enabled: true });
        await expect(getSaveAccountStripForRequest()).resolves.toBeNull();
    });
});
