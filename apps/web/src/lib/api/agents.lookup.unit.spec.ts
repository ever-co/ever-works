import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review of #3172 — `agentsAPI.lookup` tells a 404 (the Agent is gone, or no
 * longer the caller's) from a read that failed, which `get` answers alike as
 * `null`. The Goal page reports only the first as a deleted pinned Agent.
 */

const { serverFetchMock, ApiResponseError } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
        ) {
            super(message);
        }
    },
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: vi.fn(),
    ApiResponseError,
}));

import { agentsAPI } from './agents';

describe('agentsAPI.lookup', () => {
    beforeEach(() => {
        serverFetchMock.mockReset();
    });

    it('answers found with the Agent, read from its own path segment', async () => {
        serverFetchMock.mockResolvedValue({ id: 'a/1', name: 'A' });
        await expect(agentsAPI.lookup('a/1')).resolves.toEqual({
            status: 'found',
            agent: { id: 'a/1', name: 'A' },
        });
        expect(serverFetchMock).toHaveBeenCalledWith('/agents/a%2F1', { method: 'GET' });
    });

    it('answers missing for a 404 only', async () => {
        serverFetchMock.mockRejectedValue(new ApiResponseError('Agent not found', 404));
        await expect(agentsAPI.lookup('a1')).resolves.toEqual({ status: 'missing' });
    });

    it('answers unknown for any other failure', async () => {
        serverFetchMock.mockRejectedValueOnce(new ApiResponseError('down', 503));
        await expect(agentsAPI.lookup('a1')).resolves.toEqual({ status: 'unknown' });
        serverFetchMock.mockRejectedValueOnce(new Error('fetch failed'));
        await expect(agentsAPI.lookup('a1')).resolves.toEqual({ status: 'unknown' });
    });
});
