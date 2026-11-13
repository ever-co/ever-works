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
 * - An Organization's link (`organizationLink`, `link`, `unlink`): its members
 *   read it, its admins change it. These routes exist only with
 *   `EVER_CONNECT_LINK_CODES_ENABLED=true` as well.
 *
 * A connect code or a link code travels in a request body only, never in a URL,
 * and no answer carries one.
 */
const BASE = '/ever-connect';

function unavailable(error: unknown): boolean {
    return (
        error instanceof ApiResponseError && (error.statusCode === 404 || error.statusCode === 403)
    );
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
     * Whether the caller gets an Organization link section at all: linking is
     * switched on in the API and the caller has an Organization. Never throws.
     */
    linksAvailable: async (): Promise<boolean> => {
        try {
            const [first] = await teamsAPI.listOrganizations();
            if (!first) return false;
            return (await everConnectAPI.organizationLinkIfAvailable(first.id)) !== null;
        } catch {
            return false;
        }
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
