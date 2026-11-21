import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & Record<string, unknown>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { GenerationConsole } from './GenerationConsole';
import { INITIAL_CONSOLE_STATE, consoleReducer, type ConsoleState } from './generation-console';
import type { GenerateStatus } from '@/lib/api/types-only';

const T0 = '2026-11-21T10:00:00.000Z';
const WORK = { id: 'w-1', slug: 'ai-robots', name: 'AI robots directory' };

function starting(): ConsoleState {
    return consoleReducer(INITIAL_CONSOLE_STATE, { type: 'start', at: T0 });
}

function generating(extra: Partial<GenerateStatus> = {}): ConsoleState {
    const started = consoleReducer(starting(), { type: 'started', work: WORK, at: T0 });
    return consoleReducer(started, {
        type: 'status',
        status: { status: 'generating', ...extra } as GenerateStatus,
        at: T0,
    });
}

describe('GenerationConsole', () => {
    it('shows a live, screen-reader-announced log of what is happening', () => {
        render(<GenerationConsole state={starting()} elapsedMs={4_000} />);

        const log = screen.getByRole('log');
        expect(log).toHaveAttribute('aria-live', 'polite');
        expect(log.textContent).toMatch(/creating your work/i);
        expect(screen.getByTestId('onboarding-console-elapsed').textContent).toBe('0:04');
        expect(screen.getByTestId('onboarding-console-status').textContent).toMatch(/creating/i);
    });

    it('shows the current step and progress while generating', () => {
        render(
            <GenerationConsole
                state={generating({
                    stepName: 'Generate items',
                    stepIndex: 5,
                    totalSteps: 15,
                    progress: 40,
                    itemsProcessed: 12,
                })}
                elapsedMs={60_000}
            />,
        );

        expect(screen.getByTestId('onboarding-console-step').textContent).toBe(
            'Step 6 of 15: Generate items',
        );
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
        expect(screen.getByText('12 items generated')).toBeInTheDocument();
    });

    it('offers to open the Work as soon as it exists', async () => {
        const onOpenWork = vi.fn();
        render(<GenerationConsole state={generating()} elapsedMs={0} onOpenWork={onOpenWork} />);

        await userEvent.click(screen.getByTestId('onboarding-console-open-work'));
        expect(onOpenWork).toHaveBeenCalledTimes(1);
    });

    it('has no "Open your Work" before the Work exists', () => {
        render(<GenerationConsole state={starting()} elapsedMs={0} onOpenWork={vi.fn()} />);

        expect(screen.queryByTestId('onboarding-console-open-work')).toBeNull();
    });

    it('shows a refusal in full, keeps its line breaks, and says what to do next', async () => {
        const message =
            'One or more selected providers are not available.\nSearch: Provider "tavily" is not configured.';
        const state = consoleReducer(starting(), { type: 'startFailed', message, at: T0 });
        const onRetry = vi.fn();
        render(<GenerationConsole state={state} elapsedMs={0} onRetry={onRetry} />);

        // Same contract the provider-gate spec pins on the step (#3261).
        const alert = screen.getByTestId('onboarding-generate-error');
        expect(alert).toHaveAttribute('role', 'alert');
        expect(alert.textContent).toBe(message);
        expect(alert.className).toContain('whitespace-pre-line');
        expect(screen.getByTestId('onboarding-console-hint').textContent).toMatch(
            /settings → plugins/i,
        );
        expect(screen.getByRole('link', { name: /plugins/i })).toHaveAttribute('href', '/plugins');

        await userEvent.click(screen.getByTestId('onboarding-console-retry'));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('sends a failed generation to the Work and offers a retry', () => {
        const state = consoleReducer(generating(), {
            type: 'status',
            status: { status: 'error', error: 'AI provider timed out' } as GenerateStatus,
            at: T0,
        });
        render(
            <GenerationConsole
                state={state}
                elapsedMs={0}
                onRetry={vi.fn()}
                onOpenWork={vi.fn()}
            />,
        );

        expect(screen.getByTestId('onboarding-generate-error').textContent).toContain(
            'AI provider timed out',
        );
        // Not "Waiting for the first step…" once the run is over.
        expect(screen.getByTestId('onboarding-console-step').textContent).toBe(
            'Stopped before the first step',
        );
        expect(screen.getByTestId('onboarding-console-open-work')).toBeInTheDocument();
        expect(screen.getByTestId('onboarding-console-retry')).toBeInTheDocument();
    });

    it('announces a finished generation', () => {
        const state = consoleReducer(generating(), {
            type: 'status',
            status: { status: 'generated' } as GenerateStatus,
            at: T0,
        });
        render(<GenerationConsole state={state} elapsedMs={0} onOpenWork={vi.fn()} />);

        expect(screen.getByTestId('onboarding-console-status').textContent).toMatch(/done/i);
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    });
});
