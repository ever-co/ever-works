import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `Ever-Link-Id` for the install status report.
 *
 * Ever Platform runs `POST /v1/installs/{install}/status` behind the
 * `marketplace_installs` integration, which is consented per tenant link, so
 * the report must name the link it acts for in `Ever-Link-Id` (without it the
 * platform answers `422` at `#Ever-Link-Id`). The pinned Ever Platform SDK
 * declares no link header for that operation and so never sends one. Until it
 * does, the report runs inside {@link withInstallReportLink}, and the client's
 * transport ({@link installReportLinkFetch}) adds the header to that one
 * request — a `POST` to an install's status, nothing else. The link id is
 * Ever Platform's own id of the tenant link (a ULID), never a secret.
 */
const LINK = new AsyncLocalStorage<string>();

const LINK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INSTALL_STATUS_PATH = /\/v1\/installs\/[0-9A-HJKMNP-TV-Z]{26}\/status$/;

/** Run `fn` (one install status report) for the tenant link `linkId`. */
export function withInstallReportLink<T>(linkId: string, fn: () => Promise<T>): Promise<T> {
    if (!LINK_ID.test(linkId)) throw new TypeError('Not a tenant link id');
    return LINK.run(linkId, fn);
}

type FetchInit = { method?: string; headers?: unknown } & Record<string, unknown>;

/**
 * The transport of the Ever Connect client: `globalThis.fetch`, with
 * `Ever-Link-Id` added to an install status report made inside
 * {@link withInstallReportLink}. Every other request goes out unchanged.
 */
export function installReportLinkFetch(
    base: () => typeof globalThis.fetch = () => globalThis.fetch,
): typeof globalThis.fetch {
    return ((input: unknown, init?: FetchInit) => {
        const linkId = LINK.getStore();
        const fetch = base();
        if (!linkId || !init || init.method !== 'POST' || typeof input !== 'string') {
            return fetch(input as string, init as RequestInit);
        }
        let path: string;
        try {
            path = new URL(input).pathname;
        } catch {
            return fetch(input, init as RequestInit);
        }
        if (!INSTALL_STATUS_PATH.test(path)) return fetch(input, init as RequestInit);
        const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
        headers['ever-link-id'] = linkId;
        return fetch(input, { ...init, headers } as RequestInit);
    }) as typeof globalThis.fetch;
}
