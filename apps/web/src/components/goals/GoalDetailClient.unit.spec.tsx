import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Goal } from '@/lib/api/goals';

/**
 * The Goal page for a viewer the Goal is only shared with (`canEdit=false`).
 * Every Goal write is owner-only, so each control below answered that viewer
 * with a 404: the page shows the Goal read-only instead. `<fieldset disabled>`
 * reaches only native controls, so a non-native control added inside a
 * section would stay live; these assertions are what notices.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

vi.mock('./actions', () => ({
    activateGoalAction: vi.fn(),
    advanceGoalAction: vi.fn(),
    approveGoalDodAction: vi.fn(),
    archiveGoalAction: vi.fn(),
    deleteGoalAction: vi.fn(),
    evaluateGoalNowAction: vi.fn(),
    goalLoopAction: vi.fn(),
    nudgeGoalAction: vi.fn(),
    patchGoalDodCriterionAction: vi.fn(),
    pauseGoalAction: vi.fn(),
    restartGoalSessionAction: vi.fn(),
    setGoalDodAction: vi.fn(),
    unarchiveGoalAction: vi.fn(),
    updateGoalAction: vi.fn(),
    updateGoalDetailsAction: vi.fn(),
    updateGoalLimitsAction: vi.fn(),
}));

// The Work picker loads the viewer's Works through a server action (and is
// disabled while it loads).
const getWorks = vi.fn();
vi.mock('@/app/actions/dashboard/works', () => ({
    getWorks: (...args: unknown[]) => getWorks(...args),
}));

// Panels that fetch on their own and are not part of the gating.
vi.mock('@/components/record-visibility', () => ({ RecordVisibilityPanel: () => null }));
vi.mock('./GoalLimitsDialog', () => ({ GoalLimitsDialog: () => null }));
vi.mock('./GoalEditDialog', () => ({ GoalEditDialog: () => null }));
vi.mock('@/components/work-agent', () => ({
    StatusPill: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { GoalDetailClient } from './GoalDetailClient';

function goal(overrides: Partial<Goal> = {}): Goal {
    return {
        id: 'g1',
        title: 'Ship the pricing page',
        description: null,
        status: 'active',
        goalKind: 'delivery',
        outcome: null,
        loopStatus: 'paused',
        archivedAt: null,
        iteration: 2,
        spentCents: 120,
        spendCapCents: null,
        workId: null,
        workName: null,
        window: 'day',
        checkFrequencyMinutes: 60,
        dodCriteria: [{ id: 'c1', text: 'Three tiers', status: 'open', source: 'operator' }],
        dodSummary: { total: 1, done: 0, waived: 0, open: 1, proposed: 0 },
        ...overrides,
    } as unknown as Goal;
}

function renderPage(canEdit?: boolean) {
    return render(
        <GoalDetailClient
            goal={goal()}
            samples={[]}
            events={[]}
            sessions={[]}
            {...(canEdit === undefined ? {} : { canEdit })}
        />,
    );
}

/** Opens the Progress tab and lets the Work picker finish loading its Works. */
async function openProgressTab() {
    fireEvent.click(screen.getByRole('tab', { name: 'tabs.progress' }));
    await waitFor(() => expect(getWorks).toHaveBeenCalled());
    await act(async () => {});
}

describe('GoalDetailClient — a Goal shared with the viewer is read-only', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getWorks.mockResolvedValue({ success: true, works: [], total: 0 });
    });

    it('hides the owner action bar (Edit, loop and lifecycle controls)', () => {
        renderPage(false);
        expect(screen.queryByTestId('goal-edit-button')).toBeNull();
        expect(screen.queryByText('loop.actions.start')).toBeNull();
        expect(screen.queryByText('actions.edit')).toBeNull();
    });

    it('disables the Definition of Done controls', () => {
        renderPage(false);
        expect(screen.getByTestId('goal-dod-edit').matches(':disabled')).toBe(true);
        expect(screen.getByRole('button', { name: 'markDone' }).matches(':disabled')).toBe(true);
        expect(screen.getByRole('button', { name: 'remove' }).matches(':disabled')).toBe(true);
        expect(screen.getByLabelText('addLabel').matches(':disabled')).toBe(true);
    });

    it('disables the Work picker and the outcome override', async () => {
        renderPage(false);
        await openProgressTab();
        expect(screen.getByTestId('goal-detail-work-select').matches(':disabled')).toBe(true);
        expect(screen.getByTestId('goal-detail-outcome-select').matches(':disabled')).toBe(true);
    });

    it('keeps every control live for the owner (the default)', async () => {
        renderPage();
        expect(screen.getByTestId('goal-edit-button')).toBeTruthy();
        expect(screen.getByText('loop.actions.start')).toBeTruthy();
        expect(screen.getByTestId('goal-dod-edit').matches(':disabled')).toBe(false);
        expect(screen.getByRole('button', { name: 'remove' }).matches(':disabled')).toBe(false);
        expect(screen.getByLabelText('addLabel').matches(':disabled')).toBe(false);
        await openProgressTab();
        expect(screen.getByTestId('goal-detail-work-select').matches(':disabled')).toBe(false);
        expect(screen.getByTestId('goal-detail-outcome-select').matches(':disabled')).toBe(false);
    });
});
