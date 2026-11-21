import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemantoPlugin } from '../memanto.plugin.js';
import { resetMemantoSessionCache } from '../memanto-client.js';

/**
 * Live contract suite — the real plugin (no mocks) against a REAL Memanto
 * server. Skipped unless `MEMANTO_CONTRACT_URL` is set:
 *
 *   MEMANTO_CONTRACT_URL=http://127.0.0.1:8000 \
 *   MEMANTO_CONTRACT_KEY=<management key> \
 *   pnpm --filter @ever-works/memanto-plugin test
 *
 * Point it at any Memanto >= 0.3.0 (Moorcheh Cloud or on-prem). Every run
 * writes to fresh, uniquely named agents so it never touches real data.
 * What it pins is the WIRE contract the unit tests can only assume:
 * auth headers, auto-create, session rotation, tag round-trip (incl. the
 * ownerUserId IDOR stamp), active-only recall and delete.
 */
const url = process.env.MEMANTO_CONTRACT_URL;
const key = process.env.MEMANTO_CONTRACT_KEY;
const run = url ? describe : describe.skip;

run('Memanto live contract', () => {
	const prefix = `ewct${randomUUID().slice(0, 8)}`;
	const settings = { baseUrl: url, apiKey: key, agentPrefix: prefix };
	let plugin: MemantoPlugin;

	beforeAll(() => {
		resetMemantoSessionCache();
		plugin = new MemantoPlugin();
	});

	it('validates the connection and the management credential', async () => {
		const res = await plugin.validateConnection(settings);
		expect(res.success, res.message).toBe(true);
	});

	it('enforces the management credential off-loopback (Memanto trusts loopback callers by design)', async () => {
		const res = await plugin.validateConnection({ ...settings, apiKey: 'definitely-wrong-key' });
		const host = new URL(url as string).hostname;
		const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
		// memanto/app/routes/auth_deps.py: a loopback peer + loopback Host is
		// granted management access whatever key it presents.
		expect(res.success).toBe(loopback);
	});

	it('saves, recalls (with metadata round-trip), builds context and deletes', async () => {
		const session = await plugin.openSession({ projectId: 'work-a', settings: settings as never });
		const saved = await plugin.saveMemory({
			content: 'Staging deploys go through ArgoCD and never through kubectl apply.',
			tags: ['deploy', 'Release Train'],
			metadata: { ownerUserId: 'user-123', runId: 'run-9' },
			sessionId: session.id,
			projectId: 'work-a',
			settings: settings as never
		});
		expect(saved.id).toMatch(new RegExp(`^${prefix}-work-a:`));

		const found = await plugin.searchMemory({
			query: 'how do staging deploys work',
			projectId: 'work-a',
			settings: settings as never
		});
		const hit = found.results.find((r) => r.id === saved.id);
		expect(hit, JSON.stringify(found.results)).toBeDefined();
		expect(hit?.tags).toEqual(['deploy', 'Release-Train']);
		expect(hit?.sessionId).toBe(session.id);
		expect(hit?.metadata).toMatchObject({ ownerUserId: 'user-123', runId: 'run-9' });

		const byTag = await plugin.searchMemory({
			query: 'deploys',
			tags: ['Release Train'],
			projectId: 'work-a',
			settings: settings as never
		});
		expect(byTag.results.map((r) => r.id)).toContain(saved.id);

		// The API's delete ownership probe: wildcard query, newest first.
		const probe = await plugin.searchMemory({
			query: '*',
			limit: 100,
			projectId: 'work-a',
			settings: settings as never
		});
		expect(probe.results.map((r) => r.id)).toContain(saved.id);

		const ctx = await plugin.buildContext({
			query: 'staging deploy',
			projectId: 'work-a',
			settings: settings as never
		});
		expect(ctx.content).toContain('ArgoCD');

		await plugin.deleteEntry(saved.id, settings as never);
		const after = await plugin.searchMemory({
			query: 'staging deploys',
			projectId: 'work-a',
			settings: settings as never
		});
		expect(after.results.map((r) => r.id)).not.toContain(saved.id);
		// Forgetting twice is not an error.
		await expect(plugin.deleteEntry(saved.id, settings as never)).resolves.toBeUndefined();
		await plugin.closeSession(session.id, settings as never);
	});

	it('keeps Works apart — per-Work agents and a pinned shared agent', async () => {
		await plugin.saveMemory({
			content: 'Work B uses Postgres 18.',
			projectId: 'work-b',
			settings: settings as never
		});
		const fromC = await plugin.searchMemory({
			query: 'Postgres',
			projectId: 'work-c',
			settings: settings as never
		});
		expect(fromC.results).toHaveLength(0);

		const shared = { ...settings, agentId: `${prefix}-shared` };
		await plugin.saveMemory({
			content: 'Shared agent: Work D runs Valkey.',
			projectId: 'work-d',
			settings: shared as never
		});
		const fromE = await plugin.searchMemory({ query: 'Valkey', projectId: 'work-e', settings: shared as never });
		expect(fromE.results).toHaveLength(0);
		const fromD = await plugin.searchMemory({ query: 'Valkey', projectId: 'work-d', settings: shared as never });
		expect(fromD.results.length).toBeGreaterThan(0);
	});

	it('recovers when another process rotates the agent session', async () => {
		await plugin.saveMemory({
			content: 'Rotation check memory.',
			projectId: 'work-f',
			settings: settings as never
		});
		// Simulate another replica: activate the same Memanto agent directly.
		const res = await fetch(`${url}/api/v2/agents/${prefix}-work-f/activate`, {
			method: 'POST',
			headers: key ? { 'X-Api-Key': key } : {}
		});
		expect(res.ok).toBe(true);
		const found = await plugin.searchMemory({
			query: 'Rotation check',
			projectId: 'work-f',
			settings: settings as never
		});
		expect(found.results.length).toBeGreaterThan(0);
	});
});
