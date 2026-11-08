import 'server-only';
import type { EverInstallRequestView, EverInstallRequestsView } from '@ever-works/contracts';
import { ApiResponseError, serverFetch, serverMutation } from './server-api';

/**
 * Install requests from apps.ever.co — the web's client for
 * `/api/ever-connect/install-requests` (platform admins only).
 *
 * The API has these routes only with `EVER_CONNECT_ENABLED=true` (off by
 * default); otherwise every one answers 404, and a signed-in user who is not a
 * platform admin gets 403. Ids and package coordinates only travel; the
 * install id is the only value in a URL.
 */
const BASE = '/ever-connect/install-requests';

export const everConnectInstallsAPI = {
    list: () => serverFetch<EverInstallRequestsView>(BASE, { cache: 'no-store' }),
    /**
     * The requests when the caller may answer them; `null` when the API has no
     * such routes (404) or the caller is not a platform admin (403). Any other
     * failure is thrown, so the page can say the requests could not be read.
     */
    listIfAvailable: async (): Promise<EverInstallRequestsView | null> => {
        try {
            return await everConnectInstallsAPI.list();
        } catch (error) {
            if (
                error instanceof ApiResponseError &&
                (error.statusCode === 404 || error.statusCode === 403)
            ) {
                return null;
            }
            throw error;
        }
    },
    /** Whether the caller gets an Install requests section at all (see {@link listIfAvailable}). */
    isAvailable: async (): Promise<boolean> => {
        try {
            return (await everConnectInstallsAPI.listIfAvailable()) !== null;
        } catch {
            return false;
        }
    },
    approve: (installId: string, addToAllowlist: boolean) =>
        serverMutation<EverInstallRequestView>({
            endpoint: `${BASE}/${encodeURIComponent(installId)}/approve`,
            data: { addToAllowlist },
            method: 'POST',
            wrapInData: false,
        }),
    decline: (installId: string) =>
        serverMutation<EverInstallRequestView>({
            endpoint: `${BASE}/${encodeURIComponent(installId)}/decline`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
};
