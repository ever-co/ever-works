import { parseByteSize } from '../email/inbound-email-body-limit';

/**
 * The request-body limit for the account IMPORT routes (Settings → Data →
 * import an account export).
 *
 * The API parses JSON bodies with a tight global limit (1 MB, `BODY_LIMIT`,
 * see `main.ts`) so a small endpoint cannot be used to make the parser buffer
 * large bodies (M-19). An account export is the one signed-in payload that is
 * legitimately large: Works, items, Tasks, chat, Agents, Skills… — so any
 * export over 1 MB could be exported but never imported back (413 before the
 * controller ran).
 *
 * `main.ts` mounts a JSON parser with THIS limit on {@link ACCOUNT_IMPORT_PATHS}
 * only, ahead of the global one; every other route keeps the tight limit.
 * Default 25 MB — the `proxy-body-size` the Ever Works ingress allows on every
 * environment (as for the inbound-email webhooks), so a body the ingress lets
 * through is no longer refused here. `ACCOUNT_IMPORT_BODY_LIMIT` may change it
 * up to a hard ceiling; an invalid or over-ceiling value falls back to the
 * default.
 */
export const ACCOUNT_IMPORT_PATHS = ['/api/account/import/preview', '/api/account/import/apply'];

export const DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

/** Hard ceiling for `ACCOUNT_IMPORT_BODY_LIMIT`. */
export const MAX_ACCOUNT_IMPORT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/** The import body limit in BYTES (a number, so the parser enforces exactly what was validated). */
export function resolveAccountImportBodyLimit(
    requested: string | undefined,
    warn: (message: string) => void = (message) => {
        // eslint-disable-next-line no-console
        console.warn(message);
    },
): number {
    if (!requested?.trim()) return DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES;
    const parsed = parseByteSize(requested);
    if (parsed === null || parsed <= 0 || parsed > MAX_ACCOUNT_IMPORT_BODY_LIMIT_BYTES) {
        warn(
            `[bootstrap] ACCOUNT_IMPORT_BODY_LIMIT="${requested}" is invalid or exceeds the ${MAX_ACCOUNT_IMPORT_BODY_LIMIT_BYTES}-byte cap; falling back to ${DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES} bytes.`,
        );
        return DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES;
    }
    return Math.floor(parsed);
}
