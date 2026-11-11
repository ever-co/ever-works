import type { IncomingMessage } from 'http';
import { json, type RequestHandler } from 'express';
import { parseByteSize } from '../email/inbound-email-body-limit';
import { toHeaders } from '../auth/providers/request-headers';

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
 * only, ahead of the global one ({@link mountAccountImportBodyParser}); every
 * other route keeps the tight limit. Body parsers run before the auth guard, so
 * the large parser is used only for a request whose credential VERIFIES (a
 * session, or a personal API key); any other request on these paths falls
 * through to the global 1 MB parser and is then refused by the guard — an
 * anonymous caller can never make the API buffer more than 1 MB here.
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

/** Does this request carry a credential that verifies? Resolved per request. */
export type AccountImportCallerCheck = (req: IncomingMessage) => Promise<boolean>;

/** `AuthSessionGuard`'s personal-key prefix (`ew_live_`); other machine keys never import. */
const PERSONAL_API_KEY_PREFIX = 'ew_live_';
const MACHINE_KEY_PREFIXES = ['ew_live_', 'ew_run_', 'ew_int_'];

function headerValue(req: IncomingMessage, name: string): string | null {
    const value = req.headers[name];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bearerOf(req: IncomingMessage): string | null {
    const header = headerValue(req, 'authorization');
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : null;
}

/**
 * The same two credentials `AuthSessionGuard` accepts on these routes, checked
 * the same way: a personal API key (`x-api-key` or `Authorization: Bearer
 * ew_live_…`) through `ApiKeyService.validateKey`, anything that is not a
 * machine key through the auth provider's session check. Integration keys are
 * refused on `/api/account` (`IntegrationForbiddenGuard`) and fleet-run tokens
 * never import, so both answer false. A lookup that throws answers false.
 */
export function accountImportCallerCheck(deps: {
    authenticateSession: () => ((headers: Headers) => Promise<unknown>) | undefined;
    validatePersonalKey: () => ((rawKey: string) => Promise<unknown>) | undefined;
}): AccountImportCallerCheck {
    return async (req) => {
        try {
            const headerKey = headerValue(req, 'x-api-key');
            const bearer = bearerOf(req);
            const machineKey = [headerKey, bearer].find(
                (value): value is string =>
                    !!value && MACHINE_KEY_PREFIXES.some((prefix) => value.startsWith(prefix)),
            );
            if (machineKey) {
                if (!machineKey.startsWith(PERSONAL_API_KEY_PREFIX)) return false;
                const validate = deps.validatePersonalKey();
                return validate ? Boolean(await validate(machineKey)) : false;
            }
            const authenticate = deps.authenticateSession();
            return authenticate ? Boolean(await authenticate(toHeaders(req.headers))) : false;
        } catch {
            return false;
        }
    };
}

/**
 * Mount the import routes' JSON parser on `app` (call it BEFORE the global
 * parsers). It parses with `limit` only when `isSignedIn` says the caller's
 * credential verifies; otherwise it does nothing and the global parser (1 MB)
 * reads the body. No raw copy of the body is kept (`verify` is not set): the
 * import handlers never read `req.rawBody`, and a 25 MB string per request
 * would double what the parser holds.
 */
export function mountAccountImportBodyParser(
    app: { use(path: string[], handler: RequestHandler): unknown },
    isSignedIn: AccountImportCallerCheck,
    limit: number = resolveAccountImportBodyLimit(process.env.ACCOUNT_IMPORT_BODY_LIMIT),
): void {
    const parse = json({ limit });
    app.use(ACCOUNT_IMPORT_PATHS, (req, res, next) => {
        if (req.method !== 'POST') {
            next();
            return;
        }
        isSignedIn(req).then(
            (signedIn) => (signedIn ? parse(req, res, next) : next()),
            () => next(),
        );
    });
}
