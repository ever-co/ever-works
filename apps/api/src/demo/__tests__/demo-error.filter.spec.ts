import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import {
    DemoError,
    DemoFeatureDisabledError,
    DemoModelNotAllowedError,
    DemoModelUnavailableError,
    DemoQuotaExceededError,
    DemoRateLimitedError,
} from '@ever-works/agent/demo';
import { DemoErrorFilter } from '../demo-error.filter';

/**
 * Platform demo mode — every `DemoError` that reaches the HTTP layer becomes
 * `{ statusCode, code, message, retryAfterMs? }` with the error's own status,
 * and a `Retry-After` header (whole seconds, rounded up) when it carries a wait.
 */
describe('DemoErrorFilter', () => {
    let reply: jest.Mock;
    let setHeader: jest.Mock;
    let filter: DemoErrorFilter;
    const response = { res: true };
    let host: ArgumentsHost;

    beforeEach(() => {
        reply = jest.fn();
        setHeader = jest.fn();
        filter = new DemoErrorFilter({
            httpAdapter: { reply, setHeader },
        } as unknown as HttpAdapterHost);
        host = {
            switchToHttp: () => ({
                getRequest: () => ({}),
                getResponse: () => response,
            }),
        } as unknown as ArgumentsHost;
    });

    it('catches DemoError and every subclass', () => {
        expect(Reflect.getMetadata('__filterCatchExceptions__', DemoErrorFilter)).toEqual([
            DemoError,
        ]);
    });

    // R42 f: which limit was hit rides along as `quotaScope`, so the web can say "for today" only
    // for the instance's day and "this workspace" for the sandbox's own cap.
    it.each(['day', 'sandbox'] as const)(
        'answers a used-up %s quota with 429 DEMO_AI_QUOTA, its message and which limit it was',
        (scope) => {
            const error = new DemoQuotaExceededError(scope);
            filter.catch(error, host);

            expect(reply).toHaveBeenCalledWith(
                response,
                {
                    statusCode: 429,
                    code: 'DEMO_AI_QUOTA',
                    message: error.message,
                    quotaScope: scope,
                },
                429,
            );
            expect(setHeader).not.toHaveBeenCalled();
        },
    );

    it('names a quota scope only for a used-up quota', () => {
        for (const error of [
            new DemoFeatureDisabledError('api keys'),
            new DemoRateLimitedError(1_000),
            new DemoModelUnavailableError('m:free'),
        ]) {
            reply.mockClear();
            filter.catch(error, host);
            expect(reply.mock.calls[0][1]).not.toHaveProperty('quotaScope');
        }
    });

    it('answers a disabled feature with 403 DEMO_DISABLED', () => {
        const error = new DemoFeatureDisabledError('api keys');
        filter.catch(error, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                statusCode: 403,
                code: 'DEMO_DISABLED',
                message: 'Not available in the demo: api keys',
            },
            403,
        );
    });

    it('answers a busy minute with 429 DEMO_AI_BUSY, retryAfterMs and a Retry-After header', () => {
        filter.catch(new DemoRateLimitedError(1_500), host);

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                statusCode: 429,
                code: 'DEMO_AI_BUSY',
                message: new DemoRateLimitedError(1_500).message,
                retryAfterMs: 1_500,
            },
            429,
        );
        // Whole seconds, rounded up.
        expect(setHeader).toHaveBeenCalledWith(response, 'Retry-After', '2');
    });

    it('rounds a whole-second wait to itself', () => {
        filter.catch(new DemoRateLimitedError(45_000), host);

        expect(setHeader).toHaveBeenCalledWith(response, 'Retry-After', '45');
    });

    it.each([
        [new DemoModelNotAllowedError('openai/gpt-6'), 500, 'DEMO_MODEL_NOT_ALLOWED'],
        [
            new DemoModelUnavailableError('google/gemma-4-31b-it:free'),
            503,
            'DEMO_MODEL_UNAVAILABLE',
        ],
        [new DemoError('The demo is full, try again later', 'DEMO_FULL', 503), 503, 'DEMO_FULL'],
    ])('uses the error’s own status and code (%s)', (error, status, code) => {
        filter.catch(error, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            { statusCode: status, code, message: error.message },
            status,
        );
    });
});
