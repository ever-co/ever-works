import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DemoError } from '@ever-works/agent/demo';

/**
 * Platform demo mode — maps every `DemoError` that reaches the HTTP layer to
 * `{ statusCode, code, message, retryAfterMs? }` with the error's own `httpStatus`
 * (`DEMO_DISABLED` 403, `DEMO_AI_QUOTA` / `DEMO_AI_BUSY` 429, `DEMO_FULL` 503, …). When the
 * error carries `retryAfterMs` the response also has a `Retry-After` header, in whole
 * seconds rounded up.
 *
 * Without it a `DemoError` is a plain `Error` to Nest, and its default filter answers 500.
 * The messages are the demo's own caller-facing copy, so they are surfaced as is. The same
 * body is what a Trigger worker reads back from `remote/call` and turns into the matching
 * `DemoError` again (`packages/tasks/src/trigger/worker/demo-remote-error.ts`).
 *
 * Registered globally by `DemoModule`, only when `DEMO` is on.
 */
@Catch(DemoError)
export class DemoErrorFilter implements ExceptionFilter {
    constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

    catch(exception: DemoError, host: ArgumentsHost): void {
        const { httpAdapter } = this.httpAdapterHost;
        const response = host.switchToHttp().getResponse();
        const body: { statusCode: number; code: string; message: string; retryAfterMs?: number } = {
            statusCode: exception.httpStatus,
            code: exception.code,
            message: exception.message,
        };
        const retryAfterMs = exception.retryAfterMs;
        if (
            typeof retryAfterMs === 'number' &&
            Number.isFinite(retryAfterMs) &&
            retryAfterMs >= 0
        ) {
            body.retryAfterMs = retryAfterMs;
            httpAdapter.setHeader(response, 'Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        }
        httpAdapter.reply(response, body, exception.httpStatus);
    }
}
