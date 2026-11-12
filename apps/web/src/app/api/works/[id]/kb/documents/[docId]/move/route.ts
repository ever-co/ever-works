import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; docId: string }> };

/**
 * Proxy for the KB tree's "Rename" (`KbDocumentContextMenu`).
 *
 * `POST /api/works/:id/kb/documents/:docId/move`
 *   body  → `{ path: string }` — anything else is dropped (the API validates
 *           with forbidNonWhitelisted); a missing or blank path answers 400
 *           here without a round trip.
 *   200   → the moved `KbDocumentBodyDto` (`id`, `path`, `slug`, …)
 *   4xx   → the API's answer as is: 400 `KbPathInvalid`, 403 (locked, or no
 *           edit access), 404, 409 `KbPathTaken` / `KbLinkedFromLockedDocument`
 *           / `KbOrgDocumentPath` — the menu reads `code` to say why.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
    const { id, docId } = await params;

    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const path = typeof raw?.path === 'string' ? raw.path.trim() : '';
    if (!path) {
        return NextResponse.json(
            { statusCode: 400, code: 'KbPathInvalid', message: 'path is required' },
            { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
    }

    const token = await getAuthAccessCookie();
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(
        // Security: encode both path segments to prevent URL injection via crafted IDs
        `${API_URL}/works/${encodeURIComponent(id)}/kb/documents/${encodeURIComponent(docId)}/move`,
        {
            method: 'POST',
            headers,
            body: JSON.stringify({ path }),
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
    return NextResponse.json(json ?? null, { status: 200 });
}
