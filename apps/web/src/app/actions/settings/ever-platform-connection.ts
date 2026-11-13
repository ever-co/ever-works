'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    normalizeEverPlatformCode,
    type EverPlatformConnectionStatusView,
    type EverPlatformOrganizationLinkView,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { everConnectAPI } from '@/lib/api/ever-connect';

/**
 * The connection to Ever Platform — Server Actions behind Settings → Ever
 * Platform. Each re-checks the session (the API's guards are the real gates:
 * platform admin for the connection, the Organization's admin for its link,
 * and an interactive session for every change) and answers a result with a
 * CODE the panels translate, never an upstream message. A code typed by the
 * person is checked for its shape before any request and is never echoed back.
 */
const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/ever-platform';

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EverPlatformActionCode =
    | 'code_invalid'
    | 'code_expired'
    | 'already_connected'
    | 'not_connected'
    | 'already_linked'
    | 'tenant_already_linked'
    | 'not_linked'
    | 'product_mismatch'
    | 'platform_unreachable'
    | 'session_required'
    | 'forbidden'
    | 'rate_limited'
    | 'unavailable'
    | 'failed';

export type EverPlatformActionResult<T> =
    | { success: true; data: T }
    | { success: false; code: EverPlatformActionCode };

const KNOWN_CODES = new Set<EverPlatformActionCode>([
    'code_invalid',
    'code_expired',
    'already_connected',
    'not_connected',
    'already_linked',
    'tenant_already_linked',
    'not_linked',
    'product_mismatch',
    'platform_unreachable',
]);

async function ensureAuth(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);
}

function failure(error: unknown): { success: false; code: EverPlatformActionCode } {
    if (error instanceof ApiResponseError) {
        if (error.code && KNOWN_CODES.has(error.code as EverPlatformActionCode)) {
            return { success: false, code: error.code as EverPlatformActionCode };
        }
        if (error.code === 'session_required') return { success: false, code: 'session_required' };
        if (error.statusCode === 403) return { success: false, code: 'forbidden' };
        if (error.statusCode === 404) return { success: false, code: 'unavailable' };
        if (error.statusCode === 429) return { success: false, code: 'rate_limited' };
        if (error.statusCode === 502) return { success: false, code: 'platform_unreachable' };
        // Ever Platform refused the code with a reason this page has no words for.
        if (error.statusCode === 422) return { success: false, code: 'code_invalid' };
    }
    return { success: false, code: 'failed' };
}

async function run<T>(fn: () => Promise<T>): Promise<EverPlatformActionResult<T>> {
    await ensureAuth();
    try {
        const data = await fn();
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data };
    } catch (error) {
        return failure(error);
    }
}

/** Connect this installation with a connect code (`EVC-…`). Platform admins only. */
export async function connectEverPlatformAction(
    code: string,
): Promise<EverPlatformActionResult<EverPlatformConnectionStatusView>> {
    const typed = normalizeEverPlatformCode(code, 'connect');
    if (!typed) return { success: false, code: 'code_invalid' };
    return run(async () => {
        await everConnectAPI.connect(typed);
        return everConnectAPI.status();
    });
}

/** Disconnect this installation. Platform admins only. */
export async function disconnectEverPlatformAction(): Promise<
    EverPlatformActionResult<EverPlatformConnectionStatusView>
> {
    return run(async () => {
        await everConnectAPI.disconnect();
        return everConnectAPI.status();
    });
}

/** Link an Organization with a link code (`EVL-…`). Its admins only. */
export async function linkOrganizationAction(
    organizationId: string,
    code: string,
): Promise<EverPlatformActionResult<EverPlatformOrganizationLinkView>> {
    if (!ORGANIZATION_ID.test(organizationId)) return { success: false, code: 'unavailable' };
    const typed = normalizeEverPlatformCode(code, 'link');
    if (!typed) return { success: false, code: 'code_invalid' };
    return run(() => everConnectAPI.link(organizationId, typed));
}

/** Remove an Organization's link. Its admins only. */
export async function unlinkOrganizationAction(
    organizationId: string,
): Promise<EverPlatformActionResult<EverPlatformOrganizationLinkView>> {
    if (!ORGANIZATION_ID.test(organizationId)) return { success: false, code: 'unavailable' };
    return run(() => everConnectAPI.unlink(organizationId));
}
