import { APICallError, RetryError, streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
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

/** A real `APICallError`, as the SDK throws for a non-2xx answer of the API. */
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

/** What the SDK throws once its retries are spent: a real `RetryError` over the attempts. */
function retryError(errors: unknown[]) {
    return new RetryError({
        message: `Failed after ${errors.length} attempts`,
        reason: 'maxRetriesExceeded',
        errors,
    });
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

    it('unwraps a RetryError (the shape a retried 429 or 503 really arrives as)', async () => {
        const busy = apiCallError(429, {
            statusCode: 429,
            code: 'DEMO_AI_BUSY',
            message: 'busy',
            retryAfterMs: 4000,
        });
        apiError.current = retryError([busy, busy, busy]);
        expect(JSON.parse(await (await POST(chatRequest())).text())).toEqual({
            statusCode: 429,
            code: 'DEMO_AI_BUSY',
            retryAfterMs: 4000,
        });

        const unavailable = apiCallError(503, { statusCode: 503, code: 'DEMO_MODEL_UNAVAILABLE' });
        apiError.current = retryError([apiCallError(500, { message: 'boom' }), unavailable]);
        expect(JSON.parse(await (await POST(chatRequest())).text())).toEqual({
            statusCode: 503,
            code: 'DEMO_MODEL_UNAVAILABLE',
        });
    });

    it('a RetryError over non-demo errors is exactly the SDK default text', async () => {
        const throttled = apiCallError(429, {
            statusCode: 429,
            code: 'THROTTLED',
            message: 'slow',
        });
        apiError.current = retryError([throttled, throttled, throttled]);
        expect(await (await POST(chatRequest())).text()).toBe('An error occurred.');

        apiError.current = retryError([new Error('socket hang up'), new Error('socket hang up')]);
        expect(await (await POST(chatRequest())).text()).toBe('An error occurred.');
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

describe('chat stream errors through the real streamText', () => {
    async function streamFailingWith(error: unknown) {
        const model = new MockLanguageModelV3({
            doStream: async () => {
                throw error;
            },
        });
        const result = streamText({ model, prompt: 'hi', maxRetries: 2, onError: () => undefined });
        const { chatStreamErrorText } = await import('@/lib/demo/chat-stream-error');
        const body = await result
            .toUIMessageStreamResponse({ onError: chatStreamErrorText })
            .text();
        return body
            .split(String.fromCharCode(10))
            .filter((line) => line.startsWith('data: {'))
            .map((line) => JSON.parse(line.slice(6)) as { type: string; errorText?: string })
            .find((chunk) => chunk.type === 'error')?.errorText;
    }

    it('a retried demo 429 arrives as the demo payload (a RetryError after the retries)', async () => {
        const busy = new APICallError({
            message: 'busy',
            url: 'http://api.example/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 429,
            // Zero wait between the SDK's retries (it honours retry-after-ms).
            responseHeaders: { 'retry-after-ms': '0' },
            responseBody: JSON.stringify({
                statusCode: 429,
                code: 'DEMO_AI_BUSY',
                message: 'busy',
                retryAfterMs: 4000,
            }),
            isRetryable: true,
        });

        const errorText = await streamFailingWith(busy);

        expect(JSON.parse(errorText as string)).toEqual({
            statusCode: 429,
            code: 'DEMO_AI_BUSY',
            retryAfterMs: 4000,
        });
    });

    it('a non-demo failure stays the SDK default text', async () => {
        const error = new APICallError({
            message: 'x',
            url: 'http://api.example/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 400,
            responseBody: JSON.stringify({ message: 'bad request' }),
            isRetryable: false,
        });

        expect(await streamFailingWith(error)).toBe('An error occurred.');
    });
});
