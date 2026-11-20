import { describe, expect, it, vi, beforeEach } from 'vitest';

const { quickCreateMock } = vi.hoisted(() => ({ quickCreateMock: vi.fn() }));

vi.mock('@/lib/api/works', () => ({
    worksAPI: { quickCreate: quickCreateMock },
}));

// The action branches on `ApiResponseError` (the real one is `server-only`); same stand-in as
// the sibling action specs: message + statusCode + optional code/details.
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

import { quickCreateWorkAction } from './quick-create';
import { ApiResponseError } from '@/lib/api/server-api';

const body = {
    slug: 'ai-coding-agents-x1y2z3',
    name: 'AI coding agents',
    description: 'A directory of AI coding agents',
    prompt: 'A directory of AI coding agents',
};

describe('quickCreateWorkAction', () => {
    beforeEach(() => {
        quickCreateMock.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('answers with the created Work and generation on success', async () => {
        const data = {
            status: 'pending',
            work: { id: 'w-1', slug: body.slug, name: body.name },
            generation: { historyId: 'h-1', message: 'Generation started' },
        };
        quickCreateMock.mockResolvedValue(data);

        await expect(quickCreateWorkAction(body)).resolves.toEqual({ success: true, data });
    });

    it('names each missing provider of a provider refusal, one per line, so the wizard shows what to set up', async () => {
        quickCreateMock.mockRejectedValue(
            new ApiResponseError(
                'One or more selected providers are not available.',
                400,
                undefined,
                {
                    message: 'One or more selected providers are not available.',
                    providerErrors: {
                        ai: 'Provider "openrouter" is not configured. Visit Settings → Plugins to set it up.',
                        search: 'Provider "tavily" is not configured. Visit Settings → Plugins to set it up.',
                    },
                },
            ),
        );

        const result = await quickCreateWorkAction(body);

        expect(result.success).toBe(false);
        expect(result.error).toBe(
            [
                'One or more selected providers are not available.',
                'AI provider: Provider "openrouter" is not configured. Visit Settings → Plugins to set it up.',
                'Search: Provider "tavily" is not configured. Visit Settings → Plugins to set it up.',
            ].join('\n'),
        );
    });

    it('keeps any other API error message as it is', async () => {
        quickCreateMock.mockRejectedValue(new ApiResponseError('captcha verification failed', 400));

        await expect(quickCreateWorkAction(body)).resolves.toEqual({
            success: false,
            error: 'captcha verification failed',
        });
    });
});
