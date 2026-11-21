import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import type { OnboardingCatalogResponse, OnboardingStateResponse } from '@ever-works/contracts/api';

const { push, quickCreateWorkAction, completeOnboarding, getWorkGenerationStatusAction } =
    vi.hoisted(() => ({
        push: vi.fn(),
        quickCreateWorkAction: vi.fn(),
        completeOnboarding: vi.fn(),
        getWorkGenerationStatusAction: vi.fn(),
    }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('./use-turnstile', () => ({
    useTurnstile: () => ({ getToken: async () => '', ready: true }),
}));
vi.mock('@/app/actions/onboarding/track', () => ({
    trackOnboardingEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/app/actions/onboarding/state', () => ({
    completeOnboarding,
    patchOnboardingState: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/app/actions/dashboard/onboarding', () => ({
    getOnboardingPluginStatuses: vi
        .fn()
        .mockResolvedValue({ success: true, data: { connections: {}, deviceAuthStatuses: {} } }),
}));
vi.mock('@/app/actions/works/quick-create', () => ({ quickCreateWorkAction }));
vi.mock('@/app/actions/telemetry/funnel', () => ({
    emitFunnelEventAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/app/actions/onboarding/generation-status', () => ({ getWorkGenerationStatusAction }));
// The heavy steps are not under test here; they only have to exist.
vi.mock('./steps/RosterStep', () => ({ RosterStep: () => <div>roster</div> }));
vi.mock('./steps/ProfileStep', () => ({ ProfileStep: () => <div>profile</div> }));
vi.mock('./steps/PluginsCatalogStep', () => ({ PluginsCatalogStep: () => <div>plugins</div> }));
vi.mock('./steps/ConfigStep', () => ({ ConfigStep: () => <div>config</div> }));
vi.mock('./steps/CommunicationStep', () => ({
    CommunicationStep: () => <div>communication</div>,
    SLACK_CONNECTOR_PLUGIN_ID: 'slack-connector',
}));

import { EverWorksOnboardingWizard } from './EverWorksOnboardingWizard';

const CATALOG: OnboardingCatalogResponse = {
    ai: [
        {
            choice: 'ever-works',
            title: 'Ever Works AI',
            description: '',
            default: true,
            available: true,
            badges: [],
        },
    ],
    storage: [
        {
            choice: 'ever-works-git',
            title: 'Ever Works Git',
            description: '',
            default: true,
            available: true,
            badges: [],
        },
    ],
    db: [],
    deploy: [
        {
            choice: 'ever-works',
            title: 'Ever Works Cloud',
            description: '',
            default: true,
            available: true,
            badges: [],
        },
    ],
    desktop: [],
    plugins: [],
};

const STATE: OnboardingStateResponse = {
    completedAt: null,
    dismissedAt: null,
    state: ONBOARDING_DEFAULT_STATE,
};

function renderWizard(onClose = vi.fn()) {
    render(
        <EverWorksOnboardingWizard
            open
            initialState={STATE}
            catalog={CATALOG}
            plugins={[]}
            initialConnections={{}}
            initialDeviceAuthStatuses={{}}
            onClose={onClose}
        />,
    );
    return { onClose };
}

beforeEach(() => {
    window.history.replaceState({}, '', '/onboarding');
    push.mockReset();
    quickCreateWorkAction.mockReset();
    completeOnboarding.mockReset();
    getWorkGenerationStatusAction.mockReset();
});

afterEach(() => {
    cleanup();
});

describe('EverWorksOnboardingWizard — a visitor arriving with a prompt from ever.works', () => {
    beforeEach(() => {
        window.history.replaceState(
            {},
            '',
            '/onboarding#prompt=AI%20robots%20directory&corrId=abcdef1234&type=directory-website',
        );
    });

    it('shows a short quick-start path, not the last of eleven pre-ticked steps', async () => {
        renderWizard();

        expect(await screen.findByTestId('onboarding-quick-start')).toBeInTheDocument();
        expect(screen.queryByText(/step 11 of 11/i)).toBeNull();
        expect(screen.queryByText('Your Git Storage')).toBeNull();
        expect(screen.getByTestId('onboarding-prompt-input')).toHaveValue('AI robots directory');
        // The defaults the Work will use are named, so nothing is set silently.
        const defaults = screen.getByTestId('onboarding-quick-start-defaults');
        expect(defaults.textContent).toContain('Ever Works AI');
        expect(defaults.textContent).toContain('Ever Works Git');
        expect(defaults.textContent).toContain('Ever Works Cloud');
        // Self-hosted installs have no ever.works home page; the copy must not assume one.
        expect(screen.getByTestId('onboarding-quick-start').textContent).not.toMatch(
            /ever\.works/i,
        );
    });

    it('keeps the platform default Work kind: the home-page type is not sent', async () => {
        quickCreateWorkAction.mockResolvedValue({
            success: true,
            data: {
                status: 'pending',
                work: { id: 'w-1', slug: 'ai-robots-directory', name: 'AI robots directory' },
                generation: { historyId: 'h-1', message: 'Generation started' },
            },
        });
        getWorkGenerationStatusAction.mockResolvedValue({
            ok: true,
            status: { status: 'generating' },
        });
        renderWizard();

        // Mapping the chip onto a Work kind needs product sign-off (item
        // generation is not kind-aware yet), so quick-create keeps the default.
        await userEvent.click(await screen.findByTestId('onboarding-generate-now'));

        await waitFor(() => expect(quickCreateWorkAction).toHaveBeenCalledTimes(1));
        expect(quickCreateWorkAction.mock.calls[0][0]).toMatchObject({
            prompt: 'AI robots directory',
            correlationId: 'abcdef1234',
        });
        expect(quickCreateWorkAction.mock.calls[0][0]).not.toHaveProperty('kind');
        expect(screen.queryByTestId('onboarding-work-kind')).toBeNull();
    });

    it('removes the hand-off from the address bar, type included', async () => {
        renderWizard();

        await screen.findByTestId('onboarding-quick-start');
        expect(window.location.hash).toBe('');
    });

    it('opens the full wizard from step 1 on "Customize setup", keeping the prompt', async () => {
        renderWizard();

        await userEvent.click(await screen.findByTestId('onboarding-quick-start-customize'));

        expect(screen.queryByTestId('onboarding-quick-start')).toBeNull();
        expect(screen.getByText(/step 1 of 11/i)).toBeInTheDocument();
        expect(screen.getByText('Welcome to Ever Works')).toBeInTheDocument();
    });

    it('marks onboarding done and stays open with the console once generation starts', async () => {
        quickCreateWorkAction.mockResolvedValue({
            success: true,
            data: {
                status: 'pending',
                work: { id: 'w-1', slug: 'ai-robots-directory', name: 'AI robots directory' },
                generation: { historyId: 'h-1', message: 'Generation started' },
            },
        });
        // The shape `GET /api/works/:id` answers while a run is going.
        getWorkGenerationStatusAction.mockResolvedValue({
            ok: true,
            status: {
                status: 'generating',
                step: 'items',
                stepName: 'Generate items',
                stepIndex: 5,
                totalSteps: 15,
                progress: 40,
                itemsProcessed: 12,
                warnings: ['Screenshots are disabled for this run'],
                recentLogs: [
                    {
                        timestamp: '2026-11-21T10:00:06.000Z',
                        level: 'info',
                        source: 'pipeline',
                        stepIndex: 5,
                        event: 'message',
                        message: 'Generated 12 items',
                    },
                ],
            },
        });
        const { onClose } = renderWizard();

        await userEvent.click(await screen.findByTestId('onboarding-generate-now'));

        expect(await screen.findByTestId('onboarding-console-open-work')).toBeInTheDocument();
        // The live status reaches the console through the wizard's real wiring.
        await waitFor(() =>
            expect(screen.getByTestId('onboarding-console-step').textContent).toBe(
                'Step 6 of 15: Generate items',
            ),
        );
        const log = screen.getByRole('log');
        expect(log.textContent).toContain('Generated 12 items');
        expect(log.textContent).toContain('Screenshots are disabled for this run');
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
        expect(getWorkGenerationStatusAction).toHaveBeenCalledWith('w-1');
        await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
        expect(onClose).not.toHaveBeenCalled();

        // Without an `onOpenWork` from the page, the wizard routes there itself.
        await userEvent.click(screen.getByTestId('onboarding-console-open-work'));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith('/works/w-1/generator');
    });
});

describe('EverWorksOnboardingWizard — a retry after a failed run', () => {
    beforeEach(() => {
        window.history.replaceState(
            {},
            '',
            '/onboarding#prompt=AI%20robots%20directory&corrId=abcdef1234',
        );
    });

    it('marks onboarding complete once, not on every successful start', async () => {
        quickCreateWorkAction.mockResolvedValue({
            success: true,
            data: {
                status: 'pending',
                work: { id: 'w-1', slug: 'ai-robots-directory', name: 'AI robots directory' },
                generation: { historyId: 'h-1', message: 'Generation started' },
            },
        });
        getWorkGenerationStatusAction.mockResolvedValue({
            ok: true,
            status: { status: 'error', error: 'AI provider timed out' },
        });
        renderWizard();

        await userEvent.click(await screen.findByTestId('onboarding-generate-now'));
        await userEvent.click(await screen.findByTestId('onboarding-console-retry'));
        await waitFor(() => expect(quickCreateWorkAction).toHaveBeenCalledTimes(2));
        await screen.findByTestId('onboarding-console-retry');

        expect(completeOnboarding).toHaveBeenCalledTimes(1);
    });
});

describe('EverWorksOnboardingWizard — closed, as the dashboard always mounts it', () => {
    it('leaves another page’s ?prompt= alone', async () => {
        // `/tasks/new?prompt=…` (command palette) and `/agents/new?prompt=…`
        // read their own `prompt` parameter; the closed wizard must not take it.
        window.history.replaceState({}, '', '/tasks/new?prompt=Fix%20the%20login%20bug');
        render(
            <EverWorksOnboardingWizard
                open={false}
                initialState={STATE}
                catalog={CATALOG}
                plugins={[]}
                initialConnections={{}}
                initialDeviceAuthStatuses={{}}
                onClose={vi.fn()}
            />,
        );

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(window.location.search).toBe('?prompt=Fix%20the%20login%20bug');
    });
});

describe('EverWorksOnboardingWizard — without a hand-off', () => {
    it('is the normal eleven-step wizard', async () => {
        renderWizard();

        expect(await screen.findByText(/step 1 of 11/i)).toBeInTheDocument();
        expect(screen.queryByTestId('onboarding-quick-start')).toBeNull();
    });
});
