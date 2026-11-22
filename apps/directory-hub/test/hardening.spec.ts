import { describe, expect, it } from 'vitest';

import { handleRequest } from '../src/app';
import { firstSseData, MAX_DESCRIPTION_LENGTH, toItemSummary } from '../src/loader';
import { MAX_BODY_BYTES } from '../src/mcp';
import { directoryTokenScore, entryText, MAX_QUERY_TOKENS, parseQuery } from '../src/search';
import { callHubTool, MAX_FORWARDED_ARGUMENTS } from '../src/tools';
import { fakeNetwork, HUB_URL, loaderFor, ORIGINS } from './fixtures';

describe('query limits', () => {
	it('uses at most MAX_QUERY_TOKENS words and drops one-letter words unless nothing else is left', () => {
		const many = parseQuery(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
		expect(many.required).toHaveLength(MAX_QUERY_TOKENS);
		expect(parseQuery('b c d e f g crm').required).toEqual(['crm']);
		expect(parseQuery('c').required).toEqual(['c']);
	});

	it('matches directory topics and ids by word prefix, not substring', () => {
		const text = entryText({
			id: 'transactional-email',
			url: 'https://transactional-email.ever.works',
			host: 'transactional-email.ever.works',
			name: 'Awesome Transactional Email',
			description: null,
			topics: ['email api', 'smtp relay'],
			aliases: []
		});
		expect(directoryTokenScore('ai', text).strong).toBe(false);
		expect(directoryTokenScore('mail', text).strong).toBe(false);
		expect(directoryTokenScore('email', text).strong).toBe(true);
		expect(directoryTokenScore('smtp', text).strong).toBe(true);
		expect(directoryTokenScore('transact', text).strong).toBe(true);
	});
});

describe('item sanitizing', () => {
	it('keeps only http(s) links and truncates long descriptions', () => {
		const summary = toItemSummary({
			slug: 'x',
			name: 'X',
			description: 'd'.repeat(MAX_DESCRIPTION_LENGTH + 500),
			url: 'javascript:alert(1)',
			website: 'data:text/html,hi',
			logo: 'https://cdn.example.com/x.png'
		});
		expect(summary?.description).toHaveLength(MAX_DESCRIPTION_LENGTH);
		expect(summary?.url).toBe('');
		expect(summary?.website).toBeNull();
		expect(summary?.logo).toBe('https://cdn.example.com/x.png');
	});

	it('joins the data lines of the first server-sent event', () => {
		expect(firstSseData('event: message\ndata: {"a":\ndata: 1}\n\ndata: {"b":2}\n')).toBe('{"a":\n1}');
		expect(firstSseData('event: ping\n\n')).toBe('');
	});
});

describe('upstream calls', () => {
	it('answers an unknown slug from the cached item list without fetching it', async () => {
		const network = fakeNetwork();
		const loader = loaderFor(network);
		await expect(callHubTool('get_item', { directory: 'timetrack', slug: 'guess-1' }, loader)).rejects.toThrow(
			/No item "guess-1"/
		);
		expect(network.calls.some((url) => url.endsWith('/data/items/guess-1.json'))).toBe(false);
	});

	it('reports a timed-out directory as a tool error, not an internal error', async () => {
		const network = fakeNetwork();
		network.routes.set(`${ORIGINS.TIME}/data/items/kimai.json`, () => {
			throw new DOMException('The operation timed out.', 'TimeoutError');
		});
		await expect(
			callHubTool('get_item', { directory: 'timetrack', slug: 'kimai' }, loaderFor(network))
		).rejects.toThrow(/could not be read \(timed out\)/);
	});

	it('refuses to forward oversized query_directory arguments', async () => {
		const network = fakeNetwork();
		const big = { query: 'x'.repeat(MAX_FORWARDED_ARGUMENTS) };
		await expect(
			callHubTool(
				'query_directory',
				{ directory: 'mcp-servers', tool: 'search_items', arguments: big },
				loaderFor(network)
			)
		).rejects.toThrow(/too large/);
		expect(network.upstreamBodies).toHaveLength(0);
	});

	it('hands every shared load to keepAlive, so it survives the request that started it', async () => {
		const loader = loaderFor(fakeNetwork());
		const kept: Array<Promise<unknown>> = [];
		loader.keepAlive = (promise) => kept.push(promise);
		await loader.getRegistry();
		await loader.getRegistry();
		expect(kept).toHaveLength(1);
	});
});

describe('request size', () => {
	it('answers 413 to a body larger than MAX_BODY_BYTES', async () => {
		const response = await handleRequest(
			new Request(`${HUB_URL}/mcp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'ping',
					params: { pad: 'x'.repeat(MAX_BODY_BYTES) }
				})
			}),
			{ loader: loaderFor(fakeNetwork()), hubUrl: HUB_URL, log: () => undefined }
		);
		expect(response.status).toBe(413);
		expect(((await response.json()) as any).error.code).toBe(-32600);
	});
});
