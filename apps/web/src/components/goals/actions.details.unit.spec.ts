import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update, getAuth, revalidate } = vi.hoisted(() => ({
    update: vi.fn(),
    getAuth: vi.fn(),
    revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: revalidate }));
vi.mock('next/navigation', () => ({
    redirect: (path: string) => {
        throw new Error(`NEXT_REDIRECT:${path}`);
    },
}));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: () => getAuth() }));
vi.mock('@/lib/api/goals', () => ({ goalsAPI: { update } }));

import { updateGoalDetailsAction } from './actions';

/** PR #3137 — the Goal Edit dialog's server action. */
describe('updateGoalDetailsAction', () => {
    beforeEach(() => {
        update.mockReset();
        revalidate.mockReset();
        getAuth.mockReset();
        getAuth.mockResolvedValue({ id: 'u1' });
    });

    it('maps an empty description to null (clears it) and sends only what it is given', async () => {
        update.mockResolvedValue({ id: 'g1' });
        await updateGoalDetailsAction('g1', { description: '' });
        expect(update).toHaveBeenCalledWith('g1', { description: null });

        await updateGoalDetailsAction('g1', { title: 'T' });
        expect(update).toHaveBeenLastCalledWith('g1', { title: 'T' });

        await updateGoalDetailsAction('g1', { title: 'T', description: '- a' });
        expect(update).toHaveBeenLastCalledWith('g1', { title: 'T', description: '- a' });
    });

    it('answers the saved Goal as a value and refreshes the Goal pages', async () => {
        const goal = { id: 'g1', title: 'T' };
        update.mockResolvedValue(goal);
        await expect(updateGoalDetailsAction('g1', { title: 'T' })).resolves.toEqual({
            success: true,
            goal,
        });
        expect(revalidate).toHaveBeenCalledWith('/[locale]/(dashboard)/goals/g1', 'page');
    });

    it('answers an API refusal as a value (a thrown message is lost in production)', async () => {
        update.mockRejectedValue(new Error('Goal not found'));
        await expect(updateGoalDetailsAction('g1', { title: 'T' })).resolves.toEqual({
            success: false,
            error: 'Goal not found',
        });
    });

    it('sends nothing when given nothing', async () => {
        await expect(updateGoalDetailsAction('g1', {})).resolves.toEqual({
            success: false,
            error: '',
        });
        expect(update).not.toHaveBeenCalled();
    });
});
