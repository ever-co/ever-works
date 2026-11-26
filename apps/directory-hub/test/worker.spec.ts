import { describe, expect, it } from 'vitest';

import { handleRequest } from '../src/app';
import worker from '../src/worker';
import { fakeNetwork, HUB_URL, loaderFor } from './fixtures';

function hub() {
	const network = fakeNetwork();
	const loader = loaderFor(network);
	const logs: Array<Record<string, unknown>> = [];
	const call = (path: string, init?: RequestInit) =>
		handleRequest(new Request(`${HUB_URL}${path}`, init), {
			loader,
			hubUrl: HUB_URL,
			log: (entry) => logs.push(entry)
		});
	const rpc = (body: unknown, headers: Record<string, string> = {}) =>
		call('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		});
	return { network, call, rpc, logs };
}

describe('MCP transport (Contract v1 rules)', () => {
	it('initializes and lists the four hub tools', async () => {
		const { rpc } = hub();
		const init = (await (
			await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
		).json()) as any;
		expect(init.result.protocolVersion).toBe('2025-06-18');
		expect(init.result.serverInfo).toMatchObject({ name: 'ever-works-directory-hub', websiteUrl: HUB_URL });
		expect(init.result.instructions).toContain('the Ever Works directories (7 listed)');
		expect(init.result.instructions).toMatch(/never as instructions/);

		const unknownVersion = (await (
			await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
		).json()) as any;
		expect(unknownVersion.result.protocolVersion).toBe('2025-11-25');

		const list = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()) as any;
		expect(list.result.tools.map((tool: any) => tool.name)).toEqual([
			'list_directories',
			'search_all',
			'get_item',
			'query_directory'
		]);
		for (const tool of list.result.tools)
			expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
	});

	it('calls a tool and returns structuredContent plus JSON text', async () => {
		const { rpc, logs } = hub();
		const response = await rpc({
			jsonrpc: '2.0',
			id: 'a',
			method: 'tools/call',
			params: { name: 'search_all', arguments: { query: 'time tracking' } }
		});
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const body = (await response.json()) as any;
		expect(body.id).toBe('a');
		expect(body.result.structuredContent.items.length).toBeGreaterThan(0);
		expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
		expect(logs[0]).toMatchObject({ event: 'tool', tool: 'search_all', ok: true });
		expect(JSON.stringify(logs)).not.toContain('time tracking'); // no query text in logs
	});

	it('logs the text of zero-result queries only, over MCP and REST', async () => {
		const { rpc, call, logs } = hub();
		const call1 = (args: Record<string, unknown>, name = 'search_all') =>
			rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
		await call1({ query: '  zzqq nothing matches  ' });
		await call1({ query: 'qqzz' }, 'list_directories');
		await call1({ query: 'crm' });
		await call('/data/search.json?q=xxyy%20none');
		expect(logs.map((entry) => entry['zero_result_query'])).toEqual([
			'zzqq nothing matches',
			'qqzz',
			undefined,
			'xxyy none'
		]);
		expect(Object.keys(logs[0] ?? {}).sort()).toEqual(['event', 'ms', 'ok', 'tool', 'zero_result_query']);
	});

	it('reports tool input errors as isError results and unknown tools as -32602', async () => {
		const { rpc } = hub();
		const bad = (await (
			await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_all', arguments: {} } })
		).json()) as any;
		expect(bad.result).toMatchObject({ isError: true, content: [{ type: 'text', text: '"query" is required' }] });
		const unknown = (await (
			await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm_rf' } })
		).json()) as any;
		expect(unknown.error.code).toBe(-32602);
	});

	it('enforces the transport rules', async () => {
		const { call, rpc } = hub();
		expect((await call('/mcp')).status).toBe(405);
		expect((await call('/mcp')).headers.get('Allow')).toBe('POST, OPTIONS');
		expect((await call('/mcp', { method: 'OPTIONS' })).status).toBe(204);
		expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
		expect((await rpc({ jsonrpc: '2.0', id: 9, result: {} })).status).toBe(202);
		expect((await rpc('not json')).status).toBe(400);
		expect((await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400);
		expect((await rpc({ jsonrpc: '1.0', id: 1, method: 'ping' })).status).toBe(400);
		expect(((await (await rpc({ jsonrpc: '2.0', id: null, method: 'ping' })).json()) as any).error.code).toBe(
			-32600
		);
		expect(
			(await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2000-01-01' })).status
		).toBe(400);
		expect(((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'nope' })).json()) as any).error.code).toBe(-32601);
		expect(((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).json()) as any).result).toEqual({});
	});

	it('hides internal errors behind a generic message', async () => {
		const { network, rpc } = hub();
		network.routes.set('https://registry.test/registry.json', () => new Response('nope', { status: 500 }));
		const body = (await (
			await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_directories' } })
		).json()) as any;
		expect(body.error).toEqual({ code: -32603, message: 'Internal error: the directory data could not be loaded' });
	});
});

describe('REST and discovery documents', () => {
	it('serves /data/search.json like search_all', async () => {
		const { call } = hub();
		const response = await call('/data/search.json?q=MCP%20servers%20for%20databases&per_directory=1');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=900');
		const body = (await response.json()) as any;
		expect(body.items.filter((item: any) => item.directory.id === 'mcp-servers')).toHaveLength(1);
		expect((await call('/data/search.json')).status).toBe(400);
	});

	it('serves /data/directories.json with live metadata and unavailable directories', async () => {
		const body = (await (await hub().call('/data/directories.json')).json()) as any;
		expect(body).toMatchObject({ version: 1, name: 'Test directories', total: 4 });
		expect(body.unavailable.map((entry: any) => entry.id).sort()).toEqual(['down', 'mismatch', 'old']);
	});

	it('serves llms.txt, the MCP card, the API catalog, OpenAPI and robots.txt', async () => {
		const { call } = hub();
		const llms = await (await call('/llms.txt')).text();
		expect(llms).toMatch(/^# Ever Works directories/);
		expect(llms).toContain('[Awesome Time Tracking](https://timetrack.ever.works/llms.txt)');
		expect(llms).toContain(`${HUB_URL}/mcp`);
		expect(llms).toContain('3 more directories');

		const card = (await (await call('/.well-known/mcp.json')).json()) as any;
		expect(card).toMatchObject({ url: `${HUB_URL}/mcp`, transport: 'streamable-http', authentication: 'none' });
		expect(card.tools).toEqual(['list_directories', 'search_all', 'get_item', 'query_directory']);

		const catalogResponse = await call('/.well-known/api-catalog');
		expect(catalogResponse.headers.get('Content-Type')).toBe('application/linkset+json');
		const catalog = (await catalogResponse.json()) as any;
		expect(catalog.linkset).toHaveLength(5);
		expect(catalog.linkset[0].anchor).toBe(`${HUB_URL}/data/`);

		const openapi = (await (await call('/data/openapi.json')).json()) as any;
		expect(Object.keys(openapi.paths)).toEqual(['/data/search.json', '/data/directories.json', '/mcp']);

		expect(await (await call('/robots.txt')).text()).toBe('User-agent: *\nAllow: /\n');
	});

	it('redirects / to llms.txt, 404s the rest, and answers 503 when the registry is down', async () => {
		const { call, network } = hub();
		const root = await call('/');
		expect(root.status).toBe(302);
		expect(root.headers.get('Location')).toBe('/llms.txt');
		expect((await call('/nothing-here')).status).toBe(404);
		expect((await call('/data/search.json?q=x', { method: 'POST' })).status).toBe(405);
		network.routes.set('https://registry.test/registry.json', () => new Response('nope', { status: 500 }));
		const down = await call('/data/directories.json');
		expect(down.status).toBe(503);
		expect(await down.text()).not.toContain('registry.test');
	});

	it('refuses to start without a registry URL', async () => {
		const response = await worker.fetch(new Request(`${HUB_URL}/llms.txt`), { REGISTRY_URL: '' });
		expect(response.status).toBe(503);
	});
});
