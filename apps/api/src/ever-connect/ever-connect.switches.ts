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
 * - `EVER_CONNECT_APPS_WRITE_ENABLED`: another Ever app may, for a person who
 *   allowed it there (an Ever ID access token carrying `apps:write`), create an
 *   App in an Organization linked to an Ever organization and start a
 *   deployment of one. The person must be a member of that Organization, and
 *   everything a signed-in person's own request is checked against applies. Off,
 *   every `/api/ever-connect/apps*` route answers 404 like any unknown address.
 *   **It needs a list of the apps that may write** (`EVER_ID_TRUSTED_CLIENT_IDS`,
 *   at least one client id): with the switch on and no such list the routes
 *   stay off, and the start says so ({@link isAppsWriteEnabled}).
 * - `EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED`: a person sent here from Ever
 *   Platform's marketplace to create an App from a Blueprint may bring the id
 *   of the install it is for, and it is kept on that App. Off, an install id
 *   in a create request is ignored and nothing is stored. (The web app has a
 *   switch of the same name for reading the address that carries it.)
 * - `EVER_CONNECT_PERSON_EXPORT_ENABLED`: Ever Platform's export request for a
 *   person is answered `exported` with an address where the person, signed in
 *   here, downloads what Ever Works holds about their own account. Off, the
 *   answer stays `failed` with `export_not_available` and the download route
 *   answers 404.
 * - `EVER_CONNECT_PERSON_DELETION_ENABLED`: Ever Platform's deletion request for
 *   a person deletes the matching accounts through the account deletion of
 *   Settings → Danger Zone, when that is safe for everyone else. Off, nothing is
 *   deleted beyond the connected identities, and the answer stays `failed` with
 *   `account_deletion_pending`.
 */
import { parseTrustedClientIds } from '../auth/ever-id-trusted-clients';

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

/** The switch itself: `EVER_CONNECT_APPS_WRITE_ENABLED=true` on an installation with Ever Connect on. */
export function isAppsWriteSwitchedOn(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_APPS_WRITE_ENABLED');
}

/** Whether `EVER_ID_TRUSTED_CLIENT_IDS` names at least one app (a client id spelled like one). */
export function hasTrustedWriteClients(env: Env = process.env): boolean {
    return parseTrustedClientIds(env.EVER_ID_TRUSTED_CLIENT_IDS).clientIds.length > 0;
}

/**
 * Whether another Ever app may write for a person here: the switch, **and** a
 * list of the apps that may. A write changes things in a person's name (a
 * repository in their Git account, a deployment), so it is never open to every
 * client of the identity provider: without a list the part stays off, whatever
 * the switch says. Reading for a person keeps its own, older rule.
 */
export function isAppsWriteEnabled(env: Env = process.env): boolean {
    return isAppsWriteSwitchedOn(env) && hasTrustedWriteClients(env);
}

export function isBlueprintHandoffEnabled(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED');
}

export function isPersonExportEnabled(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_PERSON_EXPORT_ENABLED');
}

export function isPersonDeletionEnabled(env: Env = process.env): boolean {
    return withConnect(env, 'EVER_CONNECT_PERSON_DELETION_ENABLED');
}

/** Which of the switched parts this installation runs (shown to the operator). */
export interface EverConnectFeatures {
    readonly linkCodes: boolean;
    readonly heartbeat: boolean;
    readonly entitlements: boolean;
    readonly appSync: boolean;
    /** The routes exist: the switch is on and the list of trusted apps is not empty. */
    readonly appsWrite: boolean;
    readonly blueprintHandoff: boolean;
}

export function everConnectFeatures(env: Env = process.env): EverConnectFeatures {
    return {
        linkCodes: isLinkCodesEnabled(env),
        heartbeat: isHeartbeatEnabled(env),
        entitlements: isEntitlementsEnabled(env),
        appSync: isAppSyncEnabled(env),
        appsWrite: isAppsWriteEnabled(env),
        blueprintHandoff: isBlueprintHandoffEnabled(env),
    };
}
