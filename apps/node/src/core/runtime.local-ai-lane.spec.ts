import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike, FetchRequestInit } from './fleet-client';
import { createLogger } from './logger';
import { type NodeLocalAiConfig } from './local-ai/config';
import { setupNodeLocalAi } from './local-ai/setup';
import { createNodeRuntime } from './runtime';
import type { NodeConfig } from './types';

/**
 * Local AI completions — the local-AI lane in the runtime: built only under
 * `--work` with a provider configured and completions on, leasing only
 * `ai-completion` at its own concurrency, never while no provider is up, and
 * advertised as `local-ai-completions` only while it can serve. The work lane
 * never leases the kind. One real round trip: a leased job relayed to a fake
 * llama-swap and completed with the provider's answer.
 */

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const GW = 'http://192.168.1.69:8000';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v26.1.0',
	hasDisplay: false
};
const runner: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: '' }) };

const config = (): NodeConfig => ({
	apiUrl: 'https://api.ever.works',
	nodeId: NODE_ID,
	secret: SECRET,
	kind: 'node',
	name: 'gpu-01',
	capabilities: [],
	heartbeatIntervalMs: 60_000,
	enrolledAt: '2026-11-21T00:00:00.000Z'
});

const nodeFromApi = {
	id: NODE_ID,
	name: 'gpu-01',
	kind: 'node',
	status: 'online',
	platform: 'linux/x64',
	version: '0.3.0',
	capabilities: [],
	lastHeartbeatAt: null,
	createdAt: null,
	persisted: true
};

const GATEWAY: NodeLocalAiConfig = {
	providers: [{ id: 'gpu', kind: 'llama-swap', baseUrl: GW, defaultModel: 'flashnext' }]
};

const ANSWER = {
	id: 'chatcmpl-1',
	object: 'chat.completion',
	created: 1,
	model: 'flashnext',
	choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
	usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
};

function completionJob() {
	return {
		id: 'job-ai-1',
		kind: 'ai-completion',
		status: 'leased',
		nodeId: NODE_ID,
		requiredCapabilities: ['local-ai', 'local-ai-completions', 'local-model:flashnext'],
		payload: {
			api: 'openai-chat',
			model: 'flashnext',
			body: gzipSync(Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }))).toString(
				'base64'
			),
			bodyEncoding: 'gzip-base64',
			timeoutSec: 60
		},
		leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null,
		leaseGeneration: 1
	};
}

/** The platform AND the LAN in one fake: the API answers on api.ever.works, llama-swap on GW. */
function world(options: { providerUp?: boolean; offerJob?: boolean } = {}) {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	let offered = false;
	const fetchFn: FetchLike = async (url: string, init: FetchRequestInit) => {
		const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		calls.push({ url, body });
		const json = (status: number, value: unknown) => ({
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify(value)
		});
		if (url.startsWith(GW)) {
			if (options.providerUp === false) {
				throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
			}
			if (url === `${GW}/v1/models`) return json(200, { data: [{ id: 'flashnext' }] });
			if (url === `${GW}/running`) return json(200, { running: [] });
			if (url === `${GW}/v1/chat/completions`) return json(200, ANSWER);
			return json(404, {});
		}
		if (url.endsWith('/api/fleet/heartbeat')) return json(200, { ok: true, node: nodeFromApi });
		if (url.endsWith('/api/fleet/jobs/lease')) {
			const kinds = body.kinds as string[] | undefined;
			if (options.offerJob && !offered && kinds?.includes('ai-completion')) {
				offered = true;
				return json(200, { jobs: [completionJob()] });
			}
			return json(200, { jobs: [] });
		}
		if (url.includes('/heartbeat')) return json(200, { ok: true, job: completionJob() });
		if (url.endsWith('/complete')) return json(200, { ok: true });
		return json(200, {});
	};
	const logger = createLogger({ sink: () => undefined });
	const io = { fetchFn, runner, environment, logger, version: '0.3.0' };
	const localAi = (stored: NodeLocalAiConfig = GATEWAY, env: Record<string, string> = {}) =>
		setupNodeLocalAi({ stored, env, fetchFn, logger });
	return { calls, io, localAi };
}

const leases = (calls: Array<{ url: string; body: Record<string, unknown> }>) =>
	calls.filter((call) => call.url.endsWith('/api/fleet/jobs/lease')).map((call) => call.body);

describe('the local-AI lane — when it exists', () => {
	it('is built under --work with a provider configured, at the completion concurrency', () => {
		const w = world();
		const runtime = createNodeRuntime(config(), w.io, {
			workerEnabled: true,
			localAi: w.localAi({ ...GATEWAY, completions: { concurrency: 2 } })
		});
		expect(runtime.localAiLane?.worker.registeredKinds).toEqual(['ai-completion']);
		expect(runtime.localAiLane?.concurrency).toBe(2);
	});

	it('is not built without --work, without a provider, or with completions switched off', () => {
		const w = world();
		expect(createNodeRuntime(config(), w.io, { manageEnabled: true, localAi: w.localAi() }).localAiLane).toBe(
			undefined
		);
		expect(createNodeRuntime(config(), w.io, { workerEnabled: true, localAi: null }).localAiLane).toBeUndefined();
		expect(
			createNodeRuntime(config(), w.io, {
				workerEnabled: true,
				localAi: w.localAi({ ...GATEWAY, completions: { enabled: false } })
			}).localAiLane
		).toBeUndefined();
		expect(
			createNodeRuntime(config(), w.io, {
				workerEnabled: true,
				localAi: w.localAi(GATEWAY, { EVER_WORKS_NODE_LOCAL_AI_COMPLETIONS: 'off' })
			}).localAiLane
		).toBeUndefined();
	});
});

describe('the local-AI lane — tags and leases', () => {
	it('advertises local-ai-completions with a healthy provider, and never without the lane', async () => {
		const w = world();
		const serving = createNodeRuntime(config(), w.io, { workerEnabled: true, localAi: w.localAi() });
		await serving.loop.start();
		serving.loop.stop();
		const beat = w.calls.find((call) => call.url.endsWith('/api/fleet/heartbeat'));
		expect(beat?.body.capabilities).toEqual(
			expect.arrayContaining(['local-ai', 'local-ai-completions', 'local-ai:llama-swap', 'local-model:flashnext'])
		);

		const off = world();
		const notServing = createNodeRuntime(config(), off.io, {
			workerEnabled: true,
			localAi: off.localAi({ ...GATEWAY, completions: { enabled: false } })
		});
		await notServing.loop.start();
		notServing.loop.stop();
		const quiet = off.calls.find((call) => call.url.endsWith('/api/fleet/heartbeat'));
		expect(quiet?.body.capabilities).toEqual(expect.arrayContaining(['local-ai']));
		expect(quiet?.body.capabilities).not.toContain('local-ai-completions');
	});

	it('leases only ai-completion at its concurrency, and the work lane never leases it', async () => {
		const w = world();
		const runtime = createNodeRuntime(config(), w.io, {
			workerEnabled: true,
			concurrency: 3,
			localAi: w.localAi({ ...GATEWAY, completions: { concurrency: 2 } })
		});
		await runtime.loop.start();
		runtime.loop.stop();
		await runtime.worker?.start();
		await runtime.localAiLane?.worker.start();
		await runtime.worker?.stop();
		await runtime.localAiLane?.worker.stop();

		const bodies = leases(w.calls);
		const laneLeases = bodies.filter((body) => Array.isArray(body.kinds));
		expect(laneLeases.length).toBeGreaterThan(0);
		for (const body of laneLeases) {
			expect(body.kinds).toEqual(['ai-completion']);
			expect(body.max).toBe(2);
			expect(body.leaseTtlSec).toBe(60);
		}
		const workLeases = bodies.filter((body) => !Array.isArray(body.kinds));
		expect(workLeases.length).toBeGreaterThan(0);
		for (const body of workLeases) expect(body.excludeKinds).toEqual(expect.arrayContaining(['ai-completion']));
	});

	it('leaves the lease request of a node without the lane byte-for-byte as it was (an older platform rejects an unknown kind)', async () => {
		for (const localAi of [null, 'completions-off'] as const) {
			const w = world();
			const runtime = createNodeRuntime(config(), w.io, {
				workerEnabled: true,
				localAi: localAi === null ? null : w.localAi({ ...GATEWAY, completions: { enabled: false } })
			});
			await runtime.worker?.start();
			await runtime.worker?.stop();
			const bodies = leases(w.calls);
			expect(bodies.length).toBeGreaterThan(0);
			for (const body of bodies) {
				expect((body.excludeKinds as string[] | undefined) ?? []).not.toContain('ai-completion');
			}
		}
	});

	it('asks for no completion while no provider is up', async () => {
		const w = world({ providerUp: false });
		const runtime = createNodeRuntime(config(), w.io, { workerEnabled: true, localAi: w.localAi() });
		await runtime.loop.start();
		runtime.loop.stop();
		await runtime.localAiLane?.worker.start();
		await runtime.localAiLane?.worker.stop();

		expect(leases(w.calls).filter((body) => Array.isArray(body.kinds))).toEqual([]);
		expect(runtime.localAiLane?.worker.getState().throttleReason).toMatch(/no local AI provider is up/);
		const beat = w.calls.find((call) => call.url.endsWith('/api/fleet/heartbeat'));
		expect(beat?.body.capabilities).not.toContain('local-ai-completions');
	});
});

describe('the local-AI lane — one completion end to end', () => {
	it('relays a leased job to the provider and completes it with the answer', async () => {
		const w = world({ offerJob: true });
		const runtime = createNodeRuntime(config(), w.io, { workerEnabled: true, localAi: w.localAi() });
		await runtime.loop.start();
		runtime.loop.stop();
		await runtime.localAiLane?.worker.start();
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (w.calls.some((call) => call.url.endsWith('/api/fleet/jobs/job-ai-1/complete'))) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await runtime.localAiLane?.worker.stop();

		expect(w.calls.some((call) => call.url === `${GW}/v1/chat/completions`)).toBe(true);
		const complete = w.calls.find((call) => call.url.endsWith('/api/fleet/jobs/job-ai-1/complete'));
		expect(complete?.body).toMatchObject({
			success: true,
			leaseGeneration: 1,
			result: {
				status: 200,
				providerId: 'gpu',
				providerKind: 'llama-swap',
				model: 'flashnext',
				bodyEncoding: 'gzip-base64',
				costUsd: 0,
				costBasis: 'local',
				usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }
			}
		});
	});
});
