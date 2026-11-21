import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GenerateStatus } from '@/lib/api/types-only';

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

import { CreateWorkStep } from './CreateWorkStep';

const WORK = {
    workId: 'w-1',
    workSlug: 'ai-robots',
    workName: 'AI robots directory',
    generationHistoryId: 'h-1',
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(() => {
    cleanup();
});

describe('CreateWorkStep — the generation console', () => {
    it('shows what is happening while the Work is being created, instead of a bare "Generating…"', async () => {
        const pending = deferred<typeof WORK>();
        render(
            <CreateWorkStep
                onLeave={vi.fn()}
                prompt="AI robots directory"
                onQuickCreate={() => pending.promise}
                fetchWorkStatus={vi.fn().mockResolvedValue(null)}
            />,
        );

        await userEvent.click(screen.getByTestId('onboarding-generate-now'));

        const log = await screen.findByRole('log');
        expect(log.textContent).toMatch(/creating your work/i);
        expect(screen.getByTestId('onboarding-console-status').textContent).toMatch(/creating/i);

        await act(async () => {
            pending.resolve(WORK);
        });
    });

    it('keeps the visitor here once generation starts and streams its progress', async () => {
        const onLeave = vi.fn();
        const onGenerationStarted = vi.fn();
        const fetchWorkStatus = vi.fn().mockResolvedValue({
            status: 'generating',
            step: 'items',
            stepName: 'Generate items',
            stepIndex: 5,
            totalSteps: 15,
            progress: 40,
        } as GenerateStatus);
        render(
            <CreateWorkStep
                onLeave={onLeave}
                prompt="AI robots directory"
                onQuickCreate={vi.fn().mockResolvedValue(WORK)}
                onGenerationStarted={onGenerationStarted}
                fetchWorkStatus={fetchWorkStatus}
                pollIntervalMs={10}
            />,
        );

        await userEvent.click(screen.getByTestId('onboarding-generate-now'));

        await waitFor(() =>
            expect(screen.getByTestId('onboarding-console-step').textContent).toBe(
                'Step 6 of 15: Generate items',
            ),
        );
        expect(fetchWorkStatus).toHaveBeenCalledWith('w-1');
        expect(onGenerationStarted).toHaveBeenCalledWith({
            id: 'w-1',
            slug: 'ai-robots',
            name: 'AI robots directory',
        });
        // The wizard is no longer closed the moment the request returns — that
        // is what left the visitor on an empty screen.
        expect(onLeave).not.toHaveBeenCalled();
        expect(screen.queryByTestId('onboarding-generate-now')).toBeNull();
        // The "review your prompt, then generate" intro is replaced once it runs.
        expect(screen.queryByText(/review or tweak/i)).toBeNull();
        expect(screen.getByText(/being generated/i)).toBeInTheDocument();
    });

    it('opens the Generator tab of the Work, where the progress continues, on "Open your Work"', async () => {
        const onOpenWork = vi.fn();
        render(
            <CreateWorkStep
                onLeave={vi.fn()}
                prompt="AI robots directory"
                onQuickCreate={vi.fn().mockResolvedValue(WORK)}
                onOpenWork={onOpenWork}
                fetchWorkStatus={vi
                    .fn()
                    .mockResolvedValue({ status: 'generating' } as GenerateStatus)}
                pollIntervalMs={10}
            />,
        );

        await userEvent.click(screen.getByTestId('onboarding-generate-now'));
        await userEvent.click(await screen.findByTestId('onboarding-console-open-work'));

        expect(onOpenWork).toHaveBeenCalledWith(
            { id: 'w-1', slug: 'ai-robots', name: 'AI robots directory' },
            '/works/w-1/generator',
        );
    });

    it('lands the visitor on the Work by itself when the generation finishes', async () => {
        const onOpenWork = vi.fn();
        render(
            <CreateWorkStep
                onLeave={vi.fn()}
                prompt="AI robots directory"
                onQuickCreate={vi.fn().mockResolvedValue(WORK)}
                onOpenWork={onOpenWork}
                fetchWorkStatus={vi
                    .fn()
                    .mockResolvedValue({ status: 'generated' } as GenerateStatus)}
                pollIntervalMs={10}
            />,
        );

        await userEvent.click(screen.getByTestId('onboarding-generate-now'));

        await waitFor(() =>
            expect(onOpenWork).toHaveBeenCalledWith(
                { id: 'w-1', slug: 'ai-robots', name: 'AI robots directory' },
                '/works/w-1',
            ),
        );
        expect(onOpenWork).toHaveBeenCalledTimes(1);
    });

    it('lets the visitor edit the prompt and try again after a refusal', async () => {
        const onQuickCreate = vi
            .fn()
            .mockRejectedValueOnce(new Error('Failed to create work'))
            .mockResolvedValueOnce(WORK);
        const onBusyChange = vi.fn();
        render(
            <CreateWorkStep
                onLeave={vi.fn()}
                prompt="AI robots directory"
                onQuickCreate={onQuickCreate}
                onBusyChange={onBusyChange}
                fetchWorkStatus={vi.fn().mockResolvedValue(null)}
                pollIntervalMs={10}
            />,
        );

        await userEvent.click(screen.getByTestId('onboarding-generate-now'));
        await screen.findByTestId('onboarding-generate-error');
        expect(onBusyChange).toHaveBeenNthCalledWith(1, true);
        expect(onBusyChange).toHaveBeenNthCalledWith(2, false);

        const input = screen.getByTestId('onboarding-prompt-input');
        await userEvent.type(input, ' and parts');
        await userEvent.click(screen.getByTestId('onboarding-console-retry'));

        await waitFor(() => expect(onQuickCreate).toHaveBeenCalledTimes(2));
        expect(onQuickCreate).toHaveBeenLastCalledWith('AI robots directory and parts');
    });

    it('still leaves the wizard when the caller returns no Work to follow', async () => {
        const onLeave = vi.fn();
        render(
            <CreateWorkStep
                onLeave={onLeave}
                prompt="AI robots directory"
                onQuickCreate={vi.fn().mockResolvedValue(undefined)}
            />,
        );

        await userEvent.click(screen.getByTestId('onboarding-generate-now'));

        await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1));
    });
});
