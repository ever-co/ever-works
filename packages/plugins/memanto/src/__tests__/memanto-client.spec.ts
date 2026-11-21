import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	MemantoClient,
	MemantoHttpError,
	resetMemantoSessionCache,
	type MemantoTokenStore
} from '../memanto-client.js';

/**
 * A tiny in-memory model of the Memanto server's auth semantics:
 * management calls need `X-Api-Key`, memory calls need the CURRENT session
 * token of that agent, and every activate rotates the token (invalidating
 * the previous one) — the behaviour the client exists to cope with.
 */
function fakeMemanto(opts: { key?: string } = {}) {
	const key = opts.key ?? 'mgmt-key';
	const agents = new Set<string>();
	const current = new Map<string, string>();
	let seq = 0;
	const calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];

	const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

	const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const method = init?.method ?? 'GET';
		calls.push({ method, path: url.pathname, headers, body });

		if (url.pathname === '/health')
			return json(200, { status: 'healthy', version: '0.3.0', moorcheh_connected: true });

		const mgmtOk = headers['X-Api-Key'] === key;
		if (url.pathname === '/api/v2/agents' && method === 'POST') {
			if (!mgmtOk) return json(401, { detail: 'Unauthorized.' });
			if (agents.has(body.agent_id)) {
				return json(409, { detail: { error: 'AgentAlreadyExists', message: 'exists', details: {} } });
			}
			agents.add(body.agent_id);
			return json(201, { agent_id: body.agent_id });
		}
		if (url.pathname === '/api/v2/agents' && method === 'GET') {
			return mgmtOk ? json(200, { agents: [], count: 0 }) : json(401, { detail: 'Unauthorized.' });
		}
		const m = /^\/api\/v2\/agents\/([^/]+)\/(.+)$/.exec(url.pathname);
		if (!m) return json(404, { detail: 'Not Found' });
		const [, agentId, rest] = m;
		if (rest === 'activate') {
			if (!mgmtOk) return json(401, { detail: 'Unauthorized.' });
			if (!agents.has(agentId)) {
				return json(404, {
					detail: { error: 'AgentNotFound', message: `Agent '${agentId}' not found`, details: {} }
				});
			}
			const token = `tok-${agentId}-${++seq}`;
			current.set(agentId, token);
			return json(200, { session_id: `s${seq}`, session_token: token, agent_id: agentId });
		}
		const tok = headers['X-Session-Token'];
		if (!tok || current.get(agentId) !== tok) {
			return json(401, {
				detail: { error: 'InvalidSessionToken', message: 'Session is no longer active', details: {} }
			});
		}
		if (rest === 'remember') return json(200, { memory_id: `mem-${++seq}`, status: 'queued', type: 'fact' });
		if (rest === 'recall') return json(200, { memories: [], count: 0 });
		if (rest.startsWith('memories/') && method === 'DELETE') return json(200, { status: 'deleted' });
		return json(404, { detail: 'Not Found' });
	});

	return {
		fetchImpl: fetchImpl as unknown as typeof fetch,
		calls,
		agents,
		/** Simulate another replica activating (rotates the token). */
		rotate(agentId: string) {
			current.set(agentId, `tok-${agentId}-${++seq}-elsewhere`);
			return current.get(agentId)!;
		}
	};
}

function memoryStore(): MemantoTokenStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		get: async (k) => data.get(k),
		set: async (k, v) => {
			data.set(k, v);
		},
		delete: async (k) => {
			data.delete(k);
		}
	};
}

describe('MemantoClient', () => {
	beforeEach(() => resetMemantoSessionCache());

	it('auto-creates the agent on first use, activates once, then reuses the token', async () => {
		const server = fakeMemanto();
		const client = new MemantoClient({
			baseUrl: 'http://memanto:8000',
			apiKey: 'mgmt-key',
			fetchImpl: server.fetchImpl
		});

		await client.remember('ever-works-w1', { content: 'one' });
		await client.remember('ever-works-w1', { content: 'two' });

		const paths = server.calls.map((c) => `${c.method} ${c.path}`);
		expect(paths).toEqual([
			'POST /api/v2/agents/ever-works-w1/activate',
			'POST /api/v2/agents',
			'POST /api/v2/agents/ever-works-w1/activate',
			'POST /api/v2/agents/ever-works-w1/remember',
			'POST /api/v2/agents/ever-works-w1/remember'
		]);
		expect(server.calls[1].body).toMatchObject({ agent_id: 'ever-works-w1', pattern: 'project' });
		// Memory calls carry the session token; the management key rides along for auto-renew.
		expect(server.calls[3].headers['X-Session-Token']).toMatch(/^tok-ever-works-w1-/);
		expect(server.calls[3].headers['X-Memanto-Client']).toBe('ever-works');
	});

	it('never creates an agent on a READ — a project with no memories just recalls nothing', async () => {
		const server = fakeMemanto();
		const client = new MemantoClient({ apiKey: 'mgmt-key', fetchImpl: server.fetchImpl });

		await expect(client.recall('ever-works-new', { query: 'x' })).resolves.toEqual({ memories: [], count: 0 });
		await expect(client.ensureSession('ever-works-new')).resolves.toBeUndefined();
		await expect(client.deleteMemory('ever-works-new', 'm1')).resolves.toBeUndefined();

		expect(server.agents.has('ever-works-new')).toBe(false);
		expect(server.calls.some((c) => c.method === 'POST' && c.path === '/api/v2/agents')).toBe(false);
	});

	it('re-activates once and retries when another replica rotated the session', async () => {
		const server = fakeMemanto();
		server.agents.add('a1');
		const client = new MemantoClient({ apiKey: 'mgmt-key', fetchImpl: server.fetchImpl });
		await client.recall('a1', { query: 'x' });
		server.rotate('a1');

		await expect(client.recall('a1', { query: 'x' })).resolves.toEqual({ memories: [], count: 0 });
		const activates = server.calls.filter((c) => c.path.endsWith('/activate'));
		expect(activates).toHaveLength(2);
	});

	it('adopts a newer token another replica put in the shared store instead of rotating it out', async () => {
		const server = fakeMemanto();
		server.agents.add('a1');
		const store = memoryStore();
		const client = new MemantoClient({ apiKey: 'mgmt-key', fetchImpl: server.fetchImpl, tokenStore: store });
		await client.recall('a1', { query: 'x' });

		// Replica B activates and publishes its token to the shared cache.
		const fresh = server.rotate('a1');
		const [key] = [...store.data.keys()];
		store.data.set(key, fresh);

		await client.recall('a1', { query: 'x' });
		expect(server.calls.filter((c) => c.path.endsWith('/activate'))).toHaveLength(1);
		expect(server.calls.at(-1)?.headers['X-Session-Token']).toBe(fresh);
	});

	it('never puts the credential in the shared-store key', async () => {
		const server = fakeMemanto();
		server.agents.add('a1');
		const store = memoryStore();
		const client = new MemantoClient({ apiKey: 'mgmt-key', fetchImpl: server.fetchImpl, tokenStore: store });
		await client.recall('a1', { query: 'x' });
		const [key] = [...store.data.keys()];
		expect(key).toMatch(/^memanto-session:[0-9a-f]{32}$/);
		expect(key).not.toContain('mgmt-key');
	});

	it('deduplicates concurrent activations for one agent', async () => {
		const server = fakeMemanto();
		server.agents.add('a1');
		const client = new MemantoClient({ apiKey: 'mgmt-key', fetchImpl: server.fetchImpl });
		await Promise.all([client.recall('a1', { query: 'x' }), client.recall('a1', { query: 'y' })]);
		expect(server.calls.filter((c) => c.path.endsWith('/activate'))).toHaveLength(1);
	});

	it('explains a wrong management key instead of retrying forever', async () => {
		const server = fakeMemanto();
		server.agents.add('a1');
		const client = new MemantoClient({ apiKey: 'wrong', fetchImpl: server.fetchImpl });
		const err = await client.recall('a1', { query: 'x' }).catch((e) => e);
		expect(err).toBeInstanceOf(MemantoHttpError);
		expect(err.status).toBe(401);
		expect(err.message).toContain('MOORCHEH_API_KEY');
		expect(server.calls).toHaveLength(1);
	});

	it('keeps the Memanto error code and never leaks the base URL host', async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						detail: { error: 'MemoryOperationError', message: 'Failed to store memory: boom' }
					}),
					{
						status: 500
					}
				)
		) as unknown as typeof fetch;
		const client = new MemantoClient({ baseUrl: 'http://internal-host.svc:8000', fetchImpl });
		const err = await client.health().catch((e) => e);
		expect(err.code).toBe('MemoryOperationError');
		expect(err.message).toContain('Failed to store memory: boom');
		expect(err.message).not.toContain('internal-host');
	});

	it('adopts a rotated token from the X-Session-Token response header', async () => {
		let calls = 0;
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calls++;
			const path = new URL(String(input)).pathname;
			if (path.endsWith('/activate')) {
				return new Response(JSON.stringify({ session_id: 's', session_token: 'old', agent_id: 'a1' }), {
					status: 200
				});
			}
			const sent = (init?.headers as Record<string, string>)['X-Session-Token'];
			return new Response(JSON.stringify({ memories: [], sent }), {
				status: 200,
				headers: { 'x-session-token': 'renewed' }
			});
		}) as unknown as typeof fetch;
		const client = new MemantoClient({ fetchImpl });
		await client.recall('a1', { query: 'x' });
		const second = (await client.recall('a1', { query: 'x' })) as unknown as { sent: string };
		expect(second.sent).toBe('renewed');
		expect(calls).toBe(3);
	});

	it('reports a timeout clearly', async () => {
		const fetchImpl = vi.fn(
			(_: unknown, init?: RequestInit) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener('abort', () =>
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
					);
				})
		) as unknown as typeof fetch;
		const client = new MemantoClient({ fetchImpl, timeoutMs: 20 });
		await expect(client.health()).rejects.toThrow('Memanto request timed out: GET /health');
	});
});
