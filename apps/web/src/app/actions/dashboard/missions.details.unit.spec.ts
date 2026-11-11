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
vi.mock('@/lib/api/missions', () => ({ missionsAPI: { update } }));
vi.mock('@/lib/api/tasks', () => ({ tasksAPI: {} }));

import { updateMissionDetailsAction } from './missions';

/** PR #3137 — the Mission Edit dialog's server action. */
describe('updateMissionDetailsAction', () => {
    beforeEach(() => {
        update.mockReset();
        revalidate.mockReset();
        getAuth.mockReset();
        getAuth.mockResolvedValue({ id: 'u1' });
    });

    it('sends only the fields it is given', async () => {
        update.mockResolvedValue({ id: 'm1', title: 'New' });
        await updateMissionDetailsAction('m1', { title: 'New' });
        expect(update).toHaveBeenCalledWith('m1', { title: 'New' });

        await updateMissionDetailsAction('m1', { description: '## D' });
        expect(update).toHaveBeenLastCalledWith('m1', { description: '## D' });
    });

    it('answers the saved Mission as a value and refreshes the Mission pages', async () => {
        const mission = { id: 'm1', title: 'New', description: 'd' };
        update.mockResolvedValue(mission);
        await expect(
            updateMissionDetailsAction('m1', { title: 'New', description: 'd' }),
        ).resolves.toEqual({ success: true, mission });
        expect(revalidate).toHaveBeenCalledWith('/[locale]/(dashboard)/missions/m1', 'page');
    });

    it('answers an API refusal as a value (a thrown message is lost in production)', async () => {
        update.mockRejectedValue(
            new Error('title must be shorter than or equal to 200 characters'),
        );
        await expect(updateMissionDetailsAction('m1', { title: 'x' })).resolves.toEqual({
            success: false,
            error: 'title must be shorter than or equal to 200 characters',
        });
        update.mockRejectedValue('not an Error');
        await expect(updateMissionDetailsAction('m1', { title: 'x' })).resolves.toEqual({
            success: false,
            error: '',
        });
    });

    it('sends nothing when given nothing', async () => {
        await expect(updateMissionDetailsAction('m1', {})).resolves.toEqual({
            success: false,
            error: '',
        });
        expect(update).not.toHaveBeenCalled();
    });

    it('redirects an unauthenticated caller before any request', async () => {
        getAuth.mockResolvedValue(null);
        await expect(updateMissionDetailsAction('m1', { title: 'x' })).rejects.toThrow(
            'NEXT_REDIRECT',
        );
        expect(update).not.toHaveBeenCalled();
    });
});
