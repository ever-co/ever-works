import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getDemoConfig: vi.fn(),
    getAuthProvidersConfig: vi.fn(),
    getRequiredTerms: vi.fn(),
    hasSavableAnonymousSession: vi.fn(),
    redirect: vi.fn(),
}));

vi.mock('@/lib/anonymous/save-account-strip', () => ({
    hasSavableAnonymousSession: mocks.hasSavableAnonymousSession,
}));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next-intl/server', () => ({
    getLocale: async () => 'en',
    getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/feature-flags/demo', () => ({ getDemoConfig: mocks.getDemoConfig }));
vi.mock('@/lib/auth/providers', () => ({ getAuthProvidersConfig: mocks.getAuthProvidersConfig }));
vi.mock('@/lib/feature-flags/ever-id', () => ({
    EVER_ID_ANONYMOUS_DISTINCT_ID: 'anonymous',
    isEverIdOffered: async () => false,
}));
vi.mock('@/lib/api', () => ({ authAPI: { getRequiredTerms: mocks.getRequiredTerms } }));
vi.mock('./register-form', () => ({ default: () => null }));
vi.mock('@/components/demo/DemoRegisterPanel', () => ({ DemoRegisterPanel: () => null }));

import RegisterPage from './page';
import RegisterForm from './register-form';
import { DemoRegisterPanel } from '@/components/demo/DemoRegisterPanel';

describe('RegisterPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthProvidersConfig.mockResolvedValue({ socialProviders: [], everId: {} });
        mocks.getRequiredTerms.mockResolvedValue([]);
        mocks.hasSavableAnonymousSession.mockResolvedValue(false);
    });

    it('demo off: renders the registration form', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        const el = (await RegisterPage({ searchParams: Promise.resolve({}) })) as ReactElement;
        expect(el.type).toBe(RegisterForm);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    // EW-617: signing up here on a temporary account would make a second account and strand
    // the Works on the first, so that visitor is sent to save the account they are on.
    it('signed in on a temporary account: goes to /save-account instead of the form', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        mocks.hasSavableAnonymousSession.mockResolvedValue(true);

        const el = await RegisterPage({ searchParams: Promise.resolve({}) });

        expect(mocks.redirect).toHaveBeenCalledWith({ href: '/save-account', locale: 'en' });
        expect(el).toBeNull();
        expect(mocks.getRequiredTerms).not.toHaveBeenCalled();
    });

    it('demo on: never asks about a temporary account (the demo panel covers sign-up)', async () => {
        mocks.getDemoConfig.mockResolvedValue({
            enabled: true,
            signUpUrl: 'https://example.test/register',
            sandboxTtlHours: 12,
        });
        mocks.hasSavableAnonymousSession.mockResolvedValue(true);

        await RegisterPage({ searchParams: Promise.resolve({}) });

        expect(mocks.hasSavableAnonymousSession).not.toHaveBeenCalled();
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('demo on: renders the sign-up link panel and skips the form and its fetches', async () => {
        mocks.getDemoConfig.mockResolvedValue({
            enabled: true,
            signUpUrl: 'https://example.test/register',
            sandboxTtlHours: 12,
        });
        const el = (await RegisterPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
            signUpUrl: string;
            ttlHours: number;
        }>;
        expect(el.type).toBe(DemoRegisterPanel);
        expect(el.props).toEqual({ signUpUrl: 'https://example.test/register', ttlHours: 12 });
        expect(mocks.getRequiredTerms).not.toHaveBeenCalled();
    });

    // R42 b: two independent reads of the API, asked for at once instead of one after the other.
    it('asks for the auth providers while the demo config is still loading', async () => {
        let releaseDemo: (value: unknown) => void = () => undefined;
        mocks.getDemoConfig.mockReturnValue(
            new Promise((resolve) => {
                releaseDemo = resolve;
            }),
        );

        const page = RegisterPage({ searchParams: Promise.resolve({}) });
        await vi.waitFor(() => expect(mocks.getAuthProvidersConfig).toHaveBeenCalledTimes(1));
        releaseDemo({ enabled: false });

        expect(((await page) as ReactElement).type).toBe(RegisterForm);
    });
});
