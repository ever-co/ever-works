import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const getAuthFromCookie = vi.fn();
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: () => getAuthFromCookie() }));
const previewImport = vi.fn();
const applyImport = vi.fn();
vi.mock('@/lib/api/account-transfer', () => ({
    accountTransferAPI: {
        previewImport: (...args: unknown[]) => previewImport(...args),
        applyImport: (...args: unknown[]) => applyImport(...args),
    },
}));

import { handleAccountImport } from './account-import-route';
import { ACCOUNT_IMPORT_MAX_BYTES } from './account-import.shared';

/** A valid-shaped export of roughly `mb` megabytes (one Work with a long description). */
function exportOf(mb = 0) {
    return {
        version: 1,
        exportedAt: '2026-11-11T00:00:00.000Z',
        data: {
            works: [
                {
                    slug: 'big-work',
                    name: 'Big Work',
                    description: 'x'.repeat(Math.max(1, Math.floor(mb * 1024 * 1024))),
                },
            ],
        },
    };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/account/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });

describe('account import route handlers (large exports, not a server action)', () => {
    beforeEach(() => {
        getAuthFromCookie.mockReset().mockResolvedValue({ id: 'u-1' });
        previewImport.mockReset().mockResolvedValue({ conflicts: [], works: 1 });
        applyImport.mockReset().mockResolvedValue({ imported: 1 });
    });

    it('previews an export over 1 MB — a server action refused anything over 1 MB', async () => {
        const res = await handleAccountImport(post({ payload: exportOf(3) }), 'preview');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            success: true,
            data: { conflicts: [], works: 1 },
            error: null,
        });
        expect(previewImport).toHaveBeenCalledTimes(1);
    });

    it('applies with the resolutions', async () => {
        const resolutions = [{ slug: 'big-work', strategy: 'skip' }];
        const res = await handleAccountImport(post({ payload: exportOf(), resolutions }), 'apply');
        expect(res.status).toBe(200);
        expect(applyImport).toHaveBeenCalledWith(expect.anything(), resolutions);
    });

    it('refuses a caller who is not signed in', async () => {
        getAuthFromCookie.mockResolvedValue(null);
        const res = await handleAccountImport(post({ payload: exportOf() }), 'preview');
        expect(res.status).toBe(401);
        expect(previewImport).not.toHaveBeenCalled();
    });

    it('refuses a body over the import limit, by its declared length, before reading it', async () => {
        const res = await handleAccountImport(
            post('{}', { 'content-length': String(ACCOUNT_IMPORT_MAX_BYTES + 1) }),
            'preview',
        );
        expect(res.status).toBe(413);
        expect(previewImport).not.toHaveBeenCalled();
    });

    it('refuses a payload that is not an export, and a body that is not JSON', async () => {
        expect(
            (
                await handleAccountImport(
                    post({ payload: { data: { works: 'not a list' } } }),
                    'preview',
                )
            ).status,
        ).toBe(400);
        expect((await handleAccountImport(post('not json'), 'preview')).status).toBe(400);
        expect(previewImport).not.toHaveBeenCalled();
    });

    it('answers an API failure in the same { success, data, error } shape the dialog reads', async () => {
        previewImport.mockRejectedValue(new Error('Slug conflict check failed'));
        const res = await handleAccountImport(post({ payload: exportOf() }), 'preview');
        expect(await res.json()).toEqual({
            success: false,
            data: null,
            error: 'Slug conflict check failed',
        });
    });
});
