import { describe, expect, it } from 'vitest';

import { parseQuery, tokenVariants } from '../src/search';
import { callHubTool, ToolInputError, type ToolOutcome } from '../src/tools';
import { fakeNetwork, loaderFor, ORIGINS } from './fixtures';

function structured(outcome: ToolOutcome): any {
	if (outcome.kind !== 'structured') throw new Error('expected a structured result');
	return outcome.value;
}

describe('query parsing', () => {
	it('makes filler words optional unless nothing else is left', () => {
		expect(parseQuery('find time tracking tools')).toMatchObject({
			required: ['time', 'tracking'],
			optional: ['find', 'tools']
		});
		expect(parseQuery('find tools')).toMatchObject({ required: ['find', 'tools'], optional: [] });
	});

	it('tries a naive singular', () => {
		expect(tokenVariants('servers')).toEqual(['servers', 'server']);
		expect(tokenVariants('companies')).toEqual(['companies', 'company']);
		expect(tokenVariants('access')).toEqual(['access']);
		expect(tokenVariants('mcp')).toEqual(['mcp']);
	});
});

describe('search_all', () => {
	it('surfaces the time tracking directory for "time tracking tools"', async () => {
		const result = structured(
			await callHubTool('search_all', { query: 'time tracking tools' }, loaderFor(fakeNetwork()))
		);
		const ids = result.items.map((item: any) => `${item.directory.id}/${item.slug}`);
		expect(ids.slice(0, 3).every((id: string) => id.startsWith('timetrack/'))).toBe(true);
		expect(ids[0]).toBe('timetrack/toggl-track'); // featured and "track" in its name
		expect(ids).toContain('crm/zoho-crm'); // mentions time tracking, ranked after the directory's own items
		expect(ids.indexOf('crm/zoho-crm')).toBeGreaterThan(2);
		expect(result.matched_directories[0]).toMatchObject({ id: 'timetrack', topic_match: true, hits: 3 });
		expect(result.items[0]).toMatchObject({
			url: `${ORIGINS.TIME}/items/toggl-track`,
			directory: { id: 'timetrack', name: 'Awesome Time Tracking', url: ORIGINS.TIME }
		});
		expect(result.directories_searched).toBe(4);
		expect(result.unavailable.sort()).toEqual(['down', 'mismatch', 'old']);
	});

	it('answers "MCP servers for databases" with MCP servers that match databases first', async () => {
		const result = structured(
			await callHubTool('search_all', { query: 'MCP servers for databases' }, loaderFor(fakeNetwork()))
		);
		const ids = result.items.map((item: any) => `${item.directory.id}/${item.slug}`);
		expect(ids.slice(0, 2).sort()).toEqual(['mcp-servers/mysql-mcp', 'mcp-servers/postgres-mcp']);
		expect(ids).not.toContain('mcp-servers/github-mcp'); // an MCP server, but not for databases
		expect(ids).toContain('managed-databases/neon'); // a database with an MCP server, lower down
	});

	it('honours directories, category, limit and per_directory', async () => {
		const loader = loaderFor(fakeNetwork());
		const onlyCrm = structured(
			await callHubTool('search_all', { query: 'crm', directories: ['crm.ever.works'] }, loader)
		);
		expect(new Set(onlyCrm.items.map((item: any) => item.directory.id))).toEqual(new Set(['crm']));

		const category = structured(await callHubTool('search_all', { query: 'mcp', category: 'databases' }, loader));
		expect(category.items.map((item: any) => item.slug).sort()).toEqual(['mysql-mcp', 'postgres-mcp']);

		const capped = structured(
			await callHubTool('search_all', { query: 'time tracking', per_directory: 1 }, loader)
		);
		expect(capped.items.filter((item: any) => item.directory.id === 'timetrack')).toHaveLength(1);
		expect(capped.total).toBeGreaterThan(capped.items.length);

		const limited = structured(await callHubTool('search_all', { query: 'time tracking', limit: 1 }, loader));
		expect(limited.items).toHaveLength(1);
	});

	it('gives a hint when nothing matches', async () => {
		const result = structured(
			await callHubTool('search_all', { query: 'quantum blockchain' }, loaderFor(fakeNetwork()))
		);
		expect(result.total).toBe(0);
		expect(result.hint).toMatch(/list_directories/);
	});

	it('rejects a missing query and unknown directories without fetching them', async () => {
		const network = fakeNetwork();
		const loader = loaderFor(network);
		await expect(callHubTool('search_all', {}, loader)).rejects.toThrow(ToolInputError);
		await expect(callHubTool('search_all', { query: '!!!' }, loader)).rejects.toThrow(/letters or digits/);
		await expect(
			callHubTool('search_all', { query: 'crm', directories: ['https://attacker.example.com'] }, loader)
		).rejects.toThrow(/Unknown directories/);
		expect(network.calls.some((url) => url.includes('attacker'))).toBe(false);
	});
});

describe('list_directories', () => {
	it('lists available directories by name, with endpoints and counts', async () => {
		const result = structured(await callHubTool('list_directories', {}, loaderFor(fakeNetwork())));
		expect(result.directories.map((entry: any) => entry.id)).toEqual([
			'crm',
			'managed-databases',
			'mcp-servers',
			'timetrack'
		]);
		expect(result.directories[0]).toMatchObject({
			name: 'Awesome CRM',
			url: ORIGINS.CRM,
			mcp: null,
			llms: `${ORIGINS.CRM}/llms.txt`,
			items: 2
		});
		expect(result.unavailable_count).toBe(3);
		expect(result.unavailable).toBeUndefined();
	});

	it('finds directories about a topic, and falls back to item matches', async () => {
		const loader = loaderFor(fakeNetwork());
		const topic = structured(await callHubTool('list_directories', { query: 'customer relationship' }, loader));
		expect(topic.directories.map((entry: any) => entry.id)).toEqual(['crm']);

		const byItems = structured(await callHubTool('list_directories', { query: 'postgres' }, loader));
		expect(byItems.directories.map((entry: any) => entry.id).sort()).toEqual(['managed-databases', 'mcp-servers']);

		const all = structured(await callHubTool('list_directories', { include_unavailable: true, limit: 2 }, loader));
		expect(all.directories).toHaveLength(2);
		expect(all.unavailable.map((entry: any) => entry.id).sort()).toEqual(['down', 'mismatch', 'old']);
	});
});

describe('get_item', () => {
	it('returns the full item with its directory', async () => {
		const result = structured(
			await callHubTool('get_item', { directory: 'timetrack', slug: 'kimai' }, loaderFor(fakeNetwork()))
		);
		expect(result).toMatchObject({ slug: 'kimai', markdown: '# Kimai', directory: { id: 'timetrack' } });
	});

	it('rejects bad slugs, unknown items, unknown and unavailable directories', async () => {
		const network = fakeNetwork();
		const loader = loaderFor(network);
		await expect(callHubTool('get_item', { directory: 'timetrack', slug: '../secret' }, loader)).rejects.toThrow(
			/No item/
		);
		await expect(callHubTool('get_item', { directory: 'timetrack', slug: 'a/b' }, loader)).rejects.toThrow(
			/No item/
		);
		await expect(callHubTool('get_item', { directory: 'timetrack', slug: 'missing' }, loader)).rejects.toThrow(
			/No item "missing"/
		);
		await expect(callHubTool('get_item', { directory: 'nope', slug: 'x' }, loader)).rejects.toThrow(
			/Unknown directory/
		);
		await expect(callHubTool('get_item', { directory: 'old', slug: 'x' }, loader)).rejects.toThrow(
			/cannot be read/
		);
		expect(network.calls.some((url) => url.includes('..') || url.includes('a/b'))).toBe(false);
	});
});

describe('query_directory', () => {
	it("passes the directory's own MCP result through unchanged", async () => {
		const network = fakeNetwork();
		const outcome = await callHubTool(
			'query_directory',
			{ directory: 'mcp-servers', tool: 'list_categories' },
			loaderFor(network)
		);
		expect(outcome.kind).toBe('passthrough');
		if (outcome.kind !== 'passthrough') return;
		expect(outcome.result).toMatchObject({ structuredContent: { total: 1 } });
		expect(network.upstreamBodies[0]).toMatchObject({
			method: 'tools/call',
			params: { name: 'list_categories', arguments: {} }
		});
	});

	it('answers from the read API when the directory has no MCP endpoint', async () => {
		const loader = loaderFor(fakeNetwork());
		const categories = structured(
			await callHubTool('query_directory', { directory: 'crm', tool: 'list_categories' }, loader)
		);
		expect(categories.total).toBe(1);
		const tags = structured(
			await callHubTool(
				'query_directory',
				{ directory: 'crm', tool: 'list_tags', arguments: { limit: 1 } },
				loader
			)
		);
		expect(tags).toMatchObject({ total: 2, tags: [{ id: 'freemium' }] });
		await expect(
			callHubTool(
				'query_directory',
				{ directory: 'crm', tool: 'search_items', arguments: { query: 'x' } },
				loader
			)
		).rejects.toThrow(/search_all/);
	});

	it('only accepts Contract v1 tools and object arguments', async () => {
		const loader = loaderFor(fakeNetwork());
		await expect(
			callHubTool('query_directory', { directory: 'crm', tool: 'delete_everything' }, loader)
		).rejects.toThrow(/must be one of/);
		await expect(
			callHubTool('query_directory', { directory: 'crm', tool: 'list_tags', arguments: [1] }, loader)
		).rejects.toThrow(/must be an object/);
	});

	it('turns upstream JSON-RPC errors and outages into tool errors', async () => {
		const network = fakeNetwork();
		const loader = loaderFor(network);
		network.routes.set(`${ORIGINS.MCP}/mcp`, () =>
			Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool' } })
		);
		await expect(
			callHubTool('query_directory', { directory: 'mcp-servers', tool: 'list_tags' }, loader)
		).rejects.toThrow(/Unknown tool/);
		network.routes.set(`${ORIGINS.MCP}/mcp`, () => new Response('bad gateway', { status: 502 }));
		await expect(
			callHubTool('query_directory', { directory: 'mcp-servers', tool: 'list_tags' }, loader)
		).rejects.toThrow(/could not be reached \(HTTP 502\)/);
	});

	it('reads a streaming (text/event-stream) answer', async () => {
		const network = fakeNetwork();
		network.routes.set(
			`${ORIGINS.MCP}/mcp`,
			() =>
				new Response(
					'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[],"structuredContent":{"ok":true}}}\n\n',
					{
						headers: { 'Content-Type': 'text/event-stream' }
					}
				)
		);
		const outcome = await callHubTool(
			'query_directory',
			{ directory: 'mcp-servers', tool: 'list_tags' },
			loaderFor(network)
		);
		expect(outcome).toMatchObject({ kind: 'passthrough', result: { structuredContent: { ok: true } } });
	});
});
