import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

const WORK = '11111111-2222-4333-8444-555555555555';

const request = (query: string) =>
    new NextRequest(`http://web.example/api/works/${WORK}/kb/search${query}`, { method: 'GET' });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

const DOC = {
    id: 'd1',
    path: 'brand/voice.md',
    title: 'Voice',
    description: 'How we write',
    class: 'brand',
    tags: ['tone'],
    status: 'active',
};

/**
 * Review of #3162 — the route wiring, not just the shared module: the
 * workbench palette's filters reach `GET /works/:id/kb/documents`, and the
 * answer carries `hits` next to the unchanged `items` + `total`.
 */
describe('GET /api/works/:id/kb/search', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () => json({ items: [DOC], total: 1 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('forwards the palette filters upstream with the session token and answers hits + items', async () => {
        const response = await GET(
            request(
                '?q=voice&limit=10&class=brand&class=style&status=active&tag=tone&locked=true&language=en&searchBody=true',
            ),
            params(WORK),
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const upstream = new URL(url);
        expect(`${upstream.origin}${upstream.pathname}`).toBe(
            `http://api.example/works/${WORK}/kb/documents`,
        );
        expect(upstream.searchParams.get('q')).toBe('voice');
        expect(upstream.searchParams.get('limit')).toBe('10');
        expect(upstream.searchParams.getAll('classes')).toEqual(['brand', 'style']);
        expect(upstream.searchParams.get('status')).toBe('active');
        expect(upstream.searchParams.get('tag')).toBe('tone');
        expect(upstream.searchParams.get('locked')).toBe('true');
        expect(upstream.searchParams.get('language')).toBe('en');
        expect(upstream.searchParams.get('searchBody')).toBe('true');
        expect(init.method).toBe('GET');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fake-jwt');

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.items).toEqual([DOC]);
        expect(body.total).toBe(1);
        expect(body.hits).toEqual([
            {
                documentId: 'd1',
                path: 'brand/voice.md',
                title: 'Voice',
                class: 'brand',
                snippet: 'How we write',
                score: 0,
            },
        ]);
    });

    it('keeps the pickers’ request as it was: q + limit only, no body search', async () => {
        await GET(request('?q=voi&limit=8'), params(WORK));
        const upstream = new URL((fetchMock.mock.calls[0] as [string])[0]);
        expect([...upstream.searchParams.keys()].sort()).toEqual(['limit', 'q']);
    });

    it('applies a multi-status filter the API cannot take itself', async () => {
        fetchMock.mockResolvedValueOnce(
            json({
                items: [
                    { ...DOC, id: 'a', status: 'active' },
                    { ...DOC, id: 'b', status: 'archived' },
                    { ...DOC, id: 'c', status: 'draft' },
                ],
                total: 3,
            }),
        );
        const response = await GET(request('?q=voice&status=active&status=draft'), params(WORK));
        const upstream = new URL((fetchMock.mock.calls[0] as [string])[0]);
        expect(upstream.searchParams.get('status')).toBeNull();
        const body = await response.json();
        expect(body.hits.map((h: { documentId: string }) => h.documentId)).toEqual(['a', 'c']);
        expect(body.total).toBe(2);
    });

    it('answers an empty query without calling the API', async () => {
        const response = await GET(request('?q=%20'), params(WORK));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await response.json()).toEqual({ items: [], hits: [], total: 0 });
    });

    it('percent-encodes the Work id path segment', async () => {
        await GET(request('?q=x'), params('../admin'));
        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url.startsWith('http://api.example/works/..%2Fadmin/kb/documents?')).toBe(true);
    });

    it('passes an upstream error through with its status', async () => {
        fetchMock.mockResolvedValueOnce(json({ message: 'Work not found' }, 404));
        const response = await GET(request('?q=voice'), params(WORK));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ message: 'Work not found' });
    });
});
