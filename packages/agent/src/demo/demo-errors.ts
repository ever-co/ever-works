/**
 * Platform demo mode (`DEMO=true`) — the errors a demo instance answers with.
 *
 * Each carries the JSON `code` and HTTP status the API maps it to (see
 * docs/specs/features/platform-demo-mode). Plain `Error` subclasses with no
 * Nest dependency, so the API process and the Trigger.dev workers share them.
 */

export type DemoErrorCode =
    | 'DEMO_DISABLED'
    | 'DEMO_FULL'
    | 'DEMO_AI_QUOTA'
    | 'DEMO_AI_BUSY'
    | 'DEMO_MODEL_NOT_ALLOWED'
    | 'DEMO_MODEL_UNAVAILABLE';

export class DemoError extends Error {
    constructor(
        message: string,
        readonly code: DemoErrorCode,
        readonly httpStatus: number,
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = new.target.name;
    }
}

/** A feature the demo does not offer (`DEMO_DISABLED`, 403). */
export class DemoFeatureDisabledError extends DemoError {
    constructor(readonly feature: string) {
        super(`Not available in the demo: ${feature}`, 'DEMO_DISABLED', 403);
    }
}

/** The sandbox's or the instance's daily AI requests are used up (`DEMO_AI_QUOTA`, 429). */
export class DemoQuotaExceededError extends DemoError {
    constructor(readonly scope: 'sandbox' | 'day') {
        super(
            scope === 'sandbox'
                ? 'This demo workspace has used all its live AI requests'
                : 'Live AI is used up for today in the demo',
            'DEMO_AI_QUOTA',
            429,
        );
    }
}

/** The demo's per-minute AI limit is reached; retry after `retryAfterMs` (`DEMO_AI_BUSY`, 429). */
export class DemoRateLimitedError extends DemoError {
    constructor(retryAfterMs: number) {
        super('The demo AI is busy, retry in a few seconds', 'DEMO_AI_BUSY', 429, retryAfterMs);
    }
}

/** No free (`:free`) model is configured for the call: fail closed (`DEMO_MODEL_NOT_ALLOWED`, 500). */
export class DemoModelNotAllowedError extends DemoError {
    constructor(readonly modelId: string) {
        super(
            `No free model is configured for the demo (requested '${modelId}')`,
            'DEMO_MODEL_NOT_ALLOWED',
            500,
        );
    }
}

/** The configured free model is gone upstream (`DEMO_MODEL_UNAVAILABLE`, 503). */
export class DemoModelUnavailableError extends DemoError {
    constructor(readonly modelId: string) {
        super('The demo AI model is temporarily unavailable', 'DEMO_MODEL_UNAVAILABLE', 503);
    }
}
