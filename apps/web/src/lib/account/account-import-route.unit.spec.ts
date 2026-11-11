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

import { handleAccountImport, readJsonBody } from './account-import-route';
import { ACCOUNT_IMPORT_MAX_BYTES, resolveAccountImportMaxBytes } from './account-import.shared';

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
        headers: {
            'Content-Type': 'application/json',
            'x-ever-workspace': 'personal',
            ...headers,
        },
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

    it('refuses a request without the workspace selector BEFORE reading its body', async () => {
        const read = vi.fn();
        // highWaterMark 0: the stream pulls only when someone reads it.
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    read();
                    controller.enqueue(new TextEncoder().encode('{"payload":{}}'));
                    controller.close();
                },
            },
            { highWaterMark: 0 },
        );
        const request = new Request('http://localhost/api/account/import/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            duplex: 'half',
        } as RequestInit);
        const res = await handleAccountImport(request, 'preview');
        expect(res.status).toBe(400);
        expect(read).not.toHaveBeenCalled();
        expect(previewImport).not.toHaveBeenCalled();
    });

    it('cuts off a chunked upload (no content-length) at the limit instead of buffering it', async () => {
        const chunk = new Uint8Array(1024 * 1024).fill(0x20);
        let pulled = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                if (pulled > 60) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
            },
        });
        const request = new Request('http://localhost/api/account/import/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-ever-workspace': 'personal' },
            body,
            duplex: 'half',
        } as RequestInit);
        expect(request.headers.get('content-length')).toBeNull();
        const res = await handleAccountImport(request, 'preview');
        expect(res.status).toBe(413);
        // 25 MB limit: it stops after the 26th 1 MB chunk, not at the 60th.
        expect(pulled).toBeLessThan(30);
        expect(previewImport).not.toHaveBeenCalled();
    });

    it('reads a body under the limit whole, across chunks', async () => {
        const text = JSON.stringify({ payload: exportOf(0.5) });
        const bytes = new TextEncoder().encode(text);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let i = 0; i < bytes.length; i += 65536) {
                    controller.enqueue(bytes.slice(i, i + 65536));
                }
                controller.close();
            },
        });
        const read = await readJsonBody(
            new Request('http://localhost/x', {
                method: 'POST',
                body,
                duplex: 'half',
            } as RequestInit),
            1024 * 1024,
        );
        expect(read).toEqual({ ok: true, value: JSON.parse(text) });
    });

    it('takes its limit from ACCOUNT_IMPORT_BODY_LIMIT, as the API does', async () => {
        const saved = process.env.ACCOUNT_IMPORT_BODY_LIMIT;
        process.env.ACCOUNT_IMPORT_BODY_LIMIT = '2mb';
        try {
            const res = await handleAccountImport(post({ payload: exportOf(3) }), 'preview');
            expect(res.status).toBe(413);
            expect((await res.json()).error).toBe(
                'The export is larger than the import limit (2 MB).',
            );
        } finally {
            if (saved === undefined) delete process.env.ACCOUNT_IMPORT_BODY_LIMIT;
            else process.env.ACCOUNT_IMPORT_BODY_LIMIT = saved;
        }
        expect(resolveAccountImportMaxBytes(undefined)).toBe(ACCOUNT_IMPORT_MAX_BYTES);
        expect(resolveAccountImportMaxBytes('10MB')).toBe(10 * 1024 * 1024);
        expect(resolveAccountImportMaxBytes('51mb')).toBe(ACCOUNT_IMPORT_MAX_BYTES);
        expect(resolveAccountImportMaxBytes('lots')).toBe(ACCOUNT_IMPORT_MAX_BYTES);
        expect(resolveAccountImportMaxBytes('0')).toBe(ACCOUNT_IMPORT_MAX_BYTES);
    });

    it("answers the API's own 413 with the import-limit message, not its raw text", async () => {
        previewImport.mockRejectedValue(
            Object.assign(new Error('request entity too large'), { statusCode: 413 }),
        );
        const res = await handleAccountImport(post({ payload: exportOf() }), 'preview');
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({
            success: false,
            data: null,
            error: 'The export is larger than the import limit.',
        });
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
