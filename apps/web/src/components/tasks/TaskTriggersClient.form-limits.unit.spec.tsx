import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const createInboundTriggerAction = vi.fn();
vi.mock('@/app/actions/dashboard/inbound-triggers', () => ({
    createGithubForMeTriggerAction: vi.fn(),
    createInboundTriggerAction: (...args: unknown[]) => createInboundTriggerAction(...args),
    fireNowInboundTriggerAction: vi.fn(),
    updateInboundTriggerAction: vi.fn(),
    pauseInboundTriggerAction: vi.fn(),
    resumeInboundTriggerAction: vi.fn(),
    deleteInboundTriggerAction: vi.fn(),
    rotateInboundTriggerSecretAction: vi.fn(),
    testFireInboundTriggerAction: vi.fn(),
}));

import { TaskTriggersClient } from './TaskTriggersClient';

function openCreateForm() {
    render(<TaskTriggersClient initialTriggers={[]} agents={[]} apiBaseUrl="https://api.test" />);
    fireEvent.click(screen.getByTestId('task-triggers-new'));
    fireEvent.change(screen.getByTestId('task-trigger-form-name'), {
        target: { value: 'Deploys' },
    });
}

const submit = () => screen.getByTestId('task-trigger-form-submit') as HTMLButtonElement;

/**
 * `CreateInboundTriggerDto` refuses a variable key outside [A-Za-z0-9_-] and a
 * replay window under 10 s; the form sent both and showed the API's raw 400.
 */
describe('TaskTriggersClient — the form checks what the API refuses', () => {
    beforeEach(() => {
        createInboundTriggerAction.mockReset();
        createInboundTriggerAction.mockResolvedValue({ success: false, error: 'raw 400' });
    });

    it('can be submitted with valid variables and the default replay window', () => {
        openCreateForm();
        fireEvent.change(screen.getByTestId('task-trigger-form-variables'), {
            target: { value: 'repo*\nbranch_name | Branch' },
        });

        expect(screen.queryByTestId('task-trigger-form-variables-error')).toBeNull();
        expect(screen.queryByTestId('task-trigger-form-replay-window-error')).toBeNull();
        expect(submit().disabled).toBe(false);
    });

    it('names a variable key with a dot or a space, and sends nothing', () => {
        openCreateForm();
        fireEvent.change(screen.getByTestId('task-trigger-form-variables'), {
            target: { value: 'repo.name*\npull request' },
        });

        expect(screen.getByTestId('task-trigger-form-variables-error').textContent).toBe(
            `form.variablesInvalidKey:${JSON.stringify({ reason: 'variablesInvalidKey', keys: 'repo.name, pull request' })}`,
        );
        expect(submit().disabled).toBe(true);
        fireEvent.click(submit());
        expect(createInboundTriggerAction).not.toHaveBeenCalled();
    });

    it('says the replay window must be 10 s or more, and sends nothing', () => {
        openCreateForm();
        fireEvent.change(screen.getByTestId('task-trigger-form-replay-window'), {
            target: { value: '5' },
        });

        expect(screen.getByTestId('task-trigger-form-replay-window-error').textContent).toBe(
            `form.replayWindowInvalid:${JSON.stringify({ min: 10, max: 86400 })}`,
        );
        expect(submit().disabled).toBe(true);
        fireEvent.click(submit());
        expect(createInboundTriggerAction).not.toHaveBeenCalled();
    });
});
