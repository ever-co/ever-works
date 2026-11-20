import {
    DemoError,
    DemoFeatureDisabledError,
    DemoModelNotAllowedError,
    DemoModelUnavailableError,
    DemoQuotaExceededError,
    DemoRateLimitedError,
} from '@ever-works/agent/demo';

const DISABLED_PREFIX = 'Not available in the demo: ';
const SANDBOX_QUOTA_MESSAGE = new DemoQuotaExceededError('sandbox').message;

/**
 * Platform demo mode — rebuild the `DemoError` an API answer stands for.
 *
 * The API's `DemoErrorFilter` answers a refusal (e.g. from `DemoAiQuotaService.consume`
 * over `remote/call`) with `{ statusCode, code, message, retryAfterMs? }`. Thrown in the
 * worker as the matching subclass, it behaves exactly as it would in the API process: the
 * AI facade's busy-wait reads `retryAfterMs`, and `instanceof` checks (the KB embed task's
 * `DemoFeatureDisabledError`, the quota's `scope`) hold.
 *
 * Returns null for anything else — a body that is not JSON, has no `code`, or a code this
 * worker does not know — so the caller keeps its generic error.
 */
export function demoErrorFromResponseBody(text: string): DemoError | null {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object') return null;

    const { code, message, retryAfterMs } = body as Record<string, unknown>;
    const said = typeof message === 'string' ? message : '';
    let error: DemoError;
    switch (code) {
        case 'DEMO_DISABLED':
            error = new DemoFeatureDisabledError(
                said.startsWith(DISABLED_PREFIX) ? said.slice(DISABLED_PREFIX.length) : said,
            );
            break;
        case 'DEMO_AI_QUOTA':
            error = new DemoQuotaExceededError(said === SANDBOX_QUOTA_MESSAGE ? 'sandbox' : 'day');
            break;
        case 'DEMO_AI_BUSY': {
            const ms = Number(retryAfterMs);
            error = new DemoRateLimitedError(Number.isFinite(ms) && ms >= 0 ? ms : 0);
            break;
        }
        case 'DEMO_MODEL_NOT_ALLOWED':
            error = new DemoModelNotAllowedError(/requested '([^']*)'/.exec(said)?.[1] ?? '');
            break;
        case 'DEMO_MODEL_UNAVAILABLE':
            error = new DemoModelUnavailableError('');
            break;
        case 'DEMO_FULL':
            error = new DemoError(said, 'DEMO_FULL', 503);
            break;
        default:
            return null;
    }
    // The API's own wording wins: it is the copy the caller is shown.
    if (said) error.message = said;
    return error;
}
