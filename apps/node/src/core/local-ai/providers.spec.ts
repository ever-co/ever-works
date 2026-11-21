import { describe, expect, it } from 'vitest';
import { LocalAiMonitor } from './monitor';
import { defaultLocalAiProviderRegistry } from './registry';
import { fakeFetch, type FakeRoute } from './local-ai-test-kit';
import type { FetchRequestInit } from '../fleet-client';
import type { LocalAiProviderSettings, LocalAiProviderStatus } from './types';

/**
 * Each built-in provider kind's probe, against its own documented endpoints
 * (mocked HTTP): what it reads, what it ignores, and when it calls a server
 * down. No probe ever asks a model to generate anything.
 */

const KEY = 'test-local-ai-key-0123456789abcdef';

function provider(kind: string, over: Partial<LocalAiProviderSettings> = {}): LocalAiProviderSettings {
	const definition = defaultLocalAiProviderRegistry().get(kind);
	return {
		id: kind,
		kind,
		baseUrl: 'http://10.0.0.5:8000',
		apiKey: null,
		models: [],
		defaultModel: null,
		apis: [...definition.defaultApis],
		apisDeclared: false,
		...over
	};
}

async function probe(
	settings: LocalAiProviderSettings,
	routes: Record<string, FakeRoute | ((init: FetchRequestInit) => FakeRoute)>,
	key: string | null = null
): Promise<{ status: LocalAiProviderStatus; calls: ReturnType<typeof fakeFetch>['calls'] }> {
	const fetch = fakeFetch(routes);
	const monitor = new LocalAiMonitor({
		settings: { providers: [settings], agentRuntimes: [], probeIntervalMs: 60_000, probeTimeoutMs: 2_000 },
		fetchFn: fetch.fetchFn,
		secrets: { readKeyFile: async () => key, env: {} }
	});
	const [status] = await monitor.refresh();
	return { status: status!, calls: fetch.calls };
}

const base = 'http://10.0.0.5:8000';

describe('openai-compatible', () => {
	it('is up with the models GET /v1/models lists, and sends the key as a Bearer token', async () => {
		const { status, calls } = await probe(
			provider('openai-compatible', { apiKey: { source: 'file', path: '/k' } }),
			{ [`${base}/v1/models`]: { body: { object: 'list', data: [{ id: 'qwen3' }, { id: 'phi-4' }] } } },
			KEY
		);
		expect(status.status).toBe('up');
		expect(status.models.map((model) => model.id)).toEqual(['qwen3', 'phi-4']);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.init.method).toBe('GET');
		expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(calls[0]!.init.body).toBe('');
	});

	it('skips entries whose id could not be put on a command line, and duplicates', async () => {
		const { status } = await probe(provider('openai-compatible'), {
			[`${base}/v1/models`]: {
				body: { data: [{ id: 'ok-model' }, { id: 'bad model; rm -rf' }, { id: 'ok-model' }, { nope: 1 }, 'x'] }
			}
		});
		expect(status.models.map((model) => model.id)).toEqual(['ok-model']);
	});

	it('is down, with a short reason, for an HTTP error, a non-JSON body, a wrong shape or a refused connection', async () => {
		expect(
			(await probe(provider('openai-compatible'), { [`${base}/v1/models`]: { status: 401 } })).status
		).toMatchObject({
			status: 'down',
			error: '/v1/models: HTTP 401'
		});
		expect(
			(await probe(provider('openai-compatible'), { [`${base}/v1/models`]: { text: '<html>' } })).status.error
		).toBe('/v1/models: the response is not JSON');
		expect(
			(await probe(provider('openai-compatible'), { [`${base}/v1/models`]: { body: { models: [] } } })).status
				.error
		).toContain('not an OpenAI-style');
		expect(
			(await probe(provider('openai-compatible'), { [`${base}/v1/models`]: { networkError: 'ECONNREFUSED' } }))
				.status.error
		).toBe('/v1/models: connection refused');
	});
});

describe('llama-swap', () => {
	it('reads /v1/models and marks the model /running says is loaded', async () => {
		const { status, calls } = await probe(provider('llama-swap'), {
			[`${base}/v1/models`]: { body: { data: [{ id: 'flashnext' }, { id: 'coder' }] } },
			[`${base}/running`]: { body: { running: [{ model: 'flashnext', state: 'ready' }] } }
		});
		expect(status.status).toBe('up');
		expect(status.models).toEqual([
			{ id: 'flashnext', loaded: true },
			{ id: 'coder', loaded: false }
		]);
		expect(calls.map((call) => call.url)).toEqual([`${base}/v1/models`, `${base}/running`]);
		// Never a completion: probing must not make llama-swap load a model.
		expect(calls.every((call) => call.init.method === 'GET')).toBe(true);
	});

	it('stays up when /running cannot be read (an older llama-swap)', async () => {
		const { status } = await probe(provider('llama-swap'), {
			[`${base}/v1/models`]: { body: { data: [{ id: 'flashnext' }] } }
		});
		expect(status).toMatchObject({ status: 'up', models: [{ id: 'flashnext' }] });
	});

	it('speaks all three wire APIs by default', () => {
		expect(provider('llama-swap').apis).toEqual(['openai-chat', 'openai-responses', 'anthropic-messages']);
	});
});

describe('ollama', () => {
	it('reads /api/tags, marks /api/ps models loaded and reports /api/version', async () => {
		const { status } = await probe(provider('ollama', { baseUrl: 'http://127.0.0.1:11434' }), {
			'http://127.0.0.1:11434/api/tags': {
				body: { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }, { name: 'llama3.2:latest' }] }
			},
			'http://127.0.0.1:11434/api/ps': { body: { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }] } },
			'http://127.0.0.1:11434/api/version': { body: { version: '0.14.2' } }
		});
		expect(status).toMatchObject({
			status: 'up',
			version: '0.14.2',
			models: [
				{ id: 'qwen3:8b', loaded: true },
				{ id: 'llama3.2:latest', loaded: false }
			]
		});
	});

	it('defaults to the address a default install listens on', () => {
		expect(defaultLocalAiProviderRegistry().get('ollama').defaultBaseUrl).toBe('http://127.0.0.1:11434');
	});

	it('is down when /api/tags is not Ollama’s model list', async () => {
		const { status } = await probe(provider('ollama'), { [`${base}/api/tags`]: { body: { data: [] } } });
		expect(status.status).toBe('down');
		expect(status.error).toContain('Ollama');
	});
});

describe('lm-studio', () => {
	it('reads /api/v0/models: leaves embedding models out, keeps state and context length', async () => {
		const { status } = await probe(provider('lm-studio'), {
			[`${base}/api/v0/models`]: {
				body: {
					data: [
						{ id: 'qwen2.5-coder-14b', type: 'llm', state: 'loaded', max_context_length: 32768 },
						{ id: 'nomic-embed', type: 'embeddings', state: 'not-loaded' },
						{ id: 'gemma-3', type: 'vlm', state: 'not-loaded' }
					]
				}
			}
		});
		expect(status.models).toEqual([
			{ id: 'qwen2.5-coder-14b', loaded: true, contextLength: 32768 },
			{ id: 'gemma-3', loaded: false }
		]);
	});

	it('falls back to /v1/models when /api/v0/models is not there', async () => {
		const { status, calls } = await probe(provider('lm-studio'), {
			[`${base}/api/v0/models`]: { status: 404 },
			[`${base}/v1/models`]: { body: { data: [{ id: 'local-model' }] } }
		});
		expect(status).toMatchObject({ status: 'up', models: [{ id: 'local-model' }] });
		expect(calls.map((call) => call.url)).toEqual([`${base}/api/v0/models`, `${base}/v1/models`]);
	});

	it('does not fall back on an auth failure', async () => {
		const { status } = await probe(provider('lm-studio'), { [`${base}/api/v0/models`]: { status: 403 } });
		expect(status).toMatchObject({ status: 'down', error: '/api/v0/models: HTTP 403' });
	});
});

describe('vllm', () => {
	it('reads /v1/models with max_model_len and the version', async () => {
		const { status } = await probe(provider('vllm'), {
			[`${base}/v1/models`]: { body: { data: [{ id: 'Qwen/Qwen3-8B', max_model_len: 40960 }] } },
			[`${base}/version`]: { body: { version: '0.12.0' } }
		});
		expect(status).toMatchObject({
			status: 'up',
			version: '0.12.0',
			models: [{ id: 'Qwen/Qwen3-8B', contextLength: 40960 }]
		});
	});

	it('stays up without /version', async () => {
		const { status } = await probe(provider('vllm'), {
			[`${base}/v1/models`]: { body: { data: [{ id: 'm' }] } }
		});
		expect(status).toMatchObject({ status: 'up', version: null });
	});
});
