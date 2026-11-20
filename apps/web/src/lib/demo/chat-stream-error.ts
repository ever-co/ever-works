import 'server-only';
import { APICallError, RetryError } from 'ai';
import { demoErrorKeyFromText } from './demo-errors';

/** What the AI SDK itself puts on the stream for an error `onError` does not translate. */
export const CHAT_STREAM_DEFAULT_ERROR = 'An error occurred.';

/**
 * The API's own answer inside whatever `streamText` failed with. The SDK retries a retryable
 * `APICallError` (429, 5xx, 408, 409) twice by default, so a refused demo call normally reaches
 * `onError` as a `RetryError` (`errors[]`, `lastError`), which has no status or body of its own;
 * a non-retryable status, or `maxRetries: 0`, arrives as the bare `APICallError`. The call that
 * ended it is the last one, so `lastError` is read first, then the earlier attempts, and an
 * error wrapped one `cause` deep (the SDK's retry-header reader looks there too).
 */
function apiCallErrorOf(error: unknown): APICallError | null {
    if (APICallError.isInstance(error)) return error;
    if (RetryError.isInstance(error)) {
        for (const attempt of [error.lastError, ...[...error.errors].reverse()]) {
            if (APICallError.isInstance(attempt)) return attempt;
        }
    }
    const cause = (error as { cause?: unknown } | null | undefined)?.cause;
    return APICallError.isInstance(cause) ? cause : null;
}

/**
 * The text a chat stream carries for a failed model call. The route's `onError` keeps the API's
 * status, `code` and `retryAfterMs` as JSON for a demo code (the client maps it to a friendly
 * message, `useDemoErrorMessage`) and leaves every other error as the SDK's own default.
 */
export function chatStreamErrorText(error: unknown): string {
    const apiError = apiCallErrorOf(error);
    const responseBody = apiError?.responseBody;
    if (typeof responseBody !== 'string' || !demoErrorKeyFromText(responseBody)) {
        return CHAT_STREAM_DEFAULT_ERROR;
    }
    const body = JSON.parse(responseBody) as {
        statusCode?: unknown;
        code?: unknown;
        error?: { code?: unknown };
        retryAfterMs?: unknown;
    };
    return JSON.stringify({
        statusCode: apiError?.statusCode ?? body.statusCode,
        code: body.code ?? body.error?.code,
        ...(typeof body.retryAfterMs === 'number' && { retryAfterMs: body.retryAfterMs }),
    });
}
