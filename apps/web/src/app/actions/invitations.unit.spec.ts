import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/api/invitations', () => ({
    invitationsAPI: { create: createMock, list: vi.fn(), revoke: vi.fn() },
}));

import { createInvitation } from './invitations';

/** What `serverFetch` throws for a failed API answer (`ApiResponseError`'s shape). */
function apiError(message: string, statusCode: number, code?: string): Error {
    return Object.assign(new Error(message), { name: 'ApiResponseError', statusCode, code });
}

/**
 * Platform demo mode (R42 e): a demo sandbox's Work invitation is refused with `DEMO_DISABLED`,
 * and `serverFetch` has already put the friendly `demo.errors.disabled` text on the error. The
 * action keeps that text instead of its generic one; every other failure still answers the
 * generic message, so nothing else about the API's error leaks.
 */
describe('createInvitation', () => {
    beforeEach(() => vi.clearAllMocks());

    it('keeps the friendly demo message for a DEMO_DISABLED refusal', async () => {
        createMock.mockRejectedValue(
            apiError('Not available in the demo — sign up to use it', 403, 'DEMO_DISABLED'),
        );
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(
            createInvitation('w-1', { email: 'a@example.test', role: 'editor' } as never),
        ).resolves.toEqual({
            ok: false,
            error: 'Not available in the demo — sign up to use it',
        });
    });

    it.each([
        ['another API refusal', apiError('email already invited', 409, 'ALREADY_INVITED')],
        ['a 403 without a demo code', apiError('Forbidden', 403)],
        ['a network failure', new TypeError('fetch failed')],
    ])('answers the generic message for %s, as before', async (_label, error) => {
        createMock.mockRejectedValue(error);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(
            createInvitation('w-1', { email: 'a@example.test', role: 'editor' } as never),
        ).resolves.toEqual({
            ok: false,
            error: 'Failed to send invitation. Please try again.',
        });
    });
});
