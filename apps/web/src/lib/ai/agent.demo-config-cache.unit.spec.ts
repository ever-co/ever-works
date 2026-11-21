import { APICallError, type UIMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDemoConfigCacheForTests } from '@/lib/feature-flags/demo';

/**
 * A chat turn reads the demo flag (`getDemoConfig()`) to choose its retry policy. A route
 * handler is outside a render, so `React.cache` does not dedupe it: the in-process cache in
 * `feature-flags/demo.ts` is what keeps every chat message, in production too, from costing
 * an extra `GET /api/config`. The real demo config module runs here; only `fetch` is stubbed.
 */

const mocks = vi.hoisted(() => ({ model: { current: undefined as unknown } }));

vi.mock('./provider', () => ({
    createBackendProvider: () => ({ chatModel: () => mocks.model.current }),
}));
vi.mock('./tools', () => ({ buildChatTools: () => ({}) }));

import { runAgent } from './agent';

const fetchMock = vi.fn();
const messages: UIMessage[] = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];

/** One chat turn whose model call fails once (a non-retryable 400: no retries either way). */
async function chatTurn() {
    mocks.model.current = new MockLanguageModelV3({
        doStream: async () => {
            throw new APICallError({
                message: 'bad request',
                url: 'http://api.example/v1/chat/completions',
                requestBodyValues: {},
                statusCode: 400,
                isRetryable: false,
            });
        },
    });
    const result = await runAgent({
        messages,
        authToken: 'fake-jwt',
        providerOverride: 'ever-works',
    });
    await result.consumeStream({ onError: () => undefined });
}

const configCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/config')).length;

describe('runAgent: the demo flag is not re-read on every chat turn', () => {
    beforeEach(() => {
        resetDemoConfigCacheForTests();
        fetchMock.mockReset().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ features: { demoMode: false }, demo: null }),
        });
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('two chat turns within the TTL read GET /api/config once', async () => {
        await chatTurn();
        await chatTurn();

        expect(configCalls()).toBe(1);
    });
});
