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

export type DemoErrorKey = (typeof DEMO_ERROR_KEYS)[keyof typeof DEMO_ERROR_KEYS];

/** The `demo.errors.*` key for an API error `code`, or null for any other code. */
export function demoErrorKey(code: unknown): DemoErrorKey | null {
    return typeof code === 'string' && Object.hasOwn(DEMO_ERROR_KEYS, code)
        ? DEMO_ERROR_KEYS[code as keyof typeof DEMO_ERROR_KEYS]
        : null;
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

/** The demo `code` in a JSON error body (`{ code }` or `{ error: { code } }`), or null. */
export function demoErrorKeyFromText(text: string | null | undefined): DemoErrorKey | null {
    if (!text) return null;
    try {
        const body = JSON.parse(text) as { code?: unknown; error?: { code?: unknown } } | null;
        return demoErrorKey(body?.code ?? body?.error?.code);
    } catch {
        return null;
    }
}
