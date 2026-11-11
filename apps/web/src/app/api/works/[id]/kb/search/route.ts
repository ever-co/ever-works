import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import type { KbSearchResult } from '@ever-works/contracts';
import {
    parseKbSearchRequest,
    toKbSearchResult,
    upstreamKbSearchParams,
} from '@/lib/kb/kb-search-proxy.shared';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * EW-641 Phase 1B/d row 15 — lexical KB search proxy for the CmdK
 * palette.
 *
 * Phase 1A shipped `q` as a filter on `GET /works/:id/kb/documents`
 * (Postgres FTS across title + description + body — see
 * `KbDocumentListFilter.q` in `@ever-works/contracts`). Rather than
 * spinning up a parallel `/search` route on the agent side we proxy
 * straight to that endpoint here. The row 30 RRF rewrite (Phase 2)
 * will swap the underlying ranker without changing this contract.
 *
 * `GET /api/works/:id/kb/search?q=&limit=&class=&status=&tag=&locked=&language=`
 *   200 → `{ items: KbDocumentDto[]; hits: KbSearchHit[]; total }` — `items`
 *         for the wikilink / mention pickers, `hits` for the workbench
 *         palette; mapping and filters in `@/lib/kb/kb-search-proxy.shared`.
 *
 * Server-side proxy keeps the JWT cookie + `API_URL` resolution on the
 * server (matches `kb/tags` and `kb/uploads`). Empty `q` short-circuits
 * to an empty result so the client doesn't have to special-case it.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const search = parseKbSearchRequest(request.nextUrl.searchParams);

    if (search.q.length === 0) {
        return NextResponse.json(
            { items: [], hits: [], total: 0 } satisfies KbSearchResult & { items: [] },
            {
                status: 200,
            },
        );
    }

    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstreamParams = upstreamKbSearchParams(search);

    // Security: percent-encode the `id` path segment so a crafted Work ID
    // (containing `/`, `..`, or `@`) can't break out of the `works/:id/...`
    // path and re-resolve to an unintended upstream API route. Matches the
    // `encodeURIComponent(id)` pattern already used by the sibling citations
    // and document-history proxies. Behaviour-preserving for real Work IDs.
    const upstream = await fetch(
        `${API_URL}/works/${encodeURIComponent(id)}/kb/documents?${upstreamParams.toString()}`,
        {
            method: 'GET',
            headers,
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
    return NextResponse.json(toKbSearchResult(search, json), { status: 200 });
}
