'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { EverInstallRequestView, EverInstallRequestsView } from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { everConnectInstallsAPI } from '@/lib/api/ever-connect-installs';

/**
 * Install requests from apps.ever.co — Server Actions behind Settings → Ever
 * Platform. Each re-checks the session (the API's platform-admin guard and
 * its session-only guard are the real gates) and answers a result with a CODE
 * the panel translates, never an upstream message.
 */
const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/ever-platform';

const INSTALL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type InstallRequestActionCode =
    | 'package_not_allowlisted'
    | 'package_allowlist_disabled'
    | 'installer_disabled'
    | 'not_installable'
    | 'not_open'
    | 'integration_not_enabled'
    | 'forbidden'
    | 'rate_limited'
    | 'unavailable'
    | 'failed';

export type InstallRequestActionResult<T> =
    | { success: true; data: T }
    | { success: false; code: InstallRequestActionCode };

const KNOWN_CODES = new Set<InstallRequestActionCode>([
    'package_not_allowlisted',
    'package_allowlist_disabled',
    'installer_disabled',
    'not_installable',
    'not_open',
    'integration_not_enabled',
]);

async function ensureAuth(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);
}

function failure(error: unknown): { success: false; code: InstallRequestActionCode } {
    if (error instanceof ApiResponseError) {
        if (error.code && KNOWN_CODES.has(error.code as InstallRequestActionCode)) {
            return { success: false, code: error.code as InstallRequestActionCode };
        }
        if (error.statusCode === 403) return { success: false, code: 'forbidden' };
        if (error.statusCode === 404) return { success: false, code: 'unavailable' };
        if (error.statusCode === 429) return { success: false, code: 'rate_limited' };
    }
    return { success: false, code: 'failed' };
}

async function run<T>(
    fn: () => Promise<T>,
    revalidate = true,
): Promise<InstallRequestActionResult<T>> {
    await ensureAuth();
    try {
        const data = await fn();
        if (revalidate) revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data };
    } catch (error) {
        return failure(error);
    }
}

export async function listInstallRequestsAction(): Promise<
    InstallRequestActionResult<EverInstallRequestsView>
> {
    return run(() => everConnectInstallsAPI.list(), false);
}

export async function approveInstallRequestAction(
    installId: string,
    addToAllowlist: boolean,
): Promise<InstallRequestActionResult<EverInstallRequestView>> {
    if (!INSTALL_ID.test(installId)) return { success: false, code: 'unavailable' };
    return run(() => everConnectInstallsAPI.approve(installId, addToAllowlist === true));
}

export async function declineInstallRequestAction(
    installId: string,
): Promise<InstallRequestActionResult<EverInstallRequestView>> {
    if (!INSTALL_ID.test(installId)) return { success: false, code: 'unavailable' };
    return run(() => everConnectInstallsAPI.decline(installId));
}
