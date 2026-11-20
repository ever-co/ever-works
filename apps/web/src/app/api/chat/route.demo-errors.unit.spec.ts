import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/constants', () => ({ API_URL: 'http://api.example' }));
vi.mock('@/lib/auth/cookies', () => ({ getAuthAccessCookie: vi.fn(async () => 'fake-jwt') }));
vi.mock('@/lib/ai/persistence', () => ({ saveConversationMessages: vi.fn(async () => undefined) }));

// The agent runtime is irrelevant; the stream response hands the route's `onError` the error
// the model call failed with and echoes what it returns, which is what the SDK puts on the stream.
const apiError = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/lib/ai/agent', () => ({
    runAgent: vi.fn(async () => ({
        consumeStream: () => undefined,
        toUIMessageStreamResponse: (options: { onError?: (error: unknown) => string }) =>
            new Response(options.onError ? options.onError(apiError.current) : 'no onError'),
    })),
}));

import { POST } from './route';

function chatRequest() {
    return new Request('http://web.example/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ever-workspace': 'personal' },
        body: JSON.stringify({
            messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
            providerOverride: 'ever-works',
        }),
    });
}

/** What the AI SDK's `APICallError` carries for a non-2xx answer of the API. */
function apiCallError(statusCode: number, body: unknown) {
    return { name: 'AI_APICallError', statusCode, responseBody: JSON.stringify(body) };
}

describe('POST /api/chat: demo error codes on the stream', () => {
    afterEach(() => vi.clearAllMocks());

    it('keeps DEMO_AI_BUSY with its status and retryAfterMs', async () => {
        apiError.current = apiCallError(429, {
            statusCode: 429,
            code: 'DEMO_AI_BUSY',
            message: 'busy',
            retryAfterMs: 4000,
        });

        const text = await (await POST(chatRequest())).text();

        expect(JSON.parse(text)).toEqual({
            statusCode: 429,
            code: 'DEMO_AI_BUSY',
            retryAfterMs: 4000,
        });
    });

    it('keeps DEMO_AI_QUOTA', async () => {
        apiError.current = apiCallError(429, {
            statusCode: 429,
            code: 'DEMO_AI_QUOTA',
            message: 'x',
        });

        const text = await (await POST(chatRequest())).text();

        expect(JSON.parse(text)).toEqual({ statusCode: 429, code: 'DEMO_AI_QUOTA' });
    });

    it('demo off: every other error is exactly the SDK default text', async () => {
        for (const error of [
            apiCallError(429, { statusCode: 429, code: 'THROTTLED', message: 'slow down' }),
            apiCallError(500, { message: 'boom' }),
            apiCallError(503, { code: 'DEMO_FULL', message: 'full' }),
            new Error('socket hang up'),
            undefined,
        ]) {
            apiError.current = error;
            expect(await (await POST(chatRequest())).text()).toBe('An error occurred.');
        }
    });
});
