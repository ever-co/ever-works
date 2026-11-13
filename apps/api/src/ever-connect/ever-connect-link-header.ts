import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `Ever-Link-Id` for the calls that act for one tenant link but for which the
 * pinned Ever Platform SDK declares no link header, and so never sends one:
 *
 * - **The install status report** (`POST /v1/installs/{install}/status`). Ever
 *   Platform runs it behind the `marketplace_installs` integration, which is
 *   consented per tenant link, so the report must name the link it acts for
 *   (without it the platform answers `422` at `#Ever-Link-Id`). The report runs
 *   inside {@link withInstallReportLink}.
 * - **The apps mirror** (`POST` and `GET /v1/instances/me/mirror/apps`), behind
 *   the per-link `app_sync` integration. A batch is sent for one link at a
 *   time and names it, inside {@link withAppSyncLink}.
 *
 * Until the SDK sends the header itself, the client's transport
 * ({@link installReportLinkFetch}) adds it to exactly those requests, each only
 * inside its own scope: nothing else ever carries it. The link id is Ever
 * Platform's own id of the tenant link (a ULID), never a secret.
 */
interface LinkScope {
    readonly linkId: string;
    readonly call: 'install_status' | 'app_sync';
}

const LINK = new AsyncLocalStorage<LinkScope>();

const LINK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INSTALL_STATUS_PATH = /\/v1\/installs\/[0-9A-HJKMNP-TV-Z]{26}\/status$/;
const APP_SYNC_PATH = /\/v1\/instances\/me\/mirror\/apps$/;

/** Run `fn` (one install status report) for the tenant link `linkId`. */
export function withInstallReportLink<T>(linkId: string, fn: () => Promise<T>): Promise<T> {
    if (!LINK_ID.test(linkId)) throw new TypeError('Not a tenant link id');
    return LINK.run({ linkId, call: 'install_status' }, fn);
}

/** Run `fn` (one call of the apps mirror) for the tenant link `linkId`. */
export function withAppSyncLink<T>(linkId: string, fn: () => Promise<T>): Promise<T> {
    if (!LINK_ID.test(linkId)) throw new TypeError('Not a tenant link id');
    return LINK.run({ linkId, call: 'app_sync' }, fn);
}

type FetchInit = { method?: string; headers?: unknown } & Record<string, unknown>;

/** Whether the request is the one call the scope was opened for. */
function matches(scope: LinkScope, method: string | undefined, path: string): boolean {
    if (scope.call === 'install_status') {
        return method === 'POST' && INSTALL_STATUS_PATH.test(path);
    }
    return (method === 'POST' || method === 'GET') && APP_SYNC_PATH.test(path);
}

/**
 * The transport of the Ever Connect client: `globalThis.fetch`, with
 * `Ever-Link-Id` added to an install status report made inside
 * {@link withInstallReportLink} and to a call of the apps mirror made inside
 * {@link withAppSyncLink}. Every other request goes out unchanged.
 */
export function installReportLinkFetch(
    base: () => typeof globalThis.fetch = () => globalThis.fetch,
): typeof globalThis.fetch {
    return ((input: unknown, init?: FetchInit) => {
        const scope = LINK.getStore();
        const fetch = base();
        if (!scope || !init || typeof input !== 'string') {
            return fetch(input as string, init as RequestInit);
        }
        let path: string;
        try {
            path = new URL(input).pathname;
        } catch {
            return fetch(input, init as RequestInit);
        }
        if (!matches(scope, init.method, path)) return fetch(input, init as RequestInit);
        const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
        headers['ever-link-id'] = scope.linkId;
        return fetch(input, { ...init, headers } as RequestInit);
    }) as typeof globalThis.fetch;
}
