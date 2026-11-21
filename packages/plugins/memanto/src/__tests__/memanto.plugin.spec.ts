import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';
import { MemantoPlugin } from '../memanto.plugin.js';

const client = {
	health: vi.fn(),
	listAgents: vi.fn(),
	ensureSession: vi.fn(),
	remember: vi.fn(),
	recall: vi.fn(),
	recallRecent: vi.fn(),
	recallAll: vi.fn(),
	deleteMemory: vi.fn()
};
const ctorArgs: unknown[] = [];

vi.mock('../memanto-client.js', () => ({
	MemantoClient: vi.fn().mockImplementation(function (opts: unknown) {
		ctorArgs.push(opts);
		return client;
	})
}));

function createContext(): PluginContext {
	return {
		pluginId: 'memanto',
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn(), clear: vi.fn() }
	} as unknown as PluginContext;
}

const ITEM = {
	id: 'm1',
	title: 'Deploys',
	content: 'Staging deploys go through ArgoCD.',
	type: 'instruction',
	confidence: 0.8,
	status: 'active',
	tags: ['deploy', 'ew:ownerUserId=u-1', 'ew.session.ews_1'],
	created_at: '2026-11-21T03:17:24+00:00',
	score: 0.4
};

describe('MemantoPlugin', () => {
	let plugin: MemantoPlugin;

	beforeEach(async () => {
		vi.clearAllMocks();
		ctorArgs.length = 0;
		for (const k of ['MEMANTO_BASE_URL', 'MEMANTO_API_KEY', 'MEMANTO_AGENT_PREFIX', 'MEMANTO_AGENT_ID'])
			delete process.env[k];
		plugin = new MemantoPlugin();
		await plugin.onLoad(createContext());
		client.remember.mockResolvedValue({ memory_id: 'm-new', type: 'decision', status: 'queued' });
		client.recall.mockResolvedValue({ memories: [ITEM], count: 1 });
		client.recallRecent.mockResolvedValue({ memories: [ITEM], count: 1 });
		client.recallAll.mockResolvedValue({ memories: [ITEM], count: 1 });
	});

	describe('manifest', () => {
		it('implements agent-memory and is THE default provider for it, without auto-enabling', () => {
			expect(plugin.id).toBe('memanto');
			expect(plugin.providerName).toBe('memanto');
			expect(plugin.capabilities).toContain('agent-memory');
			const manifest = plugin.getManifest();
			expect(manifest.defaultForCapabilities).toEqual(['agent-memory']);
			expect(manifest.autoEnable).toBe(false);
			expect(manifest.builtIn).toBe(true);
		});

		it('keeps the key secret and settable from the UI (no x-envVar lock)', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.apiKey['x-secret']).toBe(true);
			expect(props.apiKey['x-envVar']).toBeUndefined();
			expect(props.agentId['x-scope']).toBe('work');
		});

		it('declares no schema default on env-backed fields, so MEMANTO_* env vars are not shadowed', () => {
			// The settings service resolves an unset field to its schema default
			// (plugin-settings.service), which would win over the env fallback.
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			for (const key of ['baseUrl', 'apiKey', 'agentPrefix', 'agentId']) {
				expect(props[key].default, key).toBeUndefined();
			}
		});
	});

	describe('validateSettings', () => {
		it('accepts a normal config', async () => {
			await expect(
				plugin.validateSettings({
					baseUrl: 'http://memanto.ever-works.svc:8000',
					agentPrefix: 'acme',
					minSimilarity: 0.2
				})
			).resolves.toEqual({ valid: true });
		});

		it('rejects the cloud metadata service (SSRF), bad ids and out-of-range numbers', async () => {
			const res = await plugin.validateSettings({
				baseUrl: 'http://169.254.169.254/latest',
				agentId: 'has spaces',
				minSimilarity: 3,
				timeoutMs: 5
			});
			expect(res.valid).toBe(false);
			expect(res.errors?.map((e) => e.path).sort()).toEqual(['agentId', 'baseUrl', 'minSimilarity', 'timeoutMs']);
		});

		it('refuses to build a client for a metadata host even when validation was skipped', async () => {
			await expect(
				plugin.searchMemory({ query: 'x', settings: { baseUrl: 'http://metadata.google.internal/' } as never })
			).rejects.toThrow('SSRF');
		});
	});

	describe('validateConnection', () => {
		it('checks health AND the management credential', async () => {
			client.health.mockResolvedValue({ status: 'healthy', version: '0.3.0', moorcheh_connected: true });
			client.listAgents.mockResolvedValue({ agents: [] });
			const res = await plugin.validateConnection({ baseUrl: 'http://m:8000', apiKey: 'k' });
			expect(res).toEqual({ success: true, message: 'Connected to Memanto 0.3.0 at http://m:8000.' });
			expect(client.listAgents).toHaveBeenCalled();
		});

		it('says when Memanto cannot reach Moorcheh', async () => {
			client.health.mockResolvedValue({ status: 'unhealthy', moorcheh_connected: false });
			const res = await plugin.validateConnection({});
			expect(res.success).toBe(false);
			expect(res.message).toContain('cannot reach its Moorcheh backend');
		});

		it('surfaces a rejected credential', async () => {
			client.health.mockResolvedValue({ status: 'healthy' });
			client.listAgents.mockRejectedValue(new Error('Memanto rejected the management credential'));
			const res = await plugin.validateConnection({ apiKey: 'bad' });
			expect(res).toEqual({ success: false, message: 'Memanto rejected the management credential' });
		});
	});

	describe('settings resolution', () => {
		it('falls back to MEMANTO_* env vars and shares the plugin cache as the token store', async () => {
			process.env.MEMANTO_BASE_URL = 'http://env-memanto:8000';
			process.env.MEMANTO_API_KEY = 'env-key';
			await plugin.searchMemory({ query: 'x' });
			expect(ctorArgs[0]).toMatchObject({ baseUrl: 'http://env-memanto:8000', apiKey: 'env-key' });
			expect((ctorArgs[0] as { tokenStore?: unknown }).tokenStore).toBeDefined();
		});

		it('accepts the scoped { admin, user, work } shape', async () => {
			await plugin.searchMemory({
				query: 'x',
				settings: { admin: { baseUrl: 'http://a:8000' }, user: { apiKey: 'u' }, work: {} } as never
			});
			expect(ctorArgs[0]).toMatchObject({ baseUrl: 'http://a:8000', apiKey: 'u' });
		});
	});

	describe('sessions', () => {
		it('opens an Ever Works-side session and warms the Work agent', async () => {
			const session = await plugin.openSession({ projectId: 'w1', metadata: { runId: 'r1' } });
			expect(session.id).toMatch(/^ews_[0-9a-f]{32}$/);
			expect(session.metadata).toEqual({ runId: 'r1' });
			expect(client.ensureSession).toHaveBeenCalledWith('ever-works-w1');
		});

		it('closes idempotently without a server call', async () => {
			await expect(plugin.closeSession('ews_1')).resolves.toBeUndefined();
			await expect(plugin.closeSession('ews_1')).resolves.toBeUndefined();
		});
	});

	describe('saveMemory', () => {
		it('writes to the per-Work agent with tags carrying session + owner stamp', async () => {
			const record = await plugin.saveMemory({
				content: '  We ship on Tuesdays.  ',
				tags: ['release', 'Release Train'],
				metadata: { ownerUserId: 'u-1', memoryType: 'decision', confidence: 0.9 },
				sessionId: 'ews_1',
				projectId: 'w1'
			});
			const [agentId, body] = client.remember.mock.calls[0];
			expect(agentId).toBe('ever-works-w1');
			expect(body).toEqual({
				content: 'We ship on Tuesdays.',
				tags: ['ew.session.ews_1', 'ew:ownerUserId=u-1', 'release', 'Release-Train'],
				source: 'ever-works',
				type: 'decision',
				confidence: 0.9
			});
			expect(record).toMatchObject({
				id: 'ever-works-w1:m-new',
				content: 'We ship on Tuesdays.',
				tags: ['release', 'Release-Train'],
				sessionId: 'ews_1',
				projectId: 'w1'
			});
			expect(record.metadata).toMatchObject({ ownerUserId: 'u-1', memoryType: 'decision' });
		});

		it('clamps content to Memanto’s 10,000-char limit', async () => {
			await plugin.saveMemory({ content: 'x'.repeat(12_000) });
			expect((client.remember.mock.calls[0][1] as { content: string }).content).toHaveLength(10_000);
		});

		it('uses one pinned agent + a project tag when agentId is set', async () => {
			await plugin.saveMemory({ content: 'fact', projectId: 'w1', settings: { agentId: 'shared' } as never });
			const [agentId, body] = client.remember.mock.calls[0];
			expect(agentId).toBe('shared');
			expect((body as { tags: string[] }).tags).toContain('ew.project.w1');
		});

		it('rejects empty content', async () => {
			await expect(plugin.saveMemory({ content: '   ' })).rejects.toThrow('content is empty');
		});
	});

	describe('searchMemory', () => {
		it('runs active-only semantic recall and decodes records', async () => {
			const res = await plugin.searchMemory({
				query: 'deploy staging',
				limit: 5,
				tags: ['deploy'],
				projectId: 'w1'
			});
			expect(client.recall).toHaveBeenCalledWith('ever-works-w1', {
				query: 'deploy staging',
				limit: 5,
				status: 'active',
				tags: ['deploy']
			});
			expect(res.results[0]).toMatchObject({
				id: 'ever-works-w1:m1',
				tags: ['deploy'],
				sessionId: 'ews_1',
				score: 0.4,
				metadata: { ownerUserId: 'u-1', memoryType: 'instruction' }
			});
		});

		it('answers a wildcard / blank query newest-first (the API delete ownership probe uses "*")', async () => {
			await plugin.searchMemory({ query: '*', limit: 100 });
			expect(client.recall).not.toHaveBeenCalled();
			expect(client.recallRecent).toHaveBeenCalledWith('ever-works', { limit: 100, status: 'active' });
		});

		it('filters by project tag on a pinned agent and applies minSimilarity', async () => {
			await plugin.searchMemory({
				query: 'x',
				projectId: 'w1',
				settings: { agentId: 'shared', minSimilarity: 0.3 } as never
			});
			expect(client.recall).toHaveBeenCalledWith('shared', {
				query: 'x',
				limit: 10,
				status: 'active',
				tags: ['ew.project.w1'],
				min_similarity: 0.3
			});
		});

		it('clamps limit and query length to Memanto’s cost guards', async () => {
			await plugin.searchMemory({ query: 'q'.repeat(5000), limit: 1000 });
			const body = client.recall.mock.calls[0][1] as { query: string; limit: number };
			expect(body.limit).toBe(100);
			expect(body.query.length).toBe(1000);
		});
	});

	describe('buildContext', () => {
		it('packs semantic recall into the token budget with references', async () => {
			const ctx = await plugin.buildContext({ query: 'deploy', projectId: 'w1', maxTokens: 500 });
			expect(client.recall).toHaveBeenCalledWith('ever-works-w1', {
				limit: 30,
				status: 'active',
				query: 'deploy'
			});
			expect(ctx.content).toBe('- [instruction] Staging deploys go through ArgoCD.');
			expect(ctx.approxTokens).toBe(Math.ceil(ctx.content.length / 4));
			expect(ctx.references?.[0].id).toBe('ever-works-w1:m1');
		});

		it('falls back to the most recent memories without a query', async () => {
			await plugin.buildContext({ projectId: 'w1' });
			expect(client.recallRecent).toHaveBeenCalledWith('ever-works-w1', { limit: 30, status: 'active' });
		});

		it('returns empty content (loud-empty is the caller’s job) when nothing is stored', async () => {
			client.recall.mockResolvedValue({ memories: [] });
			const ctx = await plugin.buildContext({ query: 'x' });
			expect(ctx).toEqual({ content: '', approxTokens: 0, references: [] });
		});
	});

	describe('governance', () => {
		it('deletes by composite id in the right agent', async () => {
			await plugin.deleteEntry('ever-works-w1:m1');
			expect(client.deleteMemory).toHaveBeenCalledWith('ever-works-w1', 'm1');
		});

		it('falls back to the scope agent for a bare id', async () => {
			await plugin.deleteEntry('m1', { agentPrefix: 'acme' } as never);
			expect(client.deleteMemory).toHaveBeenCalledWith('acme', 'm1');
		});

		it('requires an id', async () => {
			await expect(plugin.deleteEntry('')).rejects.toThrow('missing id');
		});

		it('exports every memory of the scope agent', async () => {
			const out = (await plugin.exportAll()) as { memories: unknown[]; agentId: string };
			expect(out.agentId).toBe('ever-works');
			expect(out.memories).toHaveLength(1);
		});

		it('does not offer listSessions (Memanto has no work-session list)', () => {
			expect((plugin as { listSessions?: unknown }).listSessions).toBeUndefined();
		});
	});
});
