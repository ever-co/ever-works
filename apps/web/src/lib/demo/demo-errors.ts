/**
 * Platform demo mode — the API's demo error codes (`DemoErrorFilter`) that the web turns into a
 * friendly message, mapped to their `demo.errors.*` key. `DEMO_FULL` is not here: the demo login
 * card owns it (`app/actions/demo/start-demo.ts`).
 */
const DEMO_ERROR_KEYS = {
    DEMO_DISABLED: 'disabled',
    DEMO_AI_QUOTA: 'aiQuota',
    DEMO_AI_BUSY: 'aiBusy',
    DEMO_MODEL_UNAVAILABLE: 'modelUnavailable',
} as const;

/**
 * A `demo.errors.*` key. `DEMO_AI_QUOTA` has two: `aiQuota` for the instance's UTC day (the API's
 * `quotaScope: 'day'`, or no scope at all) and `aiQuotaSandbox` for the sandbox's own cap, which
 * lasts its whole life and is not "for today".
 */
export type DemoErrorKey =
    | (typeof DEMO_ERROR_KEYS)[keyof typeof DEMO_ERROR_KEYS]
    | 'aiQuotaSandbox';

/** Where demo visitors sign up when the instance names nowhere else (`DEMO_SIGN_UP_URL`'s default). */
export const DEFAULT_DEMO_SIGN_UP_URL = 'https://app.ever.works/register';

/**
 * The `demo.errors.*` key for an API error `code` (and, for a used-up quota, its `quotaScope`),
 * or null for any other code.
 */
export function demoErrorKey(code: unknown, quotaScope?: unknown): DemoErrorKey | null {
    if (typeof code !== 'string' || !Object.hasOwn(DEMO_ERROR_KEYS, code)) return null;
    const key = DEMO_ERROR_KEYS[code as keyof typeof DEMO_ERROR_KEYS];
    return key === 'aiQuota' && quotaScope === 'sandbox' ? 'aiQuotaSandbox' : key;
}

/**
 * The values every `demo.errors.*` message may use: `{signUpHost}`, the host of the instance's
 * sign-up URL (`DEMO_SIGN_UP_URL`, from the web's demo config), or the default's when there is
 * none to read.
 */
export function demoErrorValues(signUpUrl: string | null | undefined): { signUpHost: string } {
    return { signUpHost: hostOf(signUpUrl) ?? (hostOf(DEFAULT_DEMO_SIGN_UP_URL) as string) };
}

function hostOf(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).host || null;
    } catch {
        return null;
    }
}

/**
 * The friendly message an API error already carries for a demo code, or null for any other error.
 * `serverFetch` puts the translated `demo.errors.*` text on the `ApiResponseError` it throws, so a
 * server action that otherwise answers a generic message can keep the demo's own.
 */
export function demoErrorMessageOf(error: unknown): string | null {
    if (!(error instanceof Error)) return null;
    return demoErrorKey((error as { code?: unknown }).code) ? error.message : null;
}

/**
 * The demo key of a JSON error body (`{ code, quotaScope? }` or `{ error: { code } }`), or null.
 */
export function demoErrorKeyFromText(text: string | null | undefined): DemoErrorKey | null {
    if (!text) return null;
    try {
        const body = JSON.parse(text) as {
            code?: unknown;
            quotaScope?: unknown;
            error?: { code?: unknown };
        } | null;
        return demoErrorKey(body?.code ?? body?.error?.code, body?.quotaScope);
    } catch {
        return null;
    }
}
