import { demoErrorKeyFromText, type DemoErrorKey } from './demo-errors';

/** Fired on `window` with `detail: DemoErrorKey` when a browser fetch got a demo error. */
export const DEMO_ERROR_EVENT = 'ever-works:demo-error';

const DEMO_STATUSES = new Set([403, 429, 503]);

/**
 * Browser side of the one demo error mapper: when a failed response carries a demo `code`,
 * announce its `demo.errors.*` key (`DemoErrorToaster` turns it into a translated toast).
 * Fire and forget: it reads a clone, never the caller's response, and any other response is
 * ignored, so callers behave exactly as before.
 */
export function reportDemoErrorResponse(response: Response): void {
    if (typeof window === 'undefined' || response.ok || !DEMO_STATUSES.has(response.status)) return;
    void response
        .clone()
        .text()
        .then((text) => {
            const key = demoErrorKeyFromText(text);
            if (key) {
                window.dispatchEvent(
                    new CustomEvent<DemoErrorKey>(DEMO_ERROR_EVENT, { detail: key }),
                );
            }
        })
        .catch(() => undefined);
}
