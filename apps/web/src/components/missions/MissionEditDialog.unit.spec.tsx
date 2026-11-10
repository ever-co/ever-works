import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
    toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh }),
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

const updateDetails = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    updateMissionDetailsAction: (...args: unknown[]) => updateDetails(...args),
}));

// The dialog primitive (Headless UI transitions, focus trap, portal) is not
// what is under test; render its children in place while open.
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

import { MissionEditDialog, MISSION_DESCRIPTION_MAX_LENGTH } from './MissionEditDialog';
import type { Mission } from '@/lib/api/missions';

const MISSION = {
    id: 'm1',
    title: 'Cats Business',
    description: '## Goal\n\nSell **more** cat toys.',
};

function renderDialog(overrides: { open?: boolean } = {}) {
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    const utils = render(
        <MissionEditDialog
            mission={MISSION}
            open={overrides.open ?? true}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
        />,
    );
    return { ...utils, onOpenChange, onSaved };
}

describe('MissionEditDialog', () => {
    beforeEach(() => {
        updateDetails.mockReset();
        toastSuccess.mockReset();
        refresh.mockReset();
    });

    it('renders nothing while closed', () => {
        renderDialog({ open: false });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('opens with the current title and Markdown description', () => {
        renderDialog();
        expect(screen.getByText('title')).toBeTruthy();
        expect((screen.getByTestId('mission-edit-title') as HTMLInputElement).value).toBe(
            'Cats Business',
        );
        expect(
            (screen.getByTestId('mission-edit-description-textarea') as HTMLTextAreaElement).value,
        ).toBe(MISSION.description);
        // Nothing changed yet: Save stays disabled.
        expect((screen.getByTestId('mission-edit-save') as HTMLButtonElement).disabled).toBe(true);
    });

    it('toggles a rendered preview of the draft', () => {
        renderDialog();
        fireEvent.change(screen.getByTestId('mission-edit-description-textarea'), {
            target: { value: '- [x] ship\n- [ ] measure' },
        });
        fireEvent.click(screen.getByTestId('mission-edit-description-tab-preview'));
        const preview = screen.getByTestId('mission-edit-description-preview');
        expect(preview.hidden).toBe(false);
        expect(preview.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
        fireEvent.click(screen.getByTestId('mission-edit-description-tab-write'));
        expect(screen.getByTestId('mission-edit-description-preview').hidden).toBe(true);
    });

    it('saves trimmed values through updateMissionDetailsAction, then closes, toasts and refreshes', async () => {
        const saved = { ...MISSION, title: 'Cat Toys Inc', description: '## Goal' } as Mission;
        updateDetails.mockResolvedValueOnce({ success: true, mission: saved });
        const { onOpenChange, onSaved } = renderDialog();

        fireEvent.change(screen.getByTestId('mission-edit-title'), {
            target: { value: '  Cat Toys Inc ' },
        });
        fireEvent.change(screen.getByTestId('mission-edit-description-textarea'), {
            target: { value: '## Goal\n' },
        });
        fireEvent.click(screen.getByTestId('mission-edit-save'));

        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(updateDetails).toHaveBeenCalledWith('m1', {
            title: 'Cat Toys Inc',
            description: '## Goal',
        });
        expect(onSaved).toHaveBeenCalledWith(saved);
        expect(toastSuccess).toHaveBeenCalledWith('saved');
        expect(refresh).toHaveBeenCalled();
    });

    it('shows the API error and stays open when the save is refused', async () => {
        updateDetails.mockResolvedValueOnce({
            success: false,
            error: 'description must be shorter than or equal to 10000 characters',
        });
        const { onOpenChange, onSaved } = renderDialog();
        fireEvent.change(screen.getByTestId('mission-edit-title'), {
            target: { value: 'New title' },
        });
        fireEvent.click(screen.getByTestId('mission-edit-save'));

        const error = await screen.findByTestId('mission-edit-error');
        expect(error.textContent).toBe(
            'description must be shorter than or equal to 10000 characters',
        );
        expect(error.getAttribute('role')).toBe('alert');
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
        // The draft survives the refusal.
        expect((screen.getByTestId('mission-edit-title') as HTMLInputElement).value).toBe(
            'New title',
        );
    });

    it('falls back to a generic message when the action throws', async () => {
        updateDetails.mockRejectedValueOnce(new Error(''));
        renderDialog();
        fireEvent.change(screen.getByTestId('mission-edit-title'), {
            target: { value: 'New title' },
        });
        fireEvent.click(screen.getByTestId('mission-edit-save'));
        expect((await screen.findByTestId('mission-edit-error')).textContent).toBe('saveError');
    });

    it('validates before sending: title and description are required, length limits apply', async () => {
        renderDialog();
        fireEvent.change(screen.getByTestId('mission-edit-title'), { target: { value: '   ' } });
        fireEvent.change(screen.getByTestId('mission-edit-description-textarea'), {
            target: { value: ' ' },
        });
        fireEvent.click(screen.getByTestId('mission-edit-save'));

        expect(await screen.findByText('titleRequired')).toBeTruthy();
        expect(screen.getByText('descriptionRequired')).toBeTruthy();
        expect(screen.getByTestId('mission-edit-title').getAttribute('aria-invalid')).toBe('true');
        expect(updateDetails).not.toHaveBeenCalled();

        fireEvent.change(screen.getByTestId('mission-edit-title'), {
            target: { value: 'x'.repeat(201) },
        });
        fireEvent.change(screen.getByTestId('mission-edit-description-textarea'), {
            target: { value: 'y'.repeat(MISSION_DESCRIPTION_MAX_LENGTH + 1) },
        });
        fireEvent.click(screen.getByTestId('mission-edit-save'));
        expect(await screen.findByText('titleTooLong:{"max":200}')).toBeTruthy();
        expect(
            screen.getByText(`descriptionTooLong:{"max":${MISSION_DESCRIPTION_MAX_LENGTH}}`),
        ).toBeTruthy();
        expect(updateDetails).not.toHaveBeenCalled();
    });

    it('Cancel closes without saving and the next opening starts from the record again', () => {
        const { onOpenChange, rerender, onSaved } = renderDialog();
        fireEvent.change(screen.getByTestId('mission-edit-title'), { target: { value: 'Draft' } });
        fireEvent.click(screen.getByTestId('mission-edit-cancel'));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(updateDetails).not.toHaveBeenCalled();

        rerender(
            <MissionEditDialog
                mission={MISSION}
                open={false}
                onOpenChange={onOpenChange}
                onSaved={onSaved}
            />,
        );
        rerender(
            <MissionEditDialog
                mission={MISSION}
                open
                onOpenChange={onOpenChange}
                onSaved={onSaved}
            />,
        );
        expect((screen.getByTestId('mission-edit-title') as HTMLInputElement).value).toBe(
            'Cats Business',
        );
    });
});
