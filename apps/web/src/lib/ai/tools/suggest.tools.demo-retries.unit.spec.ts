import { APICallError, type ToolExecutionOptions } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Platform demo mode — the suggestWorks sub-agent's retries. `suggestWorks` is always offered
 * (a `core` tool) and is the likeliest first demo turn ("help me get started"). Its sub-agent
 * runs its own `generateText` loop of up to 8 steps, and each model call is counted against the
 * demo AI quota: on a demo it makes one attempt per call. Demo off keeps its 1 retry.
 */

vi.mock('@/lib/api/work', () => ({ workAPI: { getAll: vi.fn(async () => ({ works: [] })) } }));
// The sub-agent's own tools are irrelevant here: real, inert tool definitions.
vi.mock('./search.tools', async () => {
    const { tool } = await import('ai');
    const { z } = await import('zod');
    return {
        webSearch: tool({
            description: 'search',
            inputSchema: z.object({}),
            execute: async () => ({}),
        }),
    };
});
vi.mock('./user.tools', async () => {
    const { tool } = await import('ai');
    const { z } = await import('zod');
    return {
        getUserInfo: tool({
            description: 'user',
            inputSchema: z.object({}),
            execute: async () => ({}),
        }),
    };
});

import { createSuggestWorksTool } from './suggest.tools';

/** A model whose every call fails with a retryable 503; `doGenerate` counts the attempts. */
function failingModel() {
    const doGenerate = vi.fn(async () => {
        throw new APICallError({
            message: 'upstream',
            url: 'http://api.example/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 503,
            isRetryable: true,
        });
    });
    return { model: new MockLanguageModelV3({ doGenerate }), doGenerate };
}

const CALL: ToolExecutionOptions = { toolCallId: 'call-1', messages: [] };

async function runSuggest(tool: ReturnType<typeof createSuggestWorksTool>) {
    // The SDK backs off 2 s before its retry; fake timers skip the wait.
    vi.useFakeTimers();
    try {
        const run = tool.execute!({}, CALL) as Promise<{ success: boolean }>;
        await vi.advanceTimersByTimeAsync(5_000);
        return await run;
    } finally {
        vi.useRealTimers();
    }
}

describe('suggestWorks: sub-agent retries', () => {
    afterEach(() => vi.useRealTimers());

    it('makes ONE attempt per model call with maxRetries 0 (a demo)', async () => {
        const { model, doGenerate } = failingModel();

        const result = await runSuggest(createSuggestWorksTool(model, { maxRetries: 0 }));

        expect(result.success).toBe(false);
        expect(doGenerate).toHaveBeenCalledTimes(1);
    });

    it('demo off: keeps its 1 retry (two attempts for a 503), the default as before', async () => {
        const { model, doGenerate } = failingModel();

        const result = await runSuggest(createSuggestWorksTool(model));

        expect(result.success).toBe(false);
        expect(doGenerate).toHaveBeenCalledTimes(2);
    });

    it('an explicit 1 is the same as the default', async () => {
        const { model, doGenerate } = failingModel();

        await runSuggest(createSuggestWorksTool(model, { maxRetries: 1 }));

        expect(doGenerate).toHaveBeenCalledTimes(2);
    });
});
