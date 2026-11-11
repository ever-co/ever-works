import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh }),
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

const updateDetails = vi.fn();
vi.mock('./actions', () => ({
    updateGoalDetailsAction: (...args: unknown[]) => updateDetails(...args),
}));

vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogClose: ({ onClose }: { onClose: () => void }) => (
        <button type="button" onClick={onClose}>
            close
        </button>
    ),
}));

import { GoalEditDialog } from './GoalEditDialog';
import type { Goal } from '@/lib/api/goals';

describe('GoalEditDialog', () => {
    beforeEach(() => {
        updateDetails.mockReset();
        refresh.mockReset();
    });

    it('opens on a Goal without a description and saves a new Markdown one', async () => {
        const saved = { id: 'g1', title: 'Ship pricing', description: '- three tiers' } as Goal;
        updateDetails.mockResolvedValueOnce({ success: true, goal: saved });
        const onOpenChange = vi.fn();
        const onSaved = vi.fn();
        render(
            <GoalEditDialog
                goal={{ id: 'g1', title: 'Ship pricing', description: null }}
                open
                onOpenChange={onOpenChange}
                onSaved={onSaved}
            />,
        );
        expect(
            (screen.getByTestId('goal-edit-description-textarea') as HTMLTextAreaElement).value,
        ).toBe('');

        fireEvent.change(screen.getByTestId('goal-edit-description-textarea'), {
            target: { value: '- three tiers' },
        });
        fireEvent.click(screen.getByTestId('goal-edit-save'));

        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        // Only the field that changed is sent.
        expect(updateDetails).toHaveBeenCalledWith('g1', { description: '- three tiers' });
        expect(onSaved).toHaveBeenCalledWith(saved);
        expect(refresh).toHaveBeenCalled();
    });

    it('allows clearing the description (it is optional on a Goal)', async () => {
        updateDetails.mockResolvedValueOnce({
            success: true,
            goal: { id: 'g1', title: 'T', description: null } as Goal,
        });
        const onOpenChange = vi.fn();
        render(
            <GoalEditDialog
                goal={{ id: 'g1', title: 'T', description: 'old' }}
                open
                onOpenChange={onOpenChange}
                onSaved={vi.fn()}
            />,
        );
        fireEvent.change(screen.getByTestId('goal-edit-description-textarea'), {
            target: { value: '' },
        });
        fireEvent.click(screen.getByTestId('goal-edit-save'));
        await waitFor(() => expect(updateDetails).toHaveBeenCalledWith('g1', { description: '' }));
        expect(screen.queryByText('descriptionRequired')).toBeNull();
    });

    it('shows the API error inline', async () => {
        updateDetails.mockResolvedValueOnce({ success: false, error: 'Goal not found' });
        render(
            <GoalEditDialog
                goal={{ id: 'g1', title: 'T', description: 'old' }}
                open
                onOpenChange={vi.fn()}
                onSaved={vi.fn()}
            />,
        );
        fireEvent.change(screen.getByTestId('goal-edit-title'), { target: { value: 'T2' } });
        fireEvent.click(screen.getByTestId('goal-edit-save'));
        expect((await screen.findByTestId('goal-edit-error')).textContent).toBe('Goal not found');
    });
});
