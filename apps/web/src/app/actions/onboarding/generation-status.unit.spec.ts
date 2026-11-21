import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getWork, getAuthFromCookie } = vi.hoisted(() => ({
    getWork: vi.fn(),
    getAuthFromCookie: vi.fn(),
}));

vi.mock('@/lib/api/work', () => ({ workAPI: { get: getWork } }));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie }));
// The real `ApiResponseError` is `server-only`; same stand-in as the sibling action specs.
vi.mock('@/lib/api/server-api', () => ({
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
            public readonly details?: Record<string, unknown>,
        ) {
            super(message);
            this.name = 'ApiResponseError';
        }
    },
}));

import { getWorkGenerationStatusAction } from './generation-status';
import { ApiResponseError } from '@/lib/api/server-api';

describe('getWorkGenerationStatusAction — what the onboarding console polls', () => {
    beforeEach(() => {
        getWork.mockReset();
        getAuthFromCookie.mockReset();
        getAuthFromCookie.mockResolvedValue({ id: 'u-1' });
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('answers only the generation status of the Work', async () => {
        getWork.mockResolvedValue({
            work: {
                id: 'w-1',
                name: 'AI robots',
                generateStatus: { status: 'generating', stepIndex: 2 },
            },
        });

        await expect(getWorkGenerationStatusAction('w-1')).resolves.toEqual({
            ok: true,
            status: { status: 'generating', stepIndex: 2 },
        });
        expect(getWork).toHaveBeenCalledWith('w-1');
    });

    it('answers an empty status while the job is still queued', async () => {
        getWork.mockResolvedValue({ work: { id: 'w-1', generateStatus: null } });

        await expect(getWorkGenerationStatusAction('w-1')).resolves.toEqual({
            ok: true,
            status: {},
        });
    });

    it('says the session is gone, without calling the API, when there is no session', async () => {
        getAuthFromCookie.mockResolvedValue(null);

        await expect(getWorkGenerationStatusAction('w-1')).resolves.toEqual({
            ok: false,
            reason: 'unauthenticated',
        });
        expect(getWork).not.toHaveBeenCalled();
    });

    it('says the session is gone on a 401', async () => {
        getWork.mockRejectedValue(new ApiResponseError('Unauthorized', 401));

        await expect(getWorkGenerationStatusAction('w-1')).resolves.toEqual({
            ok: false,
            reason: 'unauthenticated',
        });
    });

    it.each([403, 404])('says the Work is not there on a %i', async (statusCode) => {
        getWork.mockRejectedValue(new ApiResponseError('Not found', statusCode));

        await expect(getWorkGenerationStatusAction('w-1')).resolves.toEqual({
            ok: false,
            reason: 'not-found',
        });
    });

    it('reports anything else as a transient error', async () => {
        getWork.mockRejectedValueOnce(new ApiResponseError('Bad gateway', 502));
        getWork.mockRejectedValueOnce(new TypeError('fetch failed'));

        await expect(getWorkGenerationStatusAction('w-1')).resolves.toEqual({
            ok: false,
            reason: 'error',
        });
        await expect(getWorkGenerationStatusAction('w-1')).resolves.toEqual({
            ok: false,
            reason: 'error',
        });
    });
});
