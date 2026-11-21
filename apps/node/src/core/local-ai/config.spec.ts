import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config-store';
import { redactConfig } from '../types';
import {
	LOCAL_AI_ENV,
	normalizeLocalAiBaseUrl,
	readLocalAiEnv,
	resolveLocalAiSettings,
	sanitizeStoredLocalAiConfig,
	type NodeLocalAiConfig
} from './config';
import { defaultLocalAiProviderRegistry } from './registry';

/**
 * Local AI configuration: the stored `localAi` section, the env shorthand,
 * and the validation between them. Nothing here throws on operator input —
 * a bad entry is dropped with a problem line — and an agent runtime whose
 * provider is invalid is KEPT so the binding fails closed.
 */

const registry = defaultLocalAiProviderRegistry();
const resolve = (stored: NodeLocalAiConfig | null, env: Record<string, string> = {}) =>
	resolveLocalAiSettings({ stored, env }, registry);

/** The owner's real setup: llama-swap on the GPU PC, Bearer key in a file, Claude Code bound to it. */
const LLAMA_SWAP: NodeLocalAiConfig = {
	providers: [
		{
			id: 'gpu',
			kind: 'llama-swap',
			baseUrl: 'http://192.168.1.69:8000',
			apiKeyFile: '/etc/ever-works-node/local-llm.key',
			defaultModel: 'flashnext'
		}
	],
	agentRuntime: { cli: 'claude-code', provider: 'gpu', model: 'flashnext' }
};

describe('resolveLocalAiSettings', () => {
	it('resolves the llama-swap gateway setup with no problems', () => {
		const { settings, problems } = resolve(LLAMA_SWAP);
		expect(problems).toEqual([]);
		expect(settings).toEqual({
			providers: [
				{
					id: 'gpu',
					kind: 'llama-swap',
					baseUrl: 'http://192.168.1.69:8000',
					apiKey: { source: 'file', path: '/etc/ever-works-node/local-llm.key' },
					models: [],
					defaultModel: 'flashnext',
					apis: ['openai-chat', 'openai-responses', 'anthropic-messages'],
					apisDeclared: false
				}
			],
			agentRuntimes: [{ cli: 'claude-code', provider: 'gpu', model: 'flashnext', smallModel: null }],
			probeIntervalMs: 60_000,
			probeTimeoutMs: 5_000
		});
	});

	it('is null when nothing is configured, so a node without local AI is unchanged', () => {
		expect(resolve(null)).toEqual({ settings: null, problems: [] });
		expect(resolve({})).toEqual({ settings: null, problems: [] });
	});

	it('drops an unknown kind with a problem that names the known ones', () => {
		const { settings, problems } = resolve({ providers: [{ kind: 'koboldcpp', baseUrl: 'http://x:5001' }] });
		expect(settings).toBeNull();
		expect(problems).toEqual([
			'localAi.providers[0]: ignored — unknown kind "koboldcpp" (known: openai-compatible, llama-swap, ollama, lm-studio, vllm)'
		]);
	});

	it('uses the kind’s default address, and requires one for a kind that has none', () => {
		expect(resolve({ providers: [{ kind: 'ollama' }] }).settings!.providers[0]!.baseUrl).toBe(
			'http://127.0.0.1:11434'
		);
		expect(resolve({ providers: [{ kind: 'openai-compatible' }] }).problems).toEqual([
			'localAi.providers[0] ("openai-compatible"): ignored — "baseUrl" is required for kind openai-compatible'
		]);
	});

	it('normalises the base URL to the server root (the platform plugins’ …/v1 form is accepted)', () => {
		expect(normalizeLocalAiBaseUrl('http://localhost:1234/v1/')).toEqual({ url: 'http://localhost:1234' });
		expect(normalizeLocalAiBaseUrl('https://gw.lan/llm/v1')).toEqual({ url: 'https://gw.lan/llm' });
		expect(normalizeLocalAiBaseUrl('http://[fd00::1]:8000')).toEqual({ url: 'http://[fd00::1]:8000' });
	});

	it.each([
		['http://user:secret@gw:8000', 'must not carry a user name or password'],
		['http://gw:8000/?key=abc', 'must not carry a query string'],
		['ftp://gw/models', 'must be an http:// or https:// URL'],
		['not a url', 'is not a URL'],
		['http://gw:8000/a%20b', 'contains characters']
	])('refuses the base URL %s', (baseUrl, reason) => {
		const { settings, problems } = resolve({ providers: [{ kind: 'vllm', baseUrl }] });
		expect(settings).toBeNull();
		expect(problems[0]).toContain(reason);
		// Never echoes the URL itself back: it may be the thing carrying the secret.
		expect(problems.join('\n')).not.toContain('secret');
	});

	it('refuses a relative key file, both key sources at once, and a key VALUE where a name belongs', () => {
		expect(resolve({ providers: [{ kind: 'ollama', apiKeyFile: 'keys/llm.key' }] }).problems[0]).toContain(
			'apiKeyFile must be an absolute path'
		);
		expect(
			resolve({ providers: [{ kind: 'ollama', apiKeyFile: '/k', apiKeyEnv: 'LLM_KEY' }] }).problems[0]
		).toContain('apiKeyFile OR apiKeyEnv');
		const valueAsName = resolve({ providers: [{ kind: 'ollama', apiKeyEnv: 'sk-abc.def-123' }] });
		expect(valueAsName.problems[0]).toContain('must be an environment variable NAME');
		expect(valueAsName.problems.join('\n')).not.toContain('sk-abc.def-123');
	});

	it('accepts a Windows key file path and an env var name', () => {
		const { settings } = resolve({
			providers: [
				{ id: 'a', kind: 'ollama', apiKeyFile: 'C:\\ProgramData\\ever-works-node\\llm.key' },
				{ id: 'b', kind: 'vllm', apiKeyEnv: 'VLLM_API_KEY' }
			]
		});
		expect(settings!.providers.map((provider) => provider.apiKey)).toEqual([
			{ source: 'file', path: 'C:\\ProgramData\\ever-works-node\\llm.key' },
			{ source: 'env', name: 'VLLM_API_KEY' }
		]);
	});

	it('drops models and APIs it cannot use, and records that the APIs were declared', () => {
		const { settings, problems } = resolve({
			providers: [
				{
					kind: 'ollama',
					models: ['qwen3:8b', 'bad model', 'org/model'],
					defaultModel: 'x; rm',
					apis: ['anthropic-messages', 'grpc']
				}
			]
		});
		expect(settings!.providers[0]).toMatchObject({
			models: ['qwen3:8b', 'org/model'],
			defaultModel: null,
			apis: ['anthropic-messages'],
			apisDeclared: true
		});
		expect(problems).toHaveLength(3);
	});

	it('refuses an id that could not be a Codex config key, and duplicate ids', () => {
		expect(resolve({ providers: [{ id: 'gpu.box', kind: 'ollama' }] }).problems[0]).toContain('must be lower-case');
		const { settings, problems } = resolve({
			providers: [
				{ id: 'gpu', kind: 'ollama' },
				{ id: 'gpu', kind: 'vllm' }
			]
		});
		expect(settings!.providers).toHaveLength(1);
		expect(problems[0]).toContain('another provider already has the id "gpu"');
	});

	it('KEEPS an agent runtime whose provider is invalid, so it fails closed instead of running on the cloud seat', () => {
		const { settings, problems } = resolve({
			providers: [{ id: 'gpu', kind: 'koboldcpp', baseUrl: 'http://x:1' }],
			agentRuntime: { cli: 'claude-code', provider: 'gpu' }
		});
		expect(settings!.agentRuntimes).toEqual([
			{ cli: 'claude-code', provider: 'gpu', model: null, smallModel: null }
		]);
		expect(problems[1]).toContain('this node will NOT run claude-code Tasks until that is fixed');
	});

	it('refuses an agent runtime for a CLI the fleet does not drive', () => {
		const { settings, problems } = resolve({
			providers: [{ kind: 'ollama' }],
			agentRuntime: { cli: 'gemini', provider: 'ollama' }
		});
		expect(settings!.agentRuntimes).toEqual([]);
		expect(problems[0]).toContain('"cli" must be claude-code or codex');
	});

	it('takes one runtime per CLI from a list', () => {
		const { settings, problems } = resolve({
			providers: [{ kind: 'llama-swap', baseUrl: 'http://gw:8000' }],
			agentRuntime: [
				{ cli: 'claude-code', provider: 'llama-swap' },
				{ cli: 'codex', provider: 'llama-swap', model: 'flashnext' },
				{ cli: 'codex', provider: 'llama-swap' }
			]
		});
		expect(settings!.agentRuntimes.map((runtime) => runtime.cli)).toEqual(['claude-code', 'codex']);
		expect(problems[0]).toContain('codex is already bound');
	});

	it('clamps the probe interval and timeout', () => {
		const { settings } = resolve({ providers: [{ kind: 'ollama' }], probeIntervalSec: 1, probeTimeoutSec: 900 });
		expect(settings).toMatchObject({ probeIntervalMs: 10_000, probeTimeoutMs: 30_000 });
	});
});

describe('the environment shorthand', () => {
	const env = {
		[LOCAL_AI_ENV.kind]: 'llama-swap',
		[LOCAL_AI_ENV.id]: 'gpu',
		[LOCAL_AI_ENV.baseUrl]: 'http://192.168.1.68:8000',
		[LOCAL_AI_ENV.apiKeyFile]: '/etc/ever-works-node/local-llm.key',
		[LOCAL_AI_ENV.model]: 'flashnext',
		[LOCAL_AI_ENV.agentCli]: 'claude-code'
	};

	it('describes one provider and binds the named CLI to it', () => {
		expect(readLocalAiEnv(env)).toEqual({
			provider: {
				kind: 'llama-swap',
				id: 'gpu',
				baseUrl: 'http://192.168.1.68:8000',
				apiKeyFile: '/etc/ever-works-node/local-llm.key',
				defaultModel: 'flashnext'
			},
			agentRuntime: { cli: 'claude-code', provider: 'gpu', model: 'flashnext' }
		});
		expect(readLocalAiEnv({ ...env, [LOCAL_AI_ENV.agentCli]: 'none' }).agentRuntime).toBeNull();
		expect(readLocalAiEnv({})).toEqual({ provider: null, agentRuntime: null });
	});

	it('replaces a stored provider with the same id and the stored binding of the same CLI', () => {
		const { settings, problems } = resolve(LLAMA_SWAP, env);
		expect(problems).toEqual([]);
		expect(settings!.providers).toHaveLength(1);
		expect(settings!.providers[0]!.baseUrl).toBe('http://192.168.1.68:8000');
		expect(settings!.agentRuntimes).toEqual([
			{ cli: 'claude-code', provider: 'gpu', model: 'flashnext', smallModel: null }
		]);
	});

	it('works with no config file section at all', () => {
		const { settings } = resolve(null, env);
		expect(settings!.providers.map((provider) => provider.id)).toEqual(['gpu']);
	});
});

describe('stored config', () => {
	const base = {
		apiUrl: 'https://api.ever.works',
		nodeId: 'node-1',
		secret: 'a'.repeat(43),
		kind: 'node',
		capabilities: [],
		heartbeatIntervalMs: 30_000,
		enrolledAt: '2026-11-21T00:00:00.000Z'
	};

	it('round-trips localAi and extraCapabilities through parseConfig, shape only', () => {
		const parsed = parseConfig(
			JSON.stringify({
				...base,
				localAi: { ...LLAMA_SWAP, probeIntervalSec: 30, unknown: true },
				extraCapabilities: ['gpu', 'gpu:nvidia', 7]
			})
		);
		expect(parsed!.localAi).toEqual({ ...LLAMA_SWAP, probeIntervalSec: 30 });
		expect(parsed!.extraCapabilities).toEqual(['gpu', 'gpu:nvidia']);
	});

	it('keeps a bad section from making the node read as not enrolled', () => {
		const parsed = parseConfig(JSON.stringify({ ...base, localAi: 'oops', extraCapabilities: 'gpu' }));
		expect(parsed).not.toBeNull();
		expect(parsed!.localAi).toBeUndefined();
		expect(parsed!.extraCapabilities).toBeUndefined();
	});

	it('keeps only known keys and string values', () => {
		expect(
			sanitizeStoredLocalAiConfig({
				providers: [{ kind: 'ollama', apiKey: 'sk-should-never-be-here', models: ['a', 2] }, 'x'],
				agentRuntime: { cli: 'codex', provider: 'ollama', extra: 1 }
			})
		).toEqual({
			providers: [{ kind: 'ollama', models: ['a'] }],
			agentRuntime: { cli: 'codex', provider: 'ollama' }
		});
	});

	it('shows key LOCATIONS in the redacted config, never a key', () => {
		const parsed = parseConfig(JSON.stringify({ ...base, localAi: LLAMA_SWAP }))!;
		const view = JSON.stringify(redactConfig(parsed));
		expect(view).toContain('/etc/ever-works-node/local-llm.key');
		expect(view).not.toContain(base.secret);
	});
});
