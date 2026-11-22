import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

// EW-617: the wizard is a modal on this page, so it renders the "save your account" strip
// INSIDE the dialog from the anonymous-account context. Here the stand-in only reports what
// the page put in that context.
vi.mock('@/components/onboarding/EverWorksOnboardingWizard', async () => {
    const { useAnonymousAccount } = await import('@/lib/anonymous/anonymous-account-context');
    return {
        EverWorksOnboardingWizard: () => (
            <output data-testid="wizard-context">{JSON.stringify(useAnonymousAccount())}</output>
        ),
    };
});

import { OnboardingPageClient } from './onboarding-page-client';

function renderPage(saveAccountStrip?: { expiresAt: string | null } | null) {
    render(
        <OnboardingPageClient
            initialState={{ completedAt: null, dismissedAt: null, state: ONBOARDING_DEFAULT_STATE }}
            catalog={{ ai: [], storage: [], db: [], deploy: [], desktop: [], plugins: [] }}
            plugins={[]}
            initialConnections={{}}
            initialDeviceAuthStatuses={{}}
            saveAccountStrip={saveAccountStrip}
        />,
    );
}

describe('OnboardingPageClient — temporary-account strip inside the wizard', () => {
    afterEach(() => cleanup());

    it('hands an anonymous visitor the strip through the context', () => {
        renderPage({ expiresAt: '2026-11-24T22:30:45.000Z' });

        expect(screen.getByTestId('wizard-context')).toHaveTextContent(
            '{"expiresAt":"2026-11-24T22:30:45.000Z"}',
        );
    });

    it('hands everyone else nothing', () => {
        renderPage(null);
        expect(screen.getByTestId('wizard-context')).toHaveTextContent('null');
        cleanup();

        renderPage();
        expect(screen.getByTestId('wizard-context')).toHaveTextContent('null');
    });
});
