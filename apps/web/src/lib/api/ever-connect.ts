import 'server-only';
import type {
    EverPlatformConnectionStatusView,
    EverPlatformOrganizationLinkView,
} from '@ever-works/contracts';
import { ApiResponseError, serverFetch, serverMutation } from './server-api';
import { teamsAPI } from './teams';

/**
 * The connection to Ever Platform — the web's client for `/api/ever-connect/*`.
 *
 * - The connection itself (`status`, `connect`, `disconnect`): platform admins
 *   only. The API has these routes only with `EVER_CONNECT_ENABLED=true`;
 *   otherwise each answers 404, and a signed-in user who is not a platform
 *   admin gets 403.
 * - An Organization's link (`organizationLink`, `link`, `unlink`): the members
 *   of its account read it; only its administrators change it (the account's
 *   owner, or a member whose role in the Organization is `admin` or `owner`).
 *   These routes exist only with `EVER_CONNECT_LINK_CODES_ENABLED=true` as
 *   well.
 *
 * A connect code or a link code travels in a request body only, never in a URL,
 * and no answer carries one.
 */
const BASE = '/ever-connect';

/**
 * How the Ever Connect module answers the person asking, read from its status
 * route alone (one request):
 *
 * - `absent`: the API has no such route (404), so `EVER_CONNECT_ENABLED` is
 *   off. Nothing of the connection exists here and nothing else is asked.
 * - `admin`: a platform admin (200). The status says which parts are switched
 *   on, link codes included.
 * - `member`: the module is loaded and the person is not a platform admin
 *   (403). Only the link route itself can tell them whether link codes are
 *   switched on.
 * - `unknown`: the status could not be read.
 */
export type EverConnectAccess =
    | { readonly kind: 'absent' }
    | { readonly kind: 'admin'; readonly status: EverPlatformConnectionStatusView }
    | { readonly kind: 'member' }
    | { readonly kind: 'unknown' };

/** One of the person's Organizations, with its link as the API answered it. */
export interface EverPlatformOrganizationLinkItem {
    readonly organizationId: string;
    readonly displayName: string;
    readonly slug: string;
    /** `null`: the link could not be read. */
    readonly view: EverPlatformOrganizationLinkView | null;
}

function statusOf(error: unknown): number | null {
    return error instanceof ApiResponseError ? error.statusCode : null;
}

function unavailable(error: unknown): boolean {
    const status = statusOf(error);
    return status === 404 || status === 403;
}

/**
 * Whether asking for an Organization's link can have an answer at all. `false`
 * without a request when the module is absent, or when the status a platform
 * admin reads says link codes are switched off.
 */
function linkCodesPossible(access: EverConnectAccess): boolean {
    if (access.kind === 'absent') return false;
    if (access.kind === 'admin') return access.status.features.linkCodes;
    return true;
}

const linkPath = (organizationId: string) =>
    `${BASE}/organizations/${encodeURIComponent(organizationId)}/link`;

export const everConnectAPI = {
    status: () =>
        serverFetch<EverPlatformConnectionStatusView>(`${BASE}/status`, { cache: 'no-store' }),
    /**
     * The connection when the caller may manage it; `null` when the API has no
     * such route (404) or the caller is not a platform admin (403). Any other
     * failure is thrown, so the page can say the connection could not be read.
     */
    statusIfAvailable: async (): Promise<EverPlatformConnectionStatusView | null> => {
        try {
            return await everConnectAPI.status();
        } catch (error) {
            if (unavailable(error)) return null;
            throw error;
        }
    },
    /** How the module answers the person asking (see {@link EverConnectAccess}). Never throws. */
    access: async (): Promise<EverConnectAccess> => {
        try {
            return { kind: 'admin', status: await everConnectAPI.status() };
        } catch (error) {
            const status = statusOf(error);
            if (status === 404) return { kind: 'absent' };
            if (status === 403) return { kind: 'member' };
            return { kind: 'unknown' };
        }
    },
    connect: (code: string) =>
        serverMutation<EverPlatformConnectionStatusView['connection']>({
            endpoint: `${BASE}/connect`,
            data: { code },
            method: 'POST',
            wrapInData: false,
        }),
    disconnect: () =>
        serverMutation<EverPlatformConnectionStatusView['connection']>({
            endpoint: `${BASE}/disconnect`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
    organizationLink: (organizationId: string) =>
        serverFetch<EverPlatformOrganizationLinkView>(linkPath(organizationId), {
            cache: 'no-store',
        }),
    /**
     * The Organization's link; `null` when linking is not switched on here (404)
     * or the caller may not read it (403). Any other failure is thrown.
     */
    organizationLinkIfAvailable: async (
        organizationId: string,
    ): Promise<EverPlatformOrganizationLinkView | null> => {
        try {
            return await everConnectAPI.organizationLink(organizationId);
        } catch (error) {
            if (unavailable(error)) return null;
            throw error;
        }
    },
    /**
     * The person's Organizations with their links, for the Organization link
     * section of the settings page; `null` when there is no section to show.
     *
     * Asks nothing when {@link EverConnectAccess} already says linking is off
     * here (the module is absent, or a platform admin's status has the switch
     * off). Otherwise the first Organization's answer tells whether linking is
     * switched on (404: no section). **Never throws**: a failure to read the
     * Organizations hides this section and nothing else of the page; a failure
     * to read one Organization's link leaves its row, which says so.
     */
    organizationLinks: async (
        access: EverConnectAccess,
    ): Promise<EverPlatformOrganizationLinkItem[] | null> => {
        if (!linkCodesPossible(access)) return null;
        try {
            const items: EverPlatformOrganizationLinkItem[] = [];
            for (const organization of await teamsAPI.listOrganizations()) {
                let view: EverPlatformOrganizationLinkView | null = null;
                try {
                    view = await everConnectAPI.organizationLinkIfAvailable(organization.id);
                    if (!view) return null;
                } catch {
                    // Read failed for this Organization: its row says so.
                }
                items.push({
                    organizationId: organization.id,
                    displayName: organization.displayName,
                    slug: organization.slug,
                    view,
                });
            }
            return items.length > 0 ? items : null;
        } catch {
            return null;
        }
    },
    /**
     * Whether the caller gets an Organization link section at all: linking is
     * switched on in the API and the caller has an Organization. Asks nothing
     * when `access` already says no (see {@link organizationLinks}); otherwise
     * two requests at most. Never throws.
     */
    linksAvailable: async (access?: EverConnectAccess): Promise<boolean> => {
        try {
            if (!linkCodesPossible(access ?? (await everConnectAPI.access()))) return false;
            const [first] = await teamsAPI.listOrganizations();
            if (!first) return false;
            return (await everConnectAPI.organizationLinkIfAvailable(first.id)) !== null;
        } catch {
            return false;
        }
    },
    /**
     * Whether the settings navigation shows the Ever Platform tab because of
     * this module: a platform admin where the module is loaded (the connection
     * and the install requests), or a member of an Organization where linking
     * is switched on.
     *
     * One request (the status) where the module is switched off, which is every
     * deployment by default, and one for a platform admin; the two requests of
     * {@link linksAvailable} are made only for a person who is not a platform
     * admin on a deployment that has the module loaded. Never throws.
     */
    settingsTabAvailable: async (): Promise<boolean> => {
        const access = await everConnectAPI.access();
        if (access.kind === 'absent') return false;
        if (access.kind === 'admin') return true;
        return everConnectAPI.linksAvailable(access);
    },
    link: (organizationId: string, code: string) =>
        serverMutation<EverPlatformOrganizationLinkView>({
            endpoint: linkPath(organizationId),
            data: { code },
            method: 'POST',
            wrapInData: false,
        }),
    unlink: (organizationId: string) =>
        serverMutation<EverPlatformOrganizationLinkView>({
            endpoint: linkPath(organizationId),
            data: {},
            method: 'DELETE',
            wrapInData: false,
        }),
};
