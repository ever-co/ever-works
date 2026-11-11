import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
}));

const updateWorkDefaultAgent = vi.fn();
vi.mock('@/app/actions/dashboard/works', () => ({
    updateWorkDefaultAgent: (...args: unknown[]) => updateWorkDefaultAgent(...args),
}));

// The picker itself is the Task page's `AgentSelect`; stub it to a plain select so the spec
// asserts only what this card decides: the value it shows and what a change saves.
vi.mock('@/components/tasks/AgentSelect', () => ({
    AgentSelect: (props: {
        value: string;
        onValueChange: (value: string) => void;
        noneLabel: string;
        testId?: string;
        disabled?: boolean;
    }) => (
        <select
            data-testid={props.testId}
            value={props.value}
            disabled={props.disabled}
            onChange={(event) => props.onValueChange(event.target.value)}
        >
            <option value="">{props.noneLabel}</option>
            <option value="agent-shared">Shared docs Agent</option>
            <option value="agent-other">Other Agent</option>
        </select>
    ),
}));

let work: Record<string, unknown> = { id: 'work-1', defaultAgentId: null, userRole: 'owner' };
vi.mock('./SettingsContext', () => ({
    useSettings: () => ({ context: { work } }),
}));

import { DefaultAgentSettings } from './DefaultAgentSettings';

describe('DefaultAgentSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        work = { id: 'work-1', defaultAgentId: null, userRole: 'owner' };
        updateWorkDefaultAgent.mockResolvedValue({ success: true });
    });

    const select = () => screen.getByTestId('work-default-agent-select') as HTMLSelectElement;

    it("shows the Work's stored default, or none", () => {
        render(<DefaultAgentSettings />);
        expect(select().value).toBe('');

        work = { id: 'work-1', defaultAgentId: 'agent-shared', userRole: 'owner' };
        render(<DefaultAgentSettings />);
        expect(
            (screen.getAllByTestId('work-default-agent-select')[1] as HTMLSelectElement).value,
        ).toBe('agent-shared');
    });

    it('saves a picked Agent and refreshes the page', async () => {
        render(<DefaultAgentSettings />);
        fireEvent.change(select(), { target: { value: 'agent-shared' } });

        await waitFor(() =>
            expect(updateWorkDefaultAgent).toHaveBeenCalledWith('work-1', 'agent-shared'),
        );
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('saved'));
        expect(refresh).toHaveBeenCalled();
    });

    it('clears the default with null when "none" is picked', async () => {
        work = { id: 'work-1', defaultAgentId: 'agent-shared', userRole: 'owner' };
        render(<DefaultAgentSettings />);
        fireEvent.change(select(), { target: { value: '' } });

        await waitFor(() => expect(updateWorkDefaultAgent).toHaveBeenCalledWith('work-1', null));
    });

    it('a refusal (an Agent outside the Work scope answers 404) shows the error and restores the value', async () => {
        updateWorkDefaultAgent.mockResolvedValue({ success: false, error: 'Agent not found' });
        render(<DefaultAgentSettings />);
        fireEvent.change(select(), { target: { value: 'agent-other' } });

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Agent not found'));
        await waitFor(() => expect(select().value).toBe(''));
        expect(refresh).not.toHaveBeenCalled();
    });

    it('is read-only for an editor who is not the owner, and says why', () => {
        work = { id: 'work-1', defaultAgentId: 'agent-shared', userRole: 'editor' };
        render(<DefaultAgentSettings />);

        expect(select().disabled).toBe(true);
        expect(select().value).toBe('agent-shared');
        expect(screen.getByTestId('work-default-agent-owner-only').textContent).toBe('ownerOnly');
        expect(updateWorkDefaultAgent).not.toHaveBeenCalled();
    });

    it('is editable, with no owner-only note, for the owner', () => {
        render(<DefaultAgentSettings />);
        expect(select().disabled).toBe(false);
        expect(screen.queryByTestId('work-default-agent-owner-only')).toBeNull();
    });
});
