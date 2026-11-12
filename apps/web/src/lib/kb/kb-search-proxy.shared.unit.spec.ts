import { describe, expect, it } from 'vitest';
import type { KbDocumentDto } from '@ever-works/contracts';
import {
    KB_SEARCH_MAX_LIMIT,
    parseKbSearchRequest,
    toKbSearchResult,
    upstreamKbSearchParams,
} from './kb-search-proxy.shared';

const doc = (overrides: Partial<KbDocumentDto>): KbDocumentDto =>
    ({
        id: 'd1',
        path: 'brand/voice.md',
        title: 'Voice',
        description: 'How we write',
        class: 'brand',
        tags: [],
        status: 'active',
        ...overrides,
    }) as KbDocumentDto;

const request = (query: string) => parseKbSearchRequest(new URLSearchParams(query));

describe('KB search proxy — what goes upstream', () => {
    it('forwards the palette filters the documents endpoint understands', () => {
        const upstream = upstreamKbSearchParams(
            request(
                'q=voice&class=brand&class=style&status=draft&tag=tone&locked=true&language=en&searchBody=true',
            ),
        );
        expect(upstream.get('q')).toBe('voice');
        expect(upstream.getAll('classes')).toEqual(['brand', 'style']);
        expect(upstream.get('status')).toBe('draft');
        expect(upstream.get('tag')).toBe('tone');
        expect(upstream.get('locked')).toBe('true');
        expect(upstream.get('language')).toBe('en');
        expect(upstream.get('searchBody')).toBe('true');
    });

    it('sends only q + limit for the wikilink / mention pickers (no searchBody), as before', () => {
        const upstream = upstreamKbSearchParams(request('q=voi&limit=10'));
        expect([...upstream.keys()].sort()).toEqual(['limit', 'q']);
        expect(upstream.get('limit')).toBe('10');
    });

    it('does not send a half-typed language (the API needs 2–8 characters)', () => {
        expect(upstreamKbSearchParams(request('q=x&language=e')).has('language')).toBe(false);
    });

    it('sends several statuses and tags upstream for the API to filter, at the requested limit', () => {
        const upstream = upstreamKbSearchParams(
            request('q=x&status=draft&status=active&tag=tone&tag=web,legal&limit=5'),
        );
        expect(upstream.getAll('statuses')).toEqual(['draft', 'active']);
        expect(upstream.getAll('tags')).toEqual(['tone', 'web', 'legal']);
        expect(upstream.has('status')).toBe(false);
        expect(upstream.has('tag')).toBe(false);
        // It used to fetch KB_SEARCH_MAX_LIMIT and filter that page itself.
        expect(upstream.get('limit')).toBe('5');
    });

    it('keeps one status or tag on the original single key', () => {
        const upstream = upstreamKbSearchParams(request('q=x&status=draft&tag=tone'));
        expect(upstream.get('status')).toBe('draft');
        expect(upstream.get('tag')).toBe('tone');
        expect(upstream.has('statuses')).toBe(false);
        expect(upstream.has('tags')).toBe(false);
    });

    it('caps the limit it forwards at the proxy maximum', () => {
        expect(upstreamKbSearchParams(request('q=x&limit=500')).get('limit')).toBe(
            String(KB_SEARCH_MAX_LIMIT),
        );
    });
});

describe('KB search proxy — what comes back', () => {
    it('answers the palette with hits — it used to get only { items } and always showed no results', () => {
        const result = toKbSearchResult(request('q=voice'), { items: [doc({})], total: 1 });
        expect(result.hits).toEqual([
            {
                documentId: 'd1',
                path: 'brand/voice.md',
                title: 'Voice',
                class: 'brand',
                snippet: 'How we write',
                score: 0,
            },
        ]);
        expect(result.total).toBe(1);
    });

    it('keeps items for the wikilink / mention pickers and the detail-page palette', () => {
        const result = toKbSearchResult(request('q=voice'), { items: [doc({})], total: 1 });
        expect(result.items.map((d) => d.id)).toEqual(['d1']);
    });

    it('leaves several statuses and tags to the API: its page and its total, as they come', () => {
        // The API already filtered; the proxy no longer re-filters one page
        // and no longer replaces `total` with the size of that page.
        const items = [
            doc({ id: 'a', status: 'draft', tags: ['tone', 'web'] }),
            doc({ id: 'b', status: 'active', tags: ['web', 'tone'] }),
        ];
        const result = toKbSearchResult(
            request('q=x&status=draft&status=active&tag=tone&tag=web'),
            { items, total: 73 },
        );
        expect(result.hits.map((h) => h.documentId)).toEqual(['a', 'b']);
        expect(result.items.map((d) => d.id)).toEqual(['a', 'b']);
        expect(result.total).toBe(73);
    });

    it('survives an empty or unreadable upstream answer', () => {
        expect(toKbSearchResult(request('q=x'), null)).toEqual({ items: [], hits: [], total: 0 });
    });
});
