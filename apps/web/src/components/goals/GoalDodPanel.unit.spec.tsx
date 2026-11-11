import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

const patchCriterion = vi.fn();
const addCriterion = vi.fn();
vi.mock('./actions', () => ({
    approveGoalDodAction: vi.fn(),
    patchGoalDodCriterionAction: (...args: unknown[]) => patchCriterion(...args),
    setGoalDodAction: vi.fn(),
    addGoalDodCriterionAction: (...args: unknown[]) => addCriterion(...args),
    removeGoalDodCriterionAction: vi.fn(),
}));

import { GoalDodPanel } from './GoalDodPanel';
import type { Goal } from '@/lib/api/goals';

function mkGoal(text: string, extra: Record<string, unknown> = {}): Goal {
    return {
        id: 'g1',
        dodCriteria: [{ id: 'c1', text, status: 'open', source: 'operator', ...extra }],
        dodSummary: { total: 1, done: 0, waived: 0, open: 1, proposed: 0 },
    } as unknown as Goal;
}

describe('GoalDodPanel — Markdown criteria', () => {
    beforeEach(() => {
        patchCriterion.mockReset();
        toastSuccess.mockReset();
        toastError.mockReset();
    });

    it('renders a criterion as inline Markdown and its evidence as plain text', () => {
        const { container } = render(
            <GoalDodPanel
                goal={mkGoal('Pricing page has **three** tiers, see [spec](https://x.test/spec)', {
                    evidence: '**PR** [#12](https://github.com/o/r/pull/12)',
                })}
                onGoalChange={vi.fn()}
            />,
        );
        expect(container.querySelector('li strong')?.textContent).toBe('three');
        const link = container.querySelector('li a');
        expect(link?.getAttribute('href')).toBe('https://x.test/spec');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(container.textContent).not.toContain('**');
        expect(container.textContent).toContain('evidenceLabel: PR #12');
    });

    it('edits a criterion text in place through patchGoalDodCriterionAction', async () => {
        const updated = mkGoal('Pricing page ships with `three` tiers');
        patchCriterion.mockResolvedValueOnce(updated);
        const onGoalChange = vi.fn();
        render(<GoalDodPanel goal={mkGoal('Pricing page ships')} onGoalChange={onGoalChange} />);

        fireEvent.click(screen.getByTestId('goal-dod-edit'));
        const input = screen.getByTestId('goal-dod-edit-input') as HTMLInputElement;
        expect(input.value).toBe('Pricing page ships');
        expect(input.getAttribute('aria-label')).toBe('editLabel');

        fireEvent.change(input, { target: { value: '  Pricing page ships with `three` tiers ' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => expect(onGoalChange).toHaveBeenCalledWith(updated));
        expect(patchCriterion).toHaveBeenCalledWith('g1', 'c1', {
            text: 'Pricing page ships with `three` tiers',
        });
        expect(toastSuccess).toHaveBeenCalledWith('toasts.statusSaved');
        expect(screen.queryByTestId('goal-dod-edit-input')).toBeNull();
    });

    it('Escape cancels the edit without saving; an unchanged text is not sent', () => {
        render(<GoalDodPanel goal={mkGoal('Same')} onGoalChange={vi.fn()} />);
        fireEvent.click(screen.getByTestId('goal-dod-edit'));
        fireEvent.keyDown(screen.getByTestId('goal-dod-edit-input'), { key: 'Escape' });
        expect(screen.queryByTestId('goal-dod-edit-input')).toBeNull();

        fireEvent.click(screen.getByTestId('goal-dod-edit'));
        fireEvent.keyDown(screen.getByTestId('goal-dod-edit-input'), { key: 'Enter' });
        expect(patchCriterion).not.toHaveBeenCalled();
    });
    it.each(['done', 'waived'] as const)(
        'offers no Edit on a %s criterion (its wording was signed off)',
        (status) => {
            render(<GoalDodPanel goal={mkGoal('Signed off', { status })} onGoalChange={vi.fn()} />);
            expect(screen.queryByTestId('goal-dod-edit')).toBeNull();
        },
    );

    it('keeps the typed text in the input when the save is refused', async () => {
        patchCriterion.mockRejectedValueOnce(
            new Error('Reopen this criterion before rewording it'),
        );
        const onGoalChange = vi.fn();
        render(<GoalDodPanel goal={mkGoal('Pricing page ships')} onGoalChange={onGoalChange} />);

        fireEvent.click(screen.getByTestId('goal-dod-edit'));
        fireEvent.change(screen.getByTestId('goal-dod-edit-input'), {
            target: { value: 'A better wording' },
        });
        fireEvent.keyDown(screen.getByTestId('goal-dod-edit-input'), { key: 'Enter' });

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith('Reopen this criterion before rewording it'),
        );
        expect(onGoalChange).not.toHaveBeenCalled();
        expect((screen.getByTestId('goal-dod-edit-input') as HTMLInputElement).value).toBe(
            'A better wording',
        );
    });
});
