import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getDemoConfig: vi.fn(),
    getAuthProvidersConfig: vi.fn(),
    getRequiredTerms: vi.fn(),
}));

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
    });

    it('demo off: renders the registration form', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        const el = (await RegisterPage({ searchParams: Promise.resolve({}) })) as ReactElement;
        expect(el.type).toBe(RegisterForm);
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
});
