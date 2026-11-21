import { describe, expect, it } from 'vitest';
import { resolveLocalAiSettings, type NodeLocalAiConfig } from './config';
import { LocalAiMonitor } from './monitor';
import { defaultLocalAiProviderRegistry } from './registry';
import { readLocalAiApiKey } from './secrets';
import { setupNodeLocalAi } from './setup';
import { capturingLogger, fakeFetch, type FakeRoute } from './local-ai-test-kit';
import type { LocalAiSettings } from './types';

/**
 * The monitor: probes that are bounded, cached and shared, a key that never
 * reaches a log line or an error, and the per-run binding that fails closed.
 */

const KEY = 'sk-llamaswap-THE-SECRET-0123456789';
const GW = 'http://192.168.1.69:8000';

function settings(stored: NodeLocalAiConfig): LocalAiSettings {
	const { settings: resolved } = resolveLocalAiSettings({ stored }, defaultLocalAiProviderRegistry());
	return resolved!;
}

const GATEWAY: NodeLocalAiConfig = {
	providers: [
		{
			id: 'gpu',
			kind: 'llama-swap',
			baseUrl: GW,
			apiKeyFile: '/etc/ever-works-node/local-llm.key',
			defaultModel: 'flashnext'
		}
	],
	agentRuntime: { cli: 'claude-code', provider: 'gpu' }
};

function monitorFor(
	routes: Record<string, FakeRoute>,
	options: { key?: string | null; stored?: NodeLocalAiConfig; now?: () => number; timeoutMs?: number } = {}
) {
	const fetch = fakeFetch(routes);
	const log = capturingLogger();
	const resolved = settings(options.stored ?? GATEWAY);
	const monitor = new LocalAiMonitor({
		settings: { ...resolved, ...(options.timeoutMs ? { probeTimeoutMs: options.timeoutMs } : {}) },
		fetchFn: fetch.fetchFn,
		secrets: {
			readKeyFile: async (path) =>
				path === '/etc/ever-works-node/local-llm.key'
					? options.key === undefined
						? `${KEY}\n`
						: options.key
					: null,
			env: {}
		},
		logger: log.logger,
		...(options.now ? { now: options.now } : {})
	});
	return { monitor, fetch, log };
}

const UP: Record<string, FakeRoute> = {
	[`${GW}/v1/models`]: { body: { data: [{ id: 'flashnext' }] } },
	[`${GW}/running`]: { body: { running: [] } }
};

describe('LocalAiMonitor — probing', () => {
	it('makes no request until something asks', () => {
		const { monitor, fetch } = monitorFor(UP);
		expect(fetch.calls).toHaveLength(0);
		expect(monitor.snapshot()).toMatchObject([{ id: 'gpu', status: 'unknown' }]);
	});

	it('caches an answer for the probe interval and re-probes once it is stale', async () => {
		let now = 1_000_000;
		const { monitor, fetch } = monitorFor(UP, { now: () => now });
		await monitor.current();
		const afterFirst = fetch.calls.length;
		now += 30_000;
		await monitor.current();
		expect(fetch.calls.length).toBe(afterFirst);
		now += 31_000;
		await monitor.current();
		expect(fetch.calls.length).toBe(afterFirst * 2);
	});

	it('shares one probe round between concurrent askers', async () => {
		const { monitor, fetch } = monitorFor(UP);
		await Promise.all([monitor.current(), monitor.current(), monitor.refresh()]);
		expect(fetch.calls.filter((call) => call.url.endsWith('/v1/models'))).toHaveLength(1);
	});

	it('re-probes on an explicit refresh once the round it shared is over, even on a frozen clock', async () => {
		const { monitor, fetch } = monitorFor(UP, { now: () => 5_000 });
		await monitor.refresh();
		await monitor.refresh();
		expect(fetch.calls.filter((call) => call.url.endsWith('/v1/models'))).toHaveLength(2);
	});

	it('calls a provider that never answers down at the probe timeout, without rejecting', async () => {
		const { monitor } = monitorFor({ [`${GW}/v1/models`]: { hang: true } }, { timeoutMs: 50 });
		const [status] = await monitor.refresh();
		expect(status).toMatchObject({ status: 'down', error: expect.stringContaining('timed out') });
	});

	it('logs a change of health once, not every probe', async () => {
		const { monitor, log } = monitorFor(UP);
		await monitor.refresh();
		await monitor.refresh();
		expect(log.entries.filter((entry) => entry.message.includes('is up'))).toHaveLength(1);
	});
});

describe('LocalAiMonitor — the key', () => {
	it('reads the key file at use time, trims it, and sends it only as the Bearer header', async () => {
		const { monitor, fetch } = monitorFor(UP);
		await monitor.refresh();
		expect(fetch.calls[0]!.init.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(fetch.calls[0]!.url).not.toContain(KEY);
	});

	it('is down, naming the PATH, when the key file is missing — and never crashes', async () => {
		const { monitor } = monitorFor(UP, { key: null });
		const [status] = await monitor.refresh();
		expect(status).toMatchObject({
			status: 'down',
			error: 'the API key file /etc/ever-works-node/local-llm.key does not exist'
		});
	});

	it('never puts the key in a log line or an error, even when the server echoes it back', async () => {
		const { monitor, log } = monitorFor({
			[`${GW}/v1/models`]: { status: 401, text: `invalid key ${KEY}` }
		});
		const [status] = await monitor.refresh();
		const binding = await monitor.bindingFor('claude-code');
		const everything = [JSON.stringify(status), JSON.stringify(binding), log.text()].join('\n');
		expect(status!.status).toBe('down');
		expect(everything).not.toContain(KEY);
		// …and the logger now scrubs it from anything else the node writes.
		log.logger.warn(`echo ${KEY}`);
		expect(log.text()).not.toContain(KEY);
	});

	it('refuses an empty key, a multi-line file and an unset env var, by location only', async () => {
		const io = (content: string | null) => ({ readKeyFile: async () => content, env: { SET: 'x' } });
		await expect(readLocalAiApiKey({ source: 'file', path: '/k' }, io(' \n'))).rejects.toThrow(
			'the API key file /k is empty'
		);
		await expect(readLocalAiApiKey({ source: 'file', path: '/k' }, io('one\ntwo'))).rejects.toThrow(
			'must hold only the key'
		);
		await expect(readLocalAiApiKey({ source: 'env', name: 'LLM_KEY' }, io(null))).rejects.toThrow(
			'the environment variable LLM_KEY is not set'
		);
		await expect(readLocalAiApiKey({ source: 'env', name: 'set' }, io(null))).resolves.toBe('x');
		await expect(readLocalAiApiKey(null, io(null))).resolves.toBeNull();
	});
});

describe('LocalAiMonitor — the agent binding', () => {
	it('binds claude-code to the gateway with its default model and the key', async () => {
		const { monitor } = monitorFor(UP);
		expect(await monitor.bindingFor('claude-code')).toEqual({
			kind: 'bound',
			cli: 'claude-code',
			providerId: 'gpu',
			providerKind: 'llama-swap',
			model: 'flashnext',
			smallModel: 'flashnext',
			api: 'anthropic-messages',
			endpoint: GW,
			apiKey: KEY
		});
	});

	it('answers null for a CLI that is not bound — an ordinary cloud run', async () => {
		const { monitor, fetch } = monitorFor(UP);
		expect(await monitor.bindingFor('codex')).toBeNull();
		expect(fetch.calls).toHaveLength(0);
	});

	it('is unavailable — never null — when the provider is down', async () => {
		const { monitor } = monitorFor({ [`${GW}/v1/models`]: { networkError: 'ECONNREFUSED' } });
		expect(await monitor.bindingFor('claude-code')).toEqual({
			kind: 'unavailable',
			cli: 'claude-code',
			providerId: 'gpu',
			reason: 'local AI provider "gpu" is down: /v1/models: connection refused'
		});
	});

	it('is unavailable when the provider does not speak the API the CLI needs', async () => {
		const { monitor } = monitorFor(UP, {
			stored: {
				providers: [
					{
						id: 'gpu',
						kind: 'llama-swap',
						baseUrl: GW,
						apiKeyFile: '/etc/ever-works-node/local-llm.key',
						apis: ['openai-chat']
					}
				],
				agentRuntime: { cli: 'codex', provider: 'gpu', model: 'flashnext' }
			}
		});
		expect(await monitor.bindingFor('codex')).toMatchObject({
			kind: 'unavailable',
			reason: expect.stringContaining('does not speak openai-responses, which codex needs')
		});
	});

	it('is unavailable when the named model is not served, listing what is', async () => {
		const { monitor } = monitorFor(UP, {
			stored: { ...GATEWAY, agentRuntime: { cli: 'claude-code', provider: 'gpu', model: 'qwen-max' } }
		});
		expect(await monitor.bindingFor('claude-code')).toMatchObject({
			kind: 'unavailable',
			reason: 'local AI provider "gpu" does not serve model "qwen-max" (it serves: flashnext)'
		});
	});

	it('binds codex to the Responses API at <root>/v1', async () => {
		const { monitor } = monitorFor(UP, {
			stored: { ...GATEWAY, agentRuntime: { cli: 'codex', provider: 'gpu' } }
		});
		expect(await monitor.bindingFor('codex')).toMatchObject({
			kind: 'bound',
			api: 'openai-responses',
			endpoint: `${GW}/v1`
		});
	});

	it('withholds the CLI tag while it cannot run, and advertises the local-AI tags while it can', async () => {
		const down = monitorFor({ [`${GW}/v1/models`]: { status: 502 } });
		await down.monitor.refresh();
		expect(down.monitor.capabilityFacts()).toEqual({ tags: [], unavailableClis: ['claude-code'] });

		const up = monitorFor(UP);
		await up.monitor.refresh();
		expect(up.monitor.capabilityFacts()).toEqual({
			tags: ['local-ai', 'local-agent:claude-code', 'local-ai:llama-swap', 'local-model:flashnext'],
			unavailableClis: []
		});
	});
});

describe('setupNodeLocalAi', () => {
	it('is a no-op for a node with nothing configured', () => {
		expect(setupNodeLocalAi({ env: {}, fetchFn: fakeFetch({}).fetchFn })).toEqual({
			monitor: null,
			extraCapabilities: [],
			problems: []
		});
	});

	it('merges config and env extra tags and reports the refused ones', () => {
		const setup = setupNodeLocalAi({
			extraCapabilities: ['gpu', 'git-push'],
			env: { EVER_WORKS_NODE_EXTRA_CAPABILITIES: 'gpu:nvidia, gpu ,Bad Tag' },
			fetchFn: fakeFetch({}).fetchFn
		});
		expect(setup.monitor).toBeNull();
		expect(setup.extraCapabilities).toEqual(['gpu', 'gpu:nvidia']);
		expect(setup.problems).toHaveLength(2);
	});
});
