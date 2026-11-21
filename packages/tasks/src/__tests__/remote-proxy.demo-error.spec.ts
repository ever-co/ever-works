import { describe, it, expect, vi, beforeEach } from 'vitest';
import superjson from 'superjson';
import {
    DemoError,
    DemoFeatureDisabledError,
    DemoModelNotAllowedError,
    DemoModelUnavailableError,
    DemoQuotaExceededError,
    DemoRateLimitedError,
    consumeDemoAiQuota,
    type DemoAiQuotaPort,
} from '@ever-works/agent/demo';

const { triggerConfig } = vi.hoisted(() => ({
    triggerConfig: {
        getInternalBaseUrl: vi.fn(),
        getInternalSecret: vi.fn(),
        getInternalRequestTimeoutMs: vi.fn(),
    },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: triggerConfig,
        // A demo worker: it sends the DEMO handshake header (asserted in its own spec).
        demo: { isEnabled: () => true },
    },
}));

import { TriggerInternalApiClient } from '../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../trigger/worker/remote-proxy';

/**
 * Platform demo mode — a worker reaches the API's `DemoAiQuotaService` through
 * `createRemoteProxy`, and the API answers a refusal as `DemoErrorFilter`'s JSON
 * (`{ statusCode, code, message, retryAfterMs? }`). The worker must surface it as
 * the matching `DemoError` subclass, so the AI facade's busy-wait and every
 * `instanceof` check behave exactly as they do in the API process.
 */

/** The body `DemoErrorFilter` sends for an error. */
const filterBody = (error: DemoError) => ({
    statusCode: error.httpStatus,
    code: error.code,
    message: error.message,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
});

const jsonResponse = (status: number, body: unknown): Response =>
    ({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
    }) as unknown as Response;

const textResponse = (status: number, body: string): Response =>
    ({
        ok: false,
        status,
        text: () => Promise.resolve(body),
    }) as unknown as Response;

describe('remote proxy — DemoError responses become DemoErrors in the worker', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let quota: DemoAiQuotaPort;

    beforeEach(() => {
        vi.clearAllMocks();
        triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com/');
        triggerConfig.getInternalSecret.mockReturnValue('secret-1');
        triggerConfig.getInternalRequestTimeoutMs.mockReturnValue(45000);
        fetchSpy = vi.fn();
        // @ts-expect-error - install fetch on global
        globalThis.fetch = fetchSpy;
        quota = createRemoteProxy(new TriggerInternalApiClient(), 'DemoAiQuotaService');
    });

    const refusalOf = async (response: Response): Promise<unknown> => {
        fetchSpy.mockResolvedValueOnce(response);
        return quota.consume('user-1').then(
            () => undefined,
            (error: unknown) => error,
        );
    };

    it('a busy minute (429 DEMO_AI_BUSY) is a DemoRateLimitedError with its retryAfterMs', async () => {
        const error = await refusalOf(
            jsonResponse(429, filterBody(new DemoRateLimitedError(12_000))),
        );

        expect(error).toBeInstanceOf(DemoRateLimitedError);
        expect(error).toMatchObject({
            code: 'DEMO_AI_BUSY',
            httpStatus: 429,
            retryAfterMs: 12_000,
        });
        // The call went out as `DemoAiQuotaService.consume('user-1')`.
        const [, init] = fetchSpy.mock.calls[0];
        const body = JSON.parse((init as { body: string }).body);
        expect(body.name).toBe('DemoAiQuotaService');
        expect(body.method).toBe('consume');
        expect(superjson.deserialize(body.args)).toEqual(['user-1']);
    });

    it.each(['sandbox', 'day'] as const)(
        'a used-up %s quota (429 DEMO_AI_QUOTA) is a DemoQuotaExceededError with that scope',
        async (scope) => {
            const sent = new DemoQuotaExceededError(scope);
            const error = await refusalOf(jsonResponse(429, filterBody(sent)));

            expect(error).toBeInstanceOf(DemoQuotaExceededError);
            expect(error).toMatchObject({
                code: 'DEMO_AI_QUOTA',
                httpStatus: 429,
                scope,
                message: sent.message,
            });
        },
    );

    it('a disabled feature (403 DEMO_DISABLED) is a DemoFeatureDisabledError naming the feature', async () => {
        const sent = new DemoFeatureDisabledError('ai (quota not configured)');
        const error = await refusalOf(jsonResponse(403, filterBody(sent)));

        expect(error).toBeInstanceOf(DemoFeatureDisabledError);
        expect(error).toMatchObject({
            code: 'DEMO_DISABLED',
            httpStatus: 403,
            feature: 'ai (quota not configured)',
            message: sent.message,
        });
    });

    it('the model refusals and DEMO_FULL keep their code, status and message', async () => {
        const notAllowed = new DemoModelNotAllowedError('openai/gpt-6');
        const unavailable = new DemoModelUnavailableError('google/gemma-4-31b-it:free');
        const full = new DemoError('The demo is full, try again later', 'DEMO_FULL', 503);

        const a = await refusalOf(jsonResponse(500, filterBody(notAllowed)));
        const b = await refusalOf(jsonResponse(503, filterBody(unavailable)));
        const c = await refusalOf(jsonResponse(503, filterBody(full)));

        expect(a).toBeInstanceOf(DemoModelNotAllowedError);
        expect(a).toMatchObject({
            code: 'DEMO_MODEL_NOT_ALLOWED',
            httpStatus: 500,
            modelId: 'openai/gpt-6',
        });
        expect((a as Error).message).toBe(notAllowed.message);
        expect(b).toBeInstanceOf(DemoModelUnavailableError);
        expect(b).toMatchObject({ code: 'DEMO_MODEL_UNAVAILABLE', httpStatus: 503 });
        expect((b as Error).message).toBe(unavailable.message);
        expect(c).toBeInstanceOf(DemoError);
        expect(c).toMatchObject({ code: 'DEMO_FULL', httpStatus: 503, message: full.message });
    });

    it('a DemoError answer is final: a 5xx one is not re-issued even for a retry-safe method', async () => {
        fetchSpy.mockResolvedValue(
            jsonResponse(503, filterBody(new DemoModelUnavailableError('x:free'))),
        );
        const client = new TriggerInternalApiClient();

        await expect(
            client.callRemote('WorkRepository', 'findById', superjson.serialize(['w1'])),
        ).rejects.toBeInstanceOf(DemoModelUnavailableError);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('any other failure keeps the generic error', async () => {
        const nestBody = {
            statusCode: 400,
            message: 'Unknown remote target: DemoAiQuotaService',
            error: 'Bad Request',
        };
        const unknownCode = { statusCode: 429, code: 'DEMO_SOMETHING_NEW', message: 'nope' };

        for (const response of [
            jsonResponse(400, nestBody),
            jsonResponse(429, unknownCode),
            textResponse(429, 'Too Many Requests'),
        ]) {
            const error = await refusalOf(response);
            expect(error).not.toBeInstanceOf(DemoError);
            expect((error as Error).message).toMatch(
                /^Trigger internal API request failed \(4\d\d\)/,
            );
        }
    });

    it("the facade's busy-wait works across the hop: wait retryAfterMs, then go", async () => {
        fetchSpy
            .mockResolvedValueOnce(jsonResponse(429, filterBody(new DemoRateLimitedError(2_500))))
            .mockResolvedValueOnce(jsonResponse(200, { result: superjson.serialize(undefined) }));
        const sleep = vi.fn(async () => undefined);

        await consumeDemoAiQuota(quota, 'user-1', 'background', sleep);

        expect(sleep).toHaveBeenCalledWith(2_500);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});
