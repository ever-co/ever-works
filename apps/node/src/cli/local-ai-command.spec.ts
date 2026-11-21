import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../core/capabilities';
import type { ConfigFileSystem } from '../core/config-store';
import type { FetchLike } from '../core/fleet-client';
import { createLogger, type LogEntry } from '../core/logger';
import { fakeFetch, type FakeRoute } from '../core/local-ai/local-ai-test-kit';
import { EXIT_FAILURE, EXIT_OK, runCli, type CliDeps } from './program';

/**
 * `ever-works-node local-ai list | probe | test`, and the local-AI lines of
 * `capabilities` / `status` — through `runCli`, so the command wiring is what
 * is tested. Keys are never printed: only where each one is read from.
 */

const CONFIG_PATH = '/etc/ever-works-node/node-config.json';
const KEY_PATH = '/etc/ever-works-node/local-llm.key';
const KEY = 'sk-llamaswap-NEVER-PRINT-ME-0123456789';
const GW = 'http://192.168.1.69:8000';

const config = {
	apiUrl: 'https://api.ever.works',
	nodeId: '11111111-2222-4333-8444-555555555555',
	secret: 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM',
	kind: 'node',
	capabilities: [],
	heartbeatIntervalMs: 30_000,
	enrolledAt: '2026-11-21T00:00:00.000Z',
	localAi: {
		providers: [{ id: 'gpu', kind: 'llama-swap', baseUrl: GW, apiKeyFile: KEY_PATH, defaultModel: 'flashnext' }],
		agentRuntime: { cli: 'claude-code', provider: 'gpu' }
	},
	extraCapabilities: ['gpu', 'gpu:nvidia']
};

const UP: Record<string, FakeRoute> = {
	[`${GW}/v1/models`]: { body: { data: [{ id: 'flashnext' }] } },
	[`${GW}/running`]: { body: { running: [{ model: 'flashnext', state: 'ready' }] } }
};

const runner: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: '' }) };

function harness(options: { routes?: Record<string, FakeRoute>; stored?: unknown; env?: Record<string, string> } = {}) {
	const files = new Map<string, string>([[CONFIG_PATH, JSON.stringify(options.stored ?? config)]]);
	const stdout: string[] = [];
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	const fetch = fakeFetch(options.routes ?? UP);
	const fs: ConfigFileSystem = {
		readFile: async (path) => files.get(path) ?? null,
		writeFile: async (path, content) => void files.set(path, content),
		mkdir: async () => undefined,
		chmod: async () => undefined,
		dirname: (path) => path.replace(/\/[^/]*$/, '')
	};
	const deps: CliDeps = {
		io: {
			fetchFn: fetch.fetchFn as FetchLike,
			runner,
			environment: {
				platform: 'linux',
				arch: 'x64',
				nodeVersion: 'v26.1.0',
				hasDisplay: false,
				modelCli: { 'claude-code': '/usr/local/bin/claude' }
			},
			logger,
			version: '0.2.13'
		},
		fs,
		configPath: CONFIG_PATH,
		platform: 'linux',
		out: (line) => stdout.push(line),
		env: options.env ?? {},
		readLocalAiKeyFile: async (path) => (path === KEY_PATH ? KEY : null)
	};
	const everything = (): string => [...stdout, ...entries.map((entry) => entry.message)].join('\n');
	return { deps, stdout, entries, fetch, everything };
}

describe('ever-works-node local-ai list', () => {
	it('prints the providers, the binding and the extra tags without touching the network', async () => {
		const h = harness();
		expect(await runCli(['local-ai', 'list'], h.deps)).toBe(EXIT_OK);
		expect(h.stdout).toEqual([
			'provider     gpu (llama-swap)',
			`  address    ${GW}`,
			`  key        file ${KEY_PATH}`,
			'  apis       openai-chat, openai-responses, anthropic-messages (the kind’s defaults)',
			'  model      flashnext',
			'agent        claude-code runs on provider gpu',
			'extra tags   gpu, gpu:nvidia'
		]);
		expect(h.fetch.calls).toHaveLength(0);
		expect(h.everything()).not.toContain(KEY);
	});

	it('emits JSON with the known kinds and the problems', async () => {
		const h = harness({
			stored: { ...config, localAi: { providers: [{ kind: 'koboldcpp', baseUrl: 'http://x:1' }] } }
		});
		expect(await runCli(['local-ai', 'list', '--json'], h.deps)).toBe(EXIT_OK);
		const report = JSON.parse(h.stdout.join('\n')) as {
			kinds: Array<{ kind: string }>;
			providers: unknown[];
			problems: string[];
		};
		expect(report.kinds.map((kind) => kind.kind)).toEqual([
			'openai-compatible',
			'llama-swap',
			'ollama',
			'lm-studio',
			'vllm'
		]);
		expect(report.providers).toEqual([]);
		expect(report.problems[0]).toContain('unknown kind "koboldcpp"');
	});

	it('says how to configure it on a machine with none', async () => {
		const h = harness({ stored: { ...config, localAi: undefined } });
		expect(await runCli(['local-ai', 'list'], h.deps)).toBe(EXIT_OK);
		expect(h.stdout[0]).toBe('No local AI is configured on this machine.');
	});

	it('reads the environment shorthand', async () => {
		const h = harness({
			stored: { ...config, localAi: undefined },
			env: {
				EVER_WORKS_NODE_LOCAL_AI_KIND: 'ollama',
				EVER_WORKS_NODE_LOCAL_AI_AGENT_CLI: 'codex',
				EVER_WORKS_NODE_LOCAL_AI_MODEL: 'qwen3:8b'
			}
		});
		await runCli(['local-ai', 'list'], h.deps);
		expect(h.stdout).toContain('provider     ollama (ollama)');
		expect(h.stdout).toContain('agent        codex runs on provider ollama, model qwen3:8b');
	});
});

describe('ever-works-node local-ai probe', () => {
	it('reports health, the binding and the tags this node would advertise', async () => {
		const h = harness();
		expect(await runCli(['local-ai', 'probe'], h.deps)).toBe(EXIT_OK);
		expect(h.stdout[0]).toMatch(/^gpu\s+llama-swap\s+up in \d+ ms — 1 model\(s\): flashnext \(loaded\)$/);
		expect(h.stdout).toContain(
			`agent        claude-code: READY — model flashnext over anthropic-messages at ${GW}`
		);
		expect(h.stdout).toContain(
			'tags         local-ai, local-agent:claude-code, local-ai:llama-swap, local-model:flashnext'
		);
		expect(h.everything()).not.toContain(KEY);
	});

	it('exits 1, saying why, when the provider is down', async () => {
		const h = harness({ routes: { [`${GW}/v1/models`]: { networkError: 'ECONNREFUSED' } } });
		expect(await runCli(['local-ai', 'probe'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.stdout[0]).toContain('DOWN — /v1/models: connection refused');
		expect(h.stdout).toContain('withheld     claude-code (bound to local AI that cannot serve it now)');
		expect(h.entries.at(-1)!.message).toContain('local AI provider(s) down: gpu');
	});
});

describe('ever-works-node local-ai test', () => {
	const chat = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
	const responses = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] };
	const messages = { content: [{ type: 'text', text: 'ok' }] };

	it('sends one small request per API with the key, and reports each', async () => {
		const h = harness({
			routes: {
				...UP,
				[`POST ${GW}/v1/chat/completions`]: { body: chat },
				[`POST ${GW}/v1/responses`]: { body: responses },
				[`POST ${GW}/v1/messages`]: { body: messages }
			}
		});
		expect(await runCli(['local-ai', 'test'], h.deps)).toBe(EXIT_OK);
		expect(h.stdout.slice(1).map((line) => line.replace(/ \d+ ms/, ' N ms'))).toEqual([
			'openai-chat          OK   N ms — answered: ok',
			'openai-responses     OK   N ms — answered: ok',
			'anthropic-messages   OK   N ms — answered: ok'
		]);
		const posts = h.fetch.calls.filter((call) => call.init.method === 'POST');
		expect(posts.map((call) => JSON.parse(call.init.body).model)).toEqual(['flashnext', 'flashnext', 'flashnext']);
		expect(posts.every((call) => call.init.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
		expect(posts[2]!.init.headers['anthropic-version']).toBe('2023-06-01');
		expect(h.everything()).not.toContain(KEY);
	});

	it('exits 1 naming the API that does not work, and tests one API on request', async () => {
		const h = harness({ routes: { ...UP, [`POST ${GW}/v1/responses`]: { status: 404 } } });
		expect(await runCli(['local-ai', 'test', '--api', 'openai-responses'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.stdout.at(-1)).toMatch(/^openai-responses\s+FAIL \d+ ms — POST \/v1\/responses: HTTP 404$/);
		expect(h.entries.at(-1)!.message).toBe('gpu: openai-responses did not answer correctly');
	});

	it('refuses an unknown API and an unknown provider', async () => {
		const h = harness();
		expect(await runCli(['local-ai', 'test', '--api', 'grpc'], h.deps)).toBe(EXIT_FAILURE);
		expect(await runCli(['local-ai', 'test', '--provider', 'nope'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.entries.map((entry) => entry.message).join('\n')).toContain('No local AI provider "nope"');
	});
});

describe('capabilities and status with local AI', () => {
	it('`capabilities` prints the local-AI and extra tags the running node would advertise', async () => {
		const h = harness();
		expect(await runCli(['capabilities'], h.deps)).toBe(EXIT_OK);
		const tags = h.stdout.find((line) => line.startsWith('capabilities '))!;
		expect(tags).toContain('claude-code');
		expect(tags).toContain(
			'local-ai, local-agent:claude-code, local-ai:llama-swap, local-model:flashnext, gpu, gpu:nvidia'
		);
		expect(h.stdout).toContain('local ai     gpu (llama-swap) up');
	});

	it('`capabilities` withholds claude-code while its local provider is down', async () => {
		const h = harness({ routes: { [`${GW}/v1/models`]: { status: 503 } } });
		await runCli(['capabilities'], h.deps);
		const tags = h.stdout.find((line) => line.startsWith('capabilities '))!;
		expect(tags).not.toContain('claude-code');
		expect(tags).toContain('gpu, gpu:nvidia');
	});

	it('`status` names the providers and the bound CLI, without probing', async () => {
		const h = harness();
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.stdout).toContain('local ai     gpu (llama-swap); runs claude-code locally');
		expect(h.fetch.calls).toHaveLength(0);
	});
});
