/**
 * The switches of what runs over the connection beyond the connection itself.
 * Each defaults off; only the exact value `true` (any case) turns one on, and
 * none does anything without `EVER_CONNECT_ENABLED=true`.
 *
 * - `EVER_CONNECT_LINK_CODES_ENABLED`: an Organization's admin can link it to
 *   an Ever organization with a link code (`EVL-…`) and remove the link. Off,
 *   every `/api/ever-connect/organizations/*` route answers 404 like any
 *   unknown address.
 * - `EVER_CONNECT_HEARTBEAT_ENABLED`: the installation tells Ever Platform that
 *   it is alive, with its version, shortly after it starts and then once a day.
 * - `EVER_CONNECT_ENTITLEMENTS_ENABLED`: the installation reads the signed
 *   entitlement documents (its own and each linked Organization's), verifies
 *   and keeps them, and shows what they say. Nothing in Ever Works depends on
 *   them.
 * - `EVER_CONNECT_APP_SYNC_ENABLED`: the apps mirror. For an Organization whose
 *   link has the `app_sync` integration enabled in app.ever.co, the
 *   identifiers and status of its Works and their deployments are sent to Ever
 *   Platform. Off, nothing is queued and nothing is sent, whatever was
 *   consented.
 */
type Env = Readonly<Record<string, string | undefined>>;

function isOn(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === 'true';
}

function withConnect(env: Env, name: string): boolean {
    return isOn(env.EVER_CONNECT_ENABLED) && isOn(env[name]);
}

export function isLinkCodesEnabled(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_LINK_CODES_ENABLED');
}

export function isHeartbeatEnabled(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_HEARTBEAT_ENABLED');
}

export function isEntitlementsEnabled(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_ENTITLEMENTS_ENABLED');
}

export function isAppSyncEnabled(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_APP_SYNC_ENABLED');
}

/** Which of the switched parts this installation runs (shown to the operator). */
export interface EverConnectFeatures {
    readonly linkCodes: boolean;
    readonly heartbeat: boolean;
    readonly entitlements: boolean;
    readonly appSync: boolean;
}

export function everConnectFeatures(env: Env = process.env): EverConnectFeatures {
    return {
        linkCodes: isLinkCodesEnabled(env),
        heartbeat: isHeartbeatEnabled(env),
        entitlements: isEntitlementsEnabled(env),
        appSync: isAppSyncEnabled(env),
    };
}
