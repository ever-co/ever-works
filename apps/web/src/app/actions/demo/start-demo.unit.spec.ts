import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    startDemo: vi.fn(),
    setAuthAccessCookie: vi.fn(),
    getLoginDefaultWorkspaceHref: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ authAPI: { startDemo: mocks.startDemo } }));
vi.mock('@/lib/auth/cookies', () => ({ setAuthAccessCookie: mocks.setAuthAccessCookie }));
vi.mock('@/lib/api/server-api', () => ({
    getLoginDefaultWorkspaceHref: mocks.getLoginDefaultWorkspaceHref,
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
        ) {
            super(message);
        }
    },
}));

import { startDemo } from './start-demo';
import { ApiResponseError } from '@/lib/api/server-api';

describe('startDemo', () => {
    beforeEach(() => {
        mocks.startDemo.mockReset();
        mocks.setAuthAccessCookie.mockReset();
        mocks.getLoginDefaultWorkspaceHref.mockReset().mockResolvedValue('/');
    });

    it('sets the auth cookie and succeeds on 201', async () => {
        mocks.startDemo.mockResolvedValue({
            access_token: 'tok',
            user: { id: 'u1' },
            expiresAt: 'x',
        });
        await expect(startDemo({ captchaToken: 'cap' })).resolves.toEqual({
            success: true,
            href: '/',
        });
        expect(mocks.startDemo).toHaveBeenCalledWith({ captchaToken: 'cap' });
        expect(mocks.setAuthAccessCookie).toHaveBeenCalledWith('tok');
    });

    it("lands in the sandbox's Organization, resolved after the cookie is set, as a login does", async () => {
        mocks.startDemo.mockResolvedValue({
            access_token: 'tok',
            user: { id: 'u1' },
            expiresAt: 'x',
        });
        mocks.getLoginDefaultWorkspaceHref.mockResolvedValue(
            '/org/acme-labs-demo-0a1b2c3d/dashboard',
        );

        await expect(startDemo({})).resolves.toEqual({
            success: true,
            href: '/org/acme-labs-demo-0a1b2c3d/dashboard',
        });
        expect(mocks.setAuthAccessCookie.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.getLoginDefaultWorkspaceHref.mock.invocationCallOrder[0],
        );
    });

    it('lands on the dashboard when the landing scope cannot be read, and logs why', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.startDemo.mockResolvedValue({
            access_token: 'tok',
            user: { id: 'u1' },
            expiresAt: 'x',
        });
        const lookupError = new Error('scope lookup failed');
        mocks.getLoginDefaultWorkspaceHref.mockRejectedValue(lookupError);

        try {
            await expect(startDemo({})).resolves.toEqual({ success: true, href: '/' });
            expect(mocks.setAuthAccessCookie).toHaveBeenCalledWith('tok');
            // Not swallowed: logged the way the login twin (`resolveLoginDefaultWorkspaceHref`) does.
            expect(consoleError).toHaveBeenCalledWith(
                'Unable to resolve the demo landing workspace',
                lookupError,
            );
        } finally {
            consoleError.mockRestore();
        }
    });

    it('logs nothing when the landing scope resolves', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.startDemo.mockResolvedValue({
            access_token: 'tok',
            user: { id: 'u1' },
            expiresAt: 'x',
        });

        try {
            await startDemo({});
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('sends no token when the captcha token is empty', async () => {
        mocks.startDemo.mockResolvedValue({
            access_token: 'tok',
            user: { id: 'u1' },
            expiresAt: 'x',
        });
        await startDemo({ captchaToken: '' });
        expect(mocks.startDemo).toHaveBeenCalledWith({ captchaToken: undefined });
    });

    it.each([
        [429, undefined, 'throttled'],
        [503, 'DEMO_FULL', 'full'],
        [400, undefined, 'captcha'],
        [503, 'DEMO_AI_BUSY', 'error'],
        [500, undefined, 'error'],
    ])('maps %s %s to %s and sets no cookie', async (status, code, reason) => {
        mocks.startDemo.mockRejectedValue(new ApiResponseError('nope', status, code));
        const result = await startDemo({});
        expect(result).toMatchObject({ success: false, reason });
        expect(typeof (result as { error: string }).error).toBe('string');
        expect(mocks.setAuthAccessCookie).not.toHaveBeenCalled();
    });

    it('maps a thrown non-API error to error', async () => {
        mocks.startDemo.mockRejectedValue(new TypeError('fetch failed'));
        await expect(startDemo({})).resolves.toMatchObject({ success: false, reason: 'error' });
    });
});
