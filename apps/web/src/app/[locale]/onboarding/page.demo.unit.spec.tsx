import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAuthFromCookie: vi.fn(),
    getDemoConfig: vi.fn(),
    redirect: vi.fn((): never => {
        throw new Error('NEXT_REDIRECT');
    }),
}));

vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: mocks.getAuthFromCookie }));
vi.mock('@/lib/feature-flags/demo', () => ({ getDemoConfig: mocks.getDemoConfig }));
vi.mock('@/lib/api/plugins', () => ({ pluginsAPI: { list: vi.fn() } }));
vi.mock('@/lib/api/onboarding', () => ({
    onboardingAPI: { getState: vi.fn(), getCatalog: vi.fn() },
}));
vi.mock('./onboarding-page-client', () => ({ OnboardingPageClient: () => null }));
vi.mock('./anonymous-bootstrap', () => ({ AnonymousOnboardingBootstrap: () => null }));

import OnboardingPage from './page';
import { AnonymousOnboardingBootstrap } from './anonymous-bootstrap';

describe('OnboardingPage — signed-out visitor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthFromCookie.mockResolvedValue(null);
    });

    it('demo off: mounts the anonymous bootstrap, as before', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: false });
        const page = (await OnboardingPage()) as { type: unknown };
        expect(page.type).toBe(AnonymousOnboardingBootstrap);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('demo on: sends the visitor to /login and never mints an anonymous session', async () => {
        mocks.getDemoConfig.mockResolvedValue({ enabled: true });
        await expect(OnboardingPage()).rejects.toThrow('NEXT_REDIRECT');
        expect(mocks.redirect).toHaveBeenCalledWith({ locale: 'en', href: '/login' });
    });
});
