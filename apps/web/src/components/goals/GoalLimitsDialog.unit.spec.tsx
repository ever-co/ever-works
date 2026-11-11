import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Goal } from '@/lib/api/goals';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
// A native select stands in for the design-system one, labelled by its placeholder.
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        onValueChange,
        placeholder,
        children,
    }: {
        value: string;
        onValueChange: (v: string) => void;
        placeholder?: string;
        children?: React.ReactNode;
    }) => (
        <select
            aria-label={placeholder}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
        >
            {children}
        </select>
    ),
}));
const updateLimits = vi.fn();
vi.mock('./actions', () => ({
    updateGoalLimitsAction: (...args: unknown[]) => updateLimits(...args),
}));

import { GoalLimitsDialog } from './GoalLimitsDialog';

const goal = (overrides: Partial<Goal> = {}): Goal =>
    ({
        id: 'goal-1',
        spendCapCents: null,
        wallClockLimitHours: null,
        stuckThresholdIterations: null,
        maxConcurrentIterations: null,
        sessionBudgetMinutes: null,
        gracePeriodMinutes: null,
        executionTarget: null,
        plannerModelHint: null,
        workerModelHint: null,
        assignedAgentId: null,
        ...overrides,
    }) as Goal;

const open = (props: { goal: Goal; agents?: Array<{ id: string; name: string }> }) =>
    render(
        <GoalLimitsDialog
            open
            onOpenChange={() => undefined}
            onGoalChange={() => undefined}
            {...props}
        />,
    );

const save = async () => {
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(updateLimits).toHaveBeenCalledTimes(1));
    return updateLimits.mock.calls[0]![1] as Record<string, unknown>;
};

describe('GoalLimitsDialog — the routing pin', () => {
    beforeEach(() => {
        updateLimits.mockReset();
        updateLimits.mockResolvedValue(goal());
    });

    it('leaves an unchanged pin out — a pinned Agent deleted since answered 404 on every save', async () => {
        open({ goal: goal({ assignedAgentId: 'deleted-agent' }), agents: [] });
        const input = await save();
        expect(input).not.toHaveProperty('assignedAgentId');
    });

    it('sends a changed pin', async () => {
        open({
            goal: goal({ assignedAgentId: null }),
            agents: [{ id: 'agent-1', name: 'Builder' }],
        });
        fireEvent.change(screen.getByLabelText('fields.assignedAgentNone'), {
            target: { value: 'agent-1' },
        });
        const input = await save();
        expect(input.assignedAgentId).toBe('agent-1');
    });

    it('still sends null to unpin', async () => {
        open({
            goal: goal({ assignedAgentId: 'agent-1' }),
            agents: [{ id: 'agent-1', name: 'Builder' }],
        });
        fireEvent.change(screen.getByLabelText('fields.assignedAgentNone'), {
            target: { value: '' },
        });
        const input = await save();
        expect(input.assignedAgentId).toBeNull();
    });
});
