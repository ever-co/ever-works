import { APICallError, type UIMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoConfig } from '@/lib/feature-flags/demo';

/**
 * Platform demo mode — the chat turn's upstream retries.
 *
 * Every attempt of a chat turn is a call to the API's `/v1/chat/completions`, and on a demo
 * each one is counted against the sandbox's and the day's AI quota. The AI SDK re-issues a
 * failed call twice by default (an upstream 502/503, and a 429 such as `DEMO_AI_QUOTA`), so a
 * single message could spend three quota units, or wait ~6 s for a refusal that cannot change.
 * On a demo the turn makes ONE attempt; with demo off the SDK's default stays as it was.
 */

const mocks = vi.hoisted(() => ({
    getDemoConfig: vi.fn<() => Promise<DemoConfig>>(),
    model: { current: undefined as unknown },
    buildChatTools: vi.fn((_model: unknown, _options?: { suggestMaxRetries?: number }) => ({})),
}));

vi.mock('@/lib/feature-flags/demo', () => ({ getDemoConfig: mocks.getDemoConfig }));
vi.mock('./provider', () => ({
    createBackendProvider: () => ({ chatModel: () => mocks.model.current }),
}));
// An empty tool set keeps the suite light; the options it is built with carry the sub-agent's
// retry policy (`suggestWorks`, asserted below and in `tools/suggest.tools.demo-retries`).
vi.mock('./tools', () => ({ buildChatTools: mocks.buildChatTools }));

import { runAgent } from './agent';

const DEMO_ON: DemoConfig = {
    enabled: true,
    signUpUrl: 'https://app.ever.works/register',
    sandboxTtlHours: 24,
};
const DEMO_OFF: DemoConfig = { ...DEMO_ON, enabled: false };

/** A real `APICallError`, as the OpenAI-compatible provider throws for a non-2xx answer. */
function apiCallError(statusCode: number, body: unknown) {
    return new APICallError({
        message: 'API call failed',
        url: 'http://api.example/v1/chat/completions',
        requestBodyValues: {},
        statusCode,
        responseBody: JSON.stringify(body),
        // The SDK's own default: 429 and 5xx are retryable.
        isRetryable: statusCode === 429 || statusCode >= 500,
    });
}

/** A model whose every call fails with `error`; `doStream` counts the attempts. */
function failingModel(error: unknown) {
    const doStream = vi.fn(async () => {
        throw error;
    });
    mocks.model.current = new MockLanguageModelV3({ doStream });
    return doStream;
}

const messages: UIMessage[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];

/** Run one chat turn to its end; the SDK reports the failed call through `onError`. */
async function runTurn() {
    const result = await runAgent({
        messages,
        authToken: 'fake-jwt',
        providerOverride: 'ever-works',
    });
    await result.consumeStream({ onError: () => undefined });
}

describe('runAgent: upstream retries on a demo', () => {
    beforeEach(() => {
        mocks.getDemoConfig.mockReset();
        mocks.buildChatTools.mockClear();
    });
    afterEach(() => vi.useRealTimers());

    it('makes ONE attempt on a demo when the API answers 503 (no retry charges the quota again)', async () => {
        mocks.getDemoConfig.mockResolvedValue(DEMO_ON);
        const doStream = failingModel(apiCallError(503, { statusCode: 503, message: 'upstream' }));

        await runTurn();

        expect(doStream).toHaveBeenCalledTimes(1);
    });

    it('does not retry a DEMO_AI_QUOTA refusal on a demo', async () => {
        mocks.getDemoConfig.mockResolvedValue(DEMO_ON);
        const doStream = failingModel(
            apiCallError(429, { statusCode: 429, code: 'DEMO_AI_QUOTA', message: 'used up' }),
        );

        await runTurn();

        expect(doStream).toHaveBeenCalledTimes(1);
    });

    it("demo off: keeps the SDK's default retries (three attempts for a 503)", async () => {
        mocks.getDemoConfig.mockResolvedValue(DEMO_OFF);
        const doStream = failingModel(apiCallError(503, { statusCode: 503, message: 'upstream' }));
        // The SDK backs off 2 s, then 4 s, between attempts; fake timers skip the wait.
        vi.useFakeTimers();
        try {
            const turn = runTurn();
            await vi.advanceTimersByTimeAsync(10_000);
            await turn;
        } finally {
            vi.useRealTimers();
        }

        expect(doStream).toHaveBeenCalledTimes(3);
    });

    it('builds the tools with the demo retry policy: the suggestWorks sub-agent gets 0 retries', async () => {
        mocks.getDemoConfig.mockResolvedValue(DEMO_ON);
        failingModel(apiCallError(503, { statusCode: 503, message: 'upstream' }));

        await runTurn();

        expect(mocks.buildChatTools).toHaveBeenCalledTimes(1);
        expect(mocks.buildChatTools.mock.calls[0][1]).toMatchObject({ suggestMaxRetries: 0 });
    });

    it('demo off: the suggestWorks sub-agent keeps its 1 retry', async () => {
        mocks.getDemoConfig.mockResolvedValue(DEMO_OFF);
        failingModel(apiCallError(400, { statusCode: 400, message: 'bad request' }));

        await runTurn();

        expect(mocks.buildChatTools.mock.calls[0][1]).toMatchObject({ suggestMaxRetries: 1 });
    });

    it('reads the demo flag through the shared demo config, once per turn', async () => {
        mocks.getDemoConfig.mockResolvedValue(DEMO_ON);
        failingModel(apiCallError(503, { statusCode: 503, message: 'upstream' }));

        await runTurn();

        expect(mocks.getDemoConfig).toHaveBeenCalledTimes(1);
    });
});
