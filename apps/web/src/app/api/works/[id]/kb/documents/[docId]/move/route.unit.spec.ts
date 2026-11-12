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
    return new NextRequest(`http://web.example/api/works/${WORK}/kb/documents/${DOC}/move`, {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const params = { params: Promise.resolve({ id: WORK, docId: DOC }) };

/**
 * The KB tree's Rename used to PATCH `{ path }`, which the API refuses (400):
 * a path change is `POST …/move`. The proxy forwards the path alone and hands
 * the API's refusals back untouched, so the menu can say why.
 */
describe('POST /api/works/:id/kb/documents/:docId/move', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ id: DOC, path: 'brand/tone.md', slug: 'tone' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('POSTs the trimmed path alone to the API move route, with the session token', async () => {
        const response = await POST(
            request({ path: '  brand/tone.md ', title: 'x', status: 'archived' }),
            params,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`http://api.example/works/${WORK}/kb/documents/${DOC}/move`);
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fake-jwt');
        expect(JSON.parse(init.body as string)).toEqual({ path: 'brand/tone.md' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: DOC, path: 'brand/tone.md', slug: 'tone' });
    });

    it('encodes the route segments', async () => {
        await POST(request({ path: 'brand/tone.md' }), {
            params: Promise.resolve({ id: 'a/../b', docId: 'c?d' }),
        });
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toBe('http://api.example/works/a%2F..%2Fb/kb/documents/c%3Fd/move');
    });

    it.each([
        ['no path', {}],
        ['a blank path', { path: '   ' }],
        ['a path that is not a string', { path: 42 }],
        ['a body that is not JSON', 'not json'],
    ])('answers 400 KbPathInvalid for %s without calling the API', async (_label, body) => {
        const response = await POST(request(body), params);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'KbPathInvalid' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("hands the API's refusal back as is (status and body, so the menu can read `code`)", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ statusCode: 409, code: 'KbPathTaken', message: 'taken' }),
                { status: 409, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        const response = await POST(request({ path: 'brand/colors.md' }), params);
        expect(response.status).toBe(409);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toEqual({
            statusCode: 409,
            code: 'KbPathTaken',
            message: 'taken',
        });
    });
});
