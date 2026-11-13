import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Server Actions behind Settings → Ever Platform (connection and
 * Organization link): a code is checked and normalised before any request, an
 * id that is not one never reaches a URL, and a failure comes back as a code
 * the page has words for, never as the API's own message.
 */
const status = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const link = vi.fn();
const unlink = vi.fn();
const getAuthFromCookie = vi.fn();
const revalidatePath = vi.fn();
const redirect = vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
});

// Defined before the mocks below are hoisted, which name it.
const { ApiResponseError } = vi.hoisted(() => {
    class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
        ) {
            super(message);
        }
    }
    return { ApiResponseError };
});

vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => redirect(path) }));
vi.mock('@/lib/constants', () => ({ ROUTES: { AUTH_LOGIN: '/login' } }));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: () => getAuthFromCookie() }));
vi.mock('@/lib/api/server-api', () => ({ ApiResponseError }));
vi.mock('@/lib/api/ever-connect', () => ({
    everConnectAPI: {
        status: (...args: unknown[]) => status(...args),
        connect: (...args: unknown[]) => connect(...args),
        disconnect: (...args: unknown[]) => disconnect(...args),
        link: (...args: unknown[]) => link(...args),
        unlink: (...args: unknown[]) => unlink(...args),
    },
}));

import {
    connectEverPlatformAction,
    disconnectEverPlatformAction,
    linkOrganizationAction,
    unlinkOrganizationAction,
} from './ever-platform-connection';

const ORG = '11111111-1111-4111-8111-111111111111';
const STATUS = { connection: { status: 'active' } };

beforeEach(() => {
    for (const mock of [status, connect, disconnect, link, unlink, revalidatePath])
        mock.mockReset();
    redirect.mockClear();
    getAuthFromCookie.mockReset().mockResolvedValue({ sub: 'user-1' });
    status.mockResolvedValue(STATUS);
});

describe('connectEverPlatformAction', () => {
    it('sends the canonical code and answers the new status', async () => {
        connect.mockResolvedValue({ status: 'active' });
        expect(await connectEverPlatformAction('  evc 7k2m 9qxr 4htb ')).toEqual({
            success: true,
            data: STATUS,
        });
        expect(connect).toHaveBeenCalledWith('EVC-7K2M-9QXR-4HTB');
        expect(revalidatePath).toHaveBeenCalled();
    });

    it('a code that is not a connect code makes no request', async () => {
        for (const code of [
            '',
            'EVL-7K2M-9QXR-4HTB',
            'EVC-7K2M',
            'https://example.test/?code=EVC',
        ]) {
            expect(await connectEverPlatformAction(code)).toEqual({
                success: false,
                code: 'code_invalid',
            });
        }
        expect(connect).not.toHaveBeenCalled();
    });

    it.each([
        [
            new ApiResponseError('Ever Platform refused the connect code.', 422, 'code_expired'),
            'code_expired',
        ],
        [new ApiResponseError('x', 409, 'already_connected'), 'already_connected'],
        [new ApiResponseError('x', 422, 'something_new'), 'code_invalid'],
        [new ApiResponseError('x', 403, 'session_required'), 'session_required'],
        [new ApiResponseError('x', 403), 'forbidden'],
        [new ApiResponseError('x', 404), 'unavailable'],
        [new ApiResponseError('x', 429), 'rate_limited'],
        [new ApiResponseError('x', 502), 'platform_unreachable'],
        [new ApiResponseError('secret upstream text', 500), 'failed'],
        [new Error('socket hang up'), 'failed'],
    ])('answers a code for %s', async (error, code) => {
        connect.mockRejectedValue(error);
        const result = await connectEverPlatformAction('EVC-7K2M-9QXR-4HTB');
        expect(result).toEqual({ success: false, code });
        expect(JSON.stringify(result)).not.toMatch(/secret|refused|hang/);
    });

    it('needs a signed-in person', async () => {
        getAuthFromCookie.mockResolvedValue(null);
        await expect(connectEverPlatformAction('EVC-7K2M-9QXR-4HTB')).rejects.toThrow(
            'redirect:/login',
        );
        expect(connect).not.toHaveBeenCalled();
    });
});

describe('disconnectEverPlatformAction', () => {
    it('disconnects and answers the new status', async () => {
        disconnect.mockResolvedValue({ status: 'disconnected' });
        expect(await disconnectEverPlatformAction()).toEqual({ success: true, data: STATUS });
        expect(disconnect).toHaveBeenCalledTimes(1);
    });
});

describe('linkOrganizationAction / unlinkOrganizationAction', () => {
    it('links with the canonical code', async () => {
        const view = {
            connected: true,
            link: { everOrgId: 'x' },
            entitlement: null,
            appSync: false,
        };
        link.mockResolvedValue(view);
        expect(await linkOrganizationAction(ORG, 'evl-7k2m-9qxr-4htb')).toEqual({
            success: true,
            data: view,
        });
        expect(link).toHaveBeenCalledWith(ORG, 'EVL-7K2M-9QXR-4HTB');
    });

    it('a connect code, or an id that is not one, makes no request', async () => {
        expect(await linkOrganizationAction(ORG, 'EVC-7K2M-9QXR-4HTB')).toEqual({
            success: false,
            code: 'code_invalid',
        });
        expect(await linkOrganizationAction('../status', 'EVL-7K2M-9QXR-4HTB')).toEqual({
            success: false,
            code: 'unavailable',
        });
        expect(await unlinkOrganizationAction('not-an-id')).toEqual({
            success: false,
            code: 'unavailable',
        });
        expect(link).not.toHaveBeenCalled();
        expect(unlink).not.toHaveBeenCalled();
    });

    it.each([
        [new ApiResponseError('x', 409, 'tenant_already_linked'), 'tenant_already_linked'],
        [new ApiResponseError('x', 409, 'not_connected'), 'not_connected'],
        [new ApiResponseError('x', 422, 'product_mismatch'), 'product_mismatch'],
        [new ApiResponseError('x', 502, 'platform_unreachable'), 'platform_unreachable'],
    ])('answers a code for a refused link (%s)', async (error, code) => {
        link.mockRejectedValue(error);
        expect(await linkOrganizationAction(ORG, 'EVL-7K2M-9QXR-4HTB')).toEqual({
            success: false,
            code,
        });
    });

    it('removes a link, and says when it is not linked', async () => {
        const view = {
            connected: true,
            link: null,
            entitlement: null,
            appSync: false,
            canManage: true,
        };
        unlink.mockResolvedValue(view);
        expect(await unlinkOrganizationAction(ORG)).toEqual({ success: true, data: view });
        unlink.mockRejectedValue(new ApiResponseError('x', 404, 'not_linked'));
        expect(await unlinkOrganizationAction(ORG)).toEqual({ success: false, code: 'not_linked' });
    });
});
