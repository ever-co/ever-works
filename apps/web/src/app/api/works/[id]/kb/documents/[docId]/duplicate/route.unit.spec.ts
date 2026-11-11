import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { POST } from './route';

const WORK = '11111111-2222-4333-8444-555555555555';
const DOC = '22222222-2222-4333-8444-555555555555';

function request(body: unknown): NextRequest {
    return new NextRequest(`http://web.example/api/works/${WORK}/kb/documents/${DOC}/duplicate`, {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    });
}

const params = { params: Promise.resolve({ id: WORK, docId: DOC }) };

/**
 * The KB tree's Duplicate posts `{ path, sourceId }`. The API validates with
 * `forbidNonWhitelisted`, so forwarding `sourceId` (or anything else) answers
 * 400: the proxy must keep only `path` and `title`.
 */
describe('POST /api/works/:id/kb/documents/:docId/duplicate', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ id: 'copy-1', path: 'brand/voice-2.md' }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('forwards only path and title: sourceId and any other field are dropped', async () => {
        const response = await POST(
            request({
                path: 'brand/voice-copy.md',
                title: 'Voice v2',
                sourceId: DOC,
                status: 'active',
                reviewState: 'accepted',
            }),
            params,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`http://api.example/works/${WORK}/kb/documents/${DOC}/duplicate`);
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fake-jwt');
        expect(JSON.parse(init.body as string)).toEqual({
            path: 'brand/voice-copy.md',
            title: 'Voice v2',
        });
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ id: 'copy-1', path: 'brand/voice-2.md' });
    });

    it('sends an empty body when the menu sends only sourceId', async () => {
        await POST(request({ sourceId: DOC }), params);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toEqual({});
    });
});
