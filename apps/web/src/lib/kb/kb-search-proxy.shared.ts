import type { KbDocumentDto, KbSearchHit, KbSearchResult } from '@ever-works/contracts';

/**
 * The Ctrl+K KB search palette's proxy (`/api/works/:id/kb/search`) on top of
 * `GET /works/:id/kb/documents` — kept free of Next.js so it is unit tested.
 *
 * The workbench palette reads `{ hits: KbSearchHit[] }` and sends its filter
 * chips as `class` / `status` / `tag` (each repeatable), `locked`, `language`.
 * The proxy forwarded only `q` + `limit` and returned the list endpoint's
 * `{ items, total }` verbatim, so that palette showed "no results" for every
 * query and every chip did nothing. Now:
 *   - the answer carries `hits` NEXT TO the unchanged `items` + `total`: the
 *     wikilink / @mention pickers and the older detail-page palette read
 *     `items` and keep working exactly as before;
 *   - `searchBody=true` (sent by the workbench palette) extends the query to
 *     document bodies; without it the search stays on title + description, so
 *     the pickers' suggestions do not change;
 *   - classes go upstream as the repeatable `classes` facet, several statuses
 *     as `statuses` (any of them) and several tags as `tags` (all of them), so
 *     the API filters, pages and counts; one status or tag still goes as
 *     `status` / `tag`; `locked=true` and a 2–8 character `language` go
 *     upstream;
 *   - the documents are mapped to `KbSearchHit`s; `total` is the API's.
 */

export const KB_SEARCH_MAX_LIMIT = 50;
export const KB_SEARCH_DEFAULT_LIMIT = 20;

export interface KbSearchRequest {
    q: string;
    limit: number;
    classes: string[];
    statuses: string[];
    tags: string[];
    locked: boolean;
    language: string | null;
    searchBody: boolean;
}

function cleanList(values: string[]): string[] {
    return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

export function parseKbSearchRequest(params: URLSearchParams): KbSearchRequest {
    const limitRaw = params.get('limit');
    const limit =
        limitRaw && /^\d+$/.test(limitRaw)
            ? Math.min(Math.max(Number(limitRaw), 1), KB_SEARCH_MAX_LIMIT)
            : KB_SEARCH_DEFAULT_LIMIT;
    const language = (params.get('language') ?? '').trim();
    return {
        q: (params.get('q') ?? '').trim(),
        limit,
        classes: cleanList(params.getAll('class')),
        statuses: cleanList(params.getAll('status')),
        tags: cleanList(params.getAll('tag').flatMap((t) => t.split(','))),
        locked: params.get('locked') === 'true',
        // `KbDocumentQueryDto.language` is 2–8 characters; a shorter value
        // (half-typed) would answer 400, so it is not sent until it is valid.
        language: language.length >= 2 && language.length <= 8 ? language : null,
        searchBody: params.get('searchBody') === 'true',
    };
}

/** Query string for `GET /works/:id/kb/documents`. */
export function upstreamKbSearchParams(request: KbSearchRequest): URLSearchParams {
    const upstream = new URLSearchParams();
    upstream.set('q', request.q);
    if (request.searchBody) upstream.set('searchBody', 'true');
    upstream.set('limit', String(request.limit));
    for (const cls of request.classes) upstream.append('classes', cls);
    // The API filters several statuses (any) and several tags (all) itself,
    // so every match is found, not only those in one fetched page. A single
    // value keeps the original `status` / `tag` key.
    if (request.statuses.length === 1) upstream.set('status', request.statuses[0]!);
    else for (const status of request.statuses) upstream.append('statuses', status);
    if (request.tags.length === 1) upstream.set('tag', request.tags[0]!);
    else for (const tag of request.tags) upstream.append('tags', tag);
    if (request.locked) upstream.set('locked', 'true');
    if (request.language) upstream.set('language', request.language);
    return upstream;
}

/** The list answer as palette hits, next to the unchanged `items` + `total`. */
export function toKbSearchResult(
    request: KbSearchRequest,
    upstream: { items?: KbDocumentDto[]; total?: number } | null,
): KbSearchResult & { items: KbDocumentDto[] } {
    const items = (upstream?.items ?? []).slice(0, request.limit);
    const hits: KbSearchHit[] = items.map((doc) => ({
        documentId: doc.id,
        path: doc.path,
        title: doc.title,
        class: doc.class,
        snippet: doc.description ?? '',
        score: 0,
    }));
    return { items, hits, total: upstream?.total ?? items.length };
}
