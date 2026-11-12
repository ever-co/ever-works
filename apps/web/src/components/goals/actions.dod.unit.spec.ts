import { beforeEach, describe, expect, it, vi } from 'vitest';

const { goalsAPI, getAuth, revalidate } = vi.hoisted(() => ({
    goalsAPI: {
        get: vi.fn(),
        setDod: vi.fn(),
        addDodCriterion: vi.fn(),
        removeDodCriterion: vi.fn(),
    },
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
vi.mock('@/lib/api/goals', () => ({ goalsAPI }));

import { addGoalDodCriterionAction, removeGoalDodCriterionAction } from './actions';

/**
 * Review of #3172 — the DoD tab's add / remove send ONE change to the API,
 * which applies it to the checklist as stored at the write. Reading the Goal
 * and replacing the whole list (`setDod`) lost a planner proposal that landed
 * between the read and the write.
 */
describe('Definition-of-Done add / remove actions', () => {
    beforeEach(() => {
        for (const fn of Object.values(goalsAPI)) fn.mockReset();
        revalidate.mockReset();
        getAuth.mockReset();
        getAuth.mockResolvedValue({ id: 'u1' });
    });

    it('adds through the single-criterion route, never by replacing the list', async () => {
        const goal = { id: 'g1' };
        goalsAPI.addDodCriterion.mockResolvedValue(goal);
        await expect(addGoalDodCriterionAction('g1', 'Write docs')).resolves.toBe(goal);
        expect(goalsAPI.addDodCriterion).toHaveBeenCalledWith('g1', 'Write docs');
        expect(goalsAPI.get).not.toHaveBeenCalled();
        expect(goalsAPI.setDod).not.toHaveBeenCalled();
        expect(revalidate).toHaveBeenCalledWith('/[locale]/(dashboard)/goals/g1', 'page');
    });

    it('removes through the single-criterion route, never by replacing the list', async () => {
        const goal = { id: 'g1' };
        goalsAPI.removeDodCriterion.mockResolvedValue(goal);
        await expect(removeGoalDodCriterionAction('g1', 'c1')).resolves.toBe(goal);
        expect(goalsAPI.removeDodCriterion).toHaveBeenCalledWith('g1', 'c1');
        expect(goalsAPI.get).not.toHaveBeenCalled();
        expect(goalsAPI.setDod).not.toHaveBeenCalled();
    });

    it('sends nothing for a signed-out caller', async () => {
        getAuth.mockResolvedValue(null);
        await expect(addGoalDodCriterionAction('g1', 'x')).rejects.toThrow('NEXT_REDIRECT');
        await expect(removeGoalDodCriterionAction('g1', 'c1')).rejects.toThrow('NEXT_REDIRECT');
        expect(goalsAPI.addDodCriterion).not.toHaveBeenCalled();
        expect(goalsAPI.removeDodCriterion).not.toHaveBeenCalled();
    });
});
