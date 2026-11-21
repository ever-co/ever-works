import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

// The wizard is exercised by its own specs; here it only has to hand the page
// its two ways out.
vi.mock('@/components/onboarding/EverWorksOnboardingWizard', () => ({
    EverWorksOnboardingWizard: ({
        open,
        onClose,
        onOpenWork,
    }: {
        open: boolean;
        onClose: () => void;
        onOpenWork: (work: { id: string; slug: string; name: string }, href: string) => void;
    }) =>
        open ? (
            <div>
                <button type="button" onClick={onClose}>
                    close
                </button>
                <button
                    type="button"
                    onClick={() =>
                        onOpenWork(
                            { id: 'w-1', slug: 'ai-robots', name: 'AI robots directory' },
                            '/works/w-1/generator',
                        )
                    }
                >
                    open work
                </button>
            </div>
        ) : null,
}));

import { OnboardingPageClient } from './onboarding-page-client';

function renderPage() {
    render(
        <OnboardingPageClient
            initialState={{ completedAt: null, dismissedAt: null, state: ONBOARDING_DEFAULT_STATE }}
            catalog={{ ai: [], storage: [], db: [], deploy: [], desktop: [], plugins: [] }}
            plugins={[]}
            initialConnections={{}}
            initialDeviceAuthStatuses={{}}
        />,
    );
}

afterEach(() => {
    cleanup();
    push.mockReset();
});

describe('OnboardingPageClient — leaving the wizard', () => {
    it('shows where it is going while the new Work loads, instead of an empty page', async () => {
        renderPage();

        await userEvent.click(screen.getByText('open work'));

        expect(push).toHaveBeenCalledWith('/works/w-1/generator');
        const status = screen.getByRole('status');
        expect(status.textContent).toContain('Opening AI robots directory');
        expect(status.textContent).toMatch(/progress/i);
    });

    it('shows a loading state while the dashboard loads after closing', async () => {
        renderPage();

        await userEvent.click(screen.getByText('close'));

        expect(push).toHaveBeenCalledWith('/');
        expect(screen.getByRole('status').textContent).toMatch(/opening your dashboard/i);
    });
});
