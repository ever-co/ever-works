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

    it('answers a used-up quota with 429 DEMO_AI_QUOTA and its message', () => {
        const error = new DemoQuotaExceededError('day');
        filter.catch(error, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            { statusCode: 429, code: 'DEMO_AI_QUOTA', message: error.message },
            429,
        );
        expect(setHeader).not.toHaveBeenCalled();
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
