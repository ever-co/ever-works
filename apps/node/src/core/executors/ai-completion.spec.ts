import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES,
	normalizeFleetAiCompletionResult,
	type FleetJobView
} from '@ever-works/contracts';
import { resolveLocalAiSettings, type NodeLocalAiConfig } from '../local-ai/config';
import { decodeLocalAiCompletionBody } from '../local-ai/completion-codec';
import { capturingLogger, fakeFetch, type FakeRoute } from '../local-ai/local-ai-test-kit';
import { LocalAiMonitor } from '../local-ai/monitor';
import { defaultLocalAiProviderRegistry, LocalAiProviderRegistry } from '../local-ai/registry';
import { BUILT_IN_LOCAL_AI_PROVIDERS, llamaSwapProvider } from '../local-ai/providers';
import type { FetchRequestInit } from '../fleet-client';
import type { JobLeaseHandle } from '../worker-loop';
import { runAiCompletionJob } from './ai-completion';

/**
 * The `ai-completion` executor against a fake llama-swap: what is sent (and
 * where), what comes back, and the paths that hand a job back, fail it, or
 * refuse it — with the prompt, the answer and the key never in a log line.
 */

// Synthetic, obviously fake values only.
const KEY = 'sk-test-fake-local-relay-key-0000';
const PROMPT = 'SECRET-PROMPT-TEXT do not log me';
const ANSWER = 'SECRET-ANSWER-TEXT do not log me either';
const GW = 'http://192.168.1.69:8000';
const OTHER = 'http://192.168.1.70:8080';

const GATEWAY: NodeLocalAiConfig = {
	providers: [
		{
			id: 'gpu',
			kind: 'llama-swap',
			baseUrl: GW,
			apiKeyFile: '/etc/ever-works-node/local-llm.key',
			defaultModel: 'flashnext'
		}
	]
};

const MODELS_UP: Record<string, FakeRoute> = {
	[`${GW}/v1/models`]: { body: { data: [{ id: 'flashnext' }, { id: 'qwen3:8b' }] } },
	[`${GW}/running`]: { body: { running: [] } }
};

const CHAT_ANSWER = {
	id: 'chatcmpl-1',
	object: 'chat.completion',
	created: 1,
	model: 'flashnext',
	choices: [
		{
			index: 0,
			message: { role: 'assistant', content: ANSWER, reasoning_content: 'thinking…' },
			finish_reason: 'stop'
		}
	],
	usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
};

function encode(value: unknown): string {
	return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
}

function job(overrides: Record<string, unknown> = {}, body?: unknown): FleetJobView {
	return {
		id: 'job-1',
		kind: 'ai-completion',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: ['local-ai', 'local-ai-completions', 'local-model:flashnext'],
		payload: {
			api: 'openai-chat',
			model: 'flashnext',
			body: encode(body ?? { messages: [{ role: 'user', content: PROMPT }], stream: true }),
			bodyEncoding: 'gzip-base64',
			timeoutSec: 60,
			...overrides
		},
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

function fakeLease(): JobLeaseHandle & { deferred: string[] } {
	const deferred: string[] = [];
	return {
		deferred,
		deadlineAt: () => Date.now() + 60_000,
		publishMarginMs: 0,
		confirmDeadline: async () => Date.now() + 60_000,
		defer: (reason: string) => {
			deferred.push(reason);
		},
		fetchRunEnvFiles: async () => [],
		mintPushCredential: async () => {
			throw new Error('not in this test');
		}
	};
}

function setup(
	routes: Record<string, FakeRoute | ((init: FetchRequestInit) => FakeRoute)>,
	options: { stored?: NodeLocalAiConfig; registry?: LocalAiProviderRegistry; key?: string | null } = {}
) {
	const registry = options.registry ?? defaultLocalAiProviderRegistry();
	const { settings } = resolveLocalAiSettings({ stored: options.stored ?? GATEWAY }, registry);
	const fetch = fakeFetch(routes);
	const log = capturingLogger();
	const monitor = new LocalAiMonitor({
		settings: settings!,
		registry,
		fetchFn: fetch.fetchFn,
		secrets: {
			readKeyFile: async (path) =>
				path === '/etc/ever-works-node/local-llm.key' ? (options.key === undefined ? KEY : options.key) : null,
			env: {}
		},
		logger: log.logger
	});
	// `null` = no lease handle at all (an embedder that has none).
	const run = (view: FleetJobView, lease: JobLeaseHandle | null = fakeLease(), signal?: AbortSignal) =>
		runAiCompletionJob(view, signal ?? new AbortController().signal, lease ?? undefined, {
			monitor,
			maxTimeoutMs: 120_000,
			logger: log.logger
		});
	return { monitor, fetch, log, run };
}

function completionCalls(fetch: ReturnType<typeof fakeFetch>) {
	return fetch.calls.filter((call) => call.init.method === 'POST');
}

function decodedAnswer(result: Record<string, unknown> | void) {
	const parsed = normalizeFleetAiCompletionResult(result);
	if (!parsed.ok) throw new Error(parsed.reason);
	return {
		result: parsed.value,
		body: decodeLocalAiCompletionBody(parsed.value.body, parsed.value.bodyEncoding, 4 * 1024 * 1024)
	};
}

function assertNothingSecretLogged(log: ReturnType<typeof capturingLogger>): void {
	const text = log.text();
	expect(text).not.toContain(PROMPT);
	expect(text).not.toContain(ANSWER);
	expect(text).not.toContain(KEY);
}

describe('runAiCompletionJob — the relay', () => {
	it("sends the request to the provider's own endpoint, non-streaming, with its key, and returns the answer", async () => {
		const { fetch, log, run } = setup({
			...MODELS_UP,
			[`POST ${GW}/v1/chat/completions`]: { body: CHAT_ANSWER }
		});

		const { result, body } = decodedAnswer(await run(job()));

		const [call] = completionCalls(fetch);
		expect(call.url).toBe(`${GW}/v1/chat/completions`);
		expect(call.init.headers.Authorization).toBe(`Bearer ${KEY}`);
		const sent = JSON.parse(call.init.body) as Record<string, unknown>;
		expect(sent).toEqual({ messages: [{ role: 'user', content: PROMPT }], model: 'flashnext', stream: false });
		expect(sent).not.toHaveProperty('stream_options');

		expect(result).toMatchObject({
			status: 200,
			providerId: 'gpu',
			providerKind: 'llama-swap',
			model: 'flashnext',
			usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
			costUsd: 0,
			costBasis: 'local'
		});
		expect(body).toEqual(CHAT_ANSWER);
		expect(log.text()).toContain('ai-completion job-1: openai-chat flashnext on "gpu" → HTTP 200');
		assertNothingSecretLogged(log);
	});

	it('maps the tag value the platform knows back to the id the provider serves', async () => {
		const { fetch, run } = setup(
			{
				...MODELS_UP,
				[`POST ${GW}/v1/chat/completions`]: { body: { ...CHAT_ANSWER, model: 'qwen3:8b' } }
			},
			{ stored: { providers: [{ ...GATEWAY.providers![0]!, defaultModel: undefined }] } }
		);

		const { result } = decodedAnswer(await run(job({ model: 'qwen3-8b' })));

		expect(JSON.parse(completionCalls(fetch)[0]!.init.body).model).toBe('qwen3:8b');
		expect(result.model).toBe('qwen3:8b');
	});

	it('relays a tool-call answer untouched', async () => {
		const toolCall = {
			...CHAT_ANSWER,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: null,
						tool_calls: [
							{
								id: 'call_1',
								type: 'function',
								function: { name: 'save_item', arguments: '{"name":"x"}' }
							}
						]
					},
					finish_reason: 'tool_calls'
				}
			]
		};
		const { fetch, run } = setup({ ...MODELS_UP, [`POST ${GW}/v1/chat/completions`]: { body: toolCall } });
		const tools = [{ type: 'function', function: { name: 'save_item', parameters: { type: 'object' } } }];

		const { body } = decodedAnswer(
			await run(job({}, { messages: [{ role: 'user', content: 'go' }], tools, tool_choice: 'auto' }))
		);

		expect(body).toEqual(toolCall);
		expect(JSON.parse(completionCalls(fetch)[0]!.init.body)).toMatchObject({ tools, tool_choice: 'auto' });
	});

	it('speaks the Anthropic Messages API at the root endpoint with its version header', async () => {
		const answer = {
			id: 'msg_1',
			type: 'message',
			content: [{ type: 'text', text: ANSWER }],
			usage: { input_tokens: 5, output_tokens: 3 }
		};
		const { fetch, run } = setup({ ...MODELS_UP, [`POST ${GW}/v1/messages`]: { body: answer } });

		const { result } = decodedAnswer(
			await run(
				job({ api: 'anthropic-messages' }, { messages: [{ role: 'user', content: PROMPT }], max_tokens: 64 })
			)
		);

		const [call] = completionCalls(fetch);
		expect(call.url).toBe(`${GW}/v1/messages`);
		expect(call.init.headers['anthropic-version']).toBe('2023-06-01');
		expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
	});

	it('hands an error status back as the answer it is (with a JSON error body)', async () => {
		const refusal = { error: { message: 'context length exceeded', type: 'invalid_request_error' } };
		const { run } = setup({
			...MODELS_UP,
			[`POST ${GW}/v1/chat/completions`]: { status: 400, body: refusal }
		});

		const { result, body } = decodedAnswer(await run(job()));

		expect(result.status).toBe(400);
		expect(body).toEqual(refusal);
	});

	it('replaces an error body that is not JSON (a proxy page) by a fixed shape', async () => {
		const { run } = setup({
			...MODELS_UP,
			[`POST ${GW}/v1/chat/completions`]: { status: 502, text: '<html>Bad gateway at 10.0.0.1</html>' }
		});

		const { result, body } = decodedAnswer(await run(job()));

		expect(result.status).toBe(502);
		expect(body).toEqual({
			error: { message: 'the local AI provider answered HTTP 502', type: 'local_ai_provider_error', code: 502 }
		});
		expect(JSON.stringify(body)).not.toContain('10.0.0.1');
	});

	it('fails a 2xx answer that is not JSON', async () => {
		const { run } = setup({ ...MODELS_UP, [`POST ${GW}/v1/chat/completions`]: { text: 'not json' } });
		await expect(run(job())).rejects.toThrow(/answered with a body that is not JSON/);
	});
});

describe('runAiCompletionJob — what it will not serve', () => {
	it('hands the job back, sending nothing, when the provider is down', async () => {
		const { fetch, log, run } = setup({ [`${GW}/v1/models`]: { networkError: 'ECONNREFUSED' } });
		const lease = fakeLease();

		await expect(run(job(), lease)).resolves.toBeUndefined();

		expect(lease.deferred).toEqual(['no local AI provider on this node is up']);
		expect(completionCalls(fetch)).toHaveLength(0);
		assertNothingSecretLogged(log);
	});

	it('hands the job back when no healthy provider serves the model', async () => {
		const { fetch, run } = setup(MODELS_UP);
		const lease = fakeLease();

		await run(job({ model: 'other-model' }), lease);

		expect(lease.deferred[0]).toMatch(/serves model "other-model"/);
		expect(completionCalls(fetch)).toHaveLength(0);
	});

	it('hands the job back when the provider does not speak the wire API', async () => {
		const { run } = setup(MODELS_UP, {
			stored: { providers: [{ ...GATEWAY.providers![0]!, apis: ['openai-chat'] }] }
		});
		const lease = fakeLease();

		await run(job({ api: 'openai-responses' }, { input: 'hi' }), lease);

		expect(lease.deferred[0]).toMatch(/speaks openai-responses/);
	});

	it("serves only the operator's declared models when it declared some (what the node advertises)", async () => {
		const { fetch, run } = setup(MODELS_UP, {
			stored: { providers: [{ ...GATEWAY.providers![0]!, models: ['flashnext'] }] }
		});
		const lease = fakeLease();

		await run(job({ model: 'qwen3-8b' }), lease);

		expect(lease.deferred).toHaveLength(1);
		expect(completionCalls(fetch)).toHaveLength(0);
	});

	it('hands the job back and re-probes when the request cannot reach the provider', async () => {
		let probes = 0;
		const { fetch, run } = setup({
			[`${GW}/v1/models`]: () => {
				probes += 1;
				return probes === 1 ? { body: { data: [{ id: 'flashnext' }] } } : { networkError: 'ECONNREFUSED' };
			},
			[`${GW}/running`]: { body: { running: [] } },
			[`POST ${GW}/v1/chat/completions`]: { networkError: 'ECONNRESET' }
		});
		const lease = fakeLease();

		await run(job(), lease);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(lease.deferred[0]).toMatch(/"gpu" is unreachable: gpu openai-chat: connection reset/);
		expect(completionCalls(fetch)).toHaveLength(1);
		expect(probes).toBe(2);
	});

	it('refuses an endpoint override that leaves the provider origin — the key never goes there', async () => {
		const hostile = new LocalAiProviderRegistry([
			...BUILT_IN_LOCAL_AI_PROVIDERS.filter((definition) => definition.kind !== 'llama-swap'),
			{ ...llamaSwapProvider, endpoint: () => `${OTHER}/v1` }
		]);
		const { fetch, run } = setup(MODELS_UP, { registry: hostile });
		const lease = fakeLease();

		await run(job(), lease);

		expect(lease.deferred[0]).toMatch(/away from its own address/);
		expect(fetch.calls.some((call) => call.url.startsWith(OTHER))).toBe(false);
	});

	it('fails without a lease handle, naming the reason, instead of pretending', async () => {
		const { run } = setup({ [`${GW}/v1/models`]: { status: 503, text: 'loading' } });
		await expect(run(job(), null)).rejects.toThrow(/not served here: no local AI provider/);
	});

	it.each([
		['a malformed payload', { api: 'openai' }, undefined, /api must be one of/],
		['a body that is not gzip', { body: Buffer.from('nope').toString('base64') }, undefined, /not gzip/],
		['a body with no messages', {}, { prompt: 'x' }, /messages must be an array/],
		[
			'a body over the decoded cap',
			{ body: gzipSync(Buffer.alloc(5 * 1024 * 1024, 32)).toString('base64') },
			undefined,
			/larger than/
		]
	])('refuses %s without touching the provider', async (_label, overrides, body, message) => {
		const { fetch, run } = setup(MODELS_UP);
		await expect(run(job(overrides as Record<string, unknown>, body))).rejects.toThrow(message);
		expect(fetch.calls).toHaveLength(0);
	});
});

describe('runAiCompletionJob — bounds', () => {
	it('fails a provider that does not answer within the budget (the operator ceiling wins), without the key in the error', async () => {
		const { monitor, log } = setup({ ...MODELS_UP, [`POST ${GW}/v1/chat/completions`]: { hang: true } });
		const started = Date.now();

		const failure = await runAiCompletionJob(job({ timeoutSec: 600 }), new AbortController().signal, fakeLease(), {
			monitor,
			maxTimeoutMs: 50,
			logger: log.logger
		}).catch((error: Error) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe('the local AI provider "gpu" did not answer within 50 ms');
		expect(Date.now() - started).toBeLessThan(5_000);
		assertNothingSecretLogged(log);
	});

	it('stops at once when the job is cancelled (the lease was lost or the caller cancelled)', async () => {
		const { run } = setup({ ...MODELS_UP, [`POST ${GW}/v1/chat/completions`]: { hang: true } });
		const controller = new AbortController();
		const pending = run(job(), fakeLease(), controller.signal);
		setTimeout(() => controller.abort(), 20);
		await expect(pending).rejects.toThrow(/cancelled/);
	});

	it('fails an answer larger than the relay carries back', async () => {
		// Random bytes do not compress: their base64 stays over the ENCODED cap.
		const noise = randomBytes(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES).toString('base64');
		const { log, run } = setup({
			...MODELS_UP,
			[`POST ${GW}/v1/chat/completions`]: {
				body: { ...CHAT_ANSWER, choices: [{ index: 0, message: { role: 'assistant', content: noise } }] }
			}
		});

		await expect(run(job())).rejects.toThrow(/KiB a completion carries back/);
		expect(log.text()).not.toContain(noise.slice(0, 64));
	});

	it('refuses a provider answer over the decoded response cap without keeping it', async () => {
		const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
		const { run } = setup({ ...MODELS_UP, [`POST ${GW}/v1/chat/completions`]: { text: huge } });
		await expect(run(job())).rejects.toThrow(/larger than 4194304 bytes/);
	});
});
