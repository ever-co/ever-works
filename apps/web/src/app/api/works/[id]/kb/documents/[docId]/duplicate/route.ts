import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; docId: string }> };

/**
 * Proxy for the KB tree's "Duplicate" (`KbDocumentContextMenu`).
 *
 * The menu has posted here since it shipped, but neither this route nor the
 * API endpoint existed, so every click answered 404.
 *
 * `POST /api/works/:id/kb/documents/:docId/duplicate`
 *   body  → `{ path?: string, title?: string }` (anything else the menu sends,
 *           e.g. `sourceId`, is dropped: the API validates with
 *           forbidNonWhitelisted and the source is the `:docId` segment)
 *   201   → the new `KbDocumentBodyDto` (`id`, `path`, …)
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
    const { id, docId } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body: { path?: string; title?: string } = {};
    if (typeof raw?.path === 'string' && raw.path.trim()) body.path = raw.path.trim();
    if (typeof raw?.title === 'string' && raw.title.trim()) body.title = raw.title.trim();

    const upstream = await fetch(
        // Security: encode both path segments to prevent URL injection via crafted IDs
        `${API_URL}/works/${encodeURIComponent(id)}/kb/documents/${encodeURIComponent(docId)}/duplicate`,
        {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            cache: 'no-store',
        },
    );

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    const json = await upstream.json().catch(() => null);
    return NextResponse.json(json ?? null, { status: 201 });
}
