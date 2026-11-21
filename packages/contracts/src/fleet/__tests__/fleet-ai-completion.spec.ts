import { describe, expect, it } from 'vitest';
import {
	clampFleetAiCompletionTimeoutSec,
	FLEET_AI_COMPLETION_DEFAULT_TIMEOUT_SEC,
	FLEET_AI_COMPLETION_FAILURES,
	FLEET_AI_COMPLETION_JOB_KIND,
	FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES,
	FLEET_AI_COMPLETION_MAX_MESSAGES,
	FLEET_AI_COMPLETION_MAX_TIMEOUT_SEC,
	FLEET_AI_COMPLETION_MAX_TOOLS,
	FLEET_AI_COMPLETION_MIN_TIMEOUT_SEC,
	FLEET_AI_COMPLETION_STRIPPED_MEMBERS,
	FLEET_AI_WIRE_APIS,
	FLEET_LOCAL_AI_LANE_CONSENT,
	FLEET_LOCAL_AI_LANE_KINDS,
	fleetAiCompletionRequiredCapabilities,
	fleetAiWireApiForPath,
	fleetLocalModelCapability,
	fleetLocalModelFromCapability,
	fleetLocalModelTagSlug,
	isFleetAiCompletionFailure,
	isFleetAiCompletionModelId,
	isFleetAiWireApi,
	normalizeFleetAiCompletionPayload,
	normalizeFleetAiCompletionResult,
	readFleetAiCompletionUsage,
	validateFleetAiCompletionRequestBody
} from '../fleet-ai-completion.types';
import {
	FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC,
	FLEET_JOB_KINDS,
	FLEET_JOB_MAX_PAYLOAD_BYTES,
	FLEET_JOB_MAX_RESULT_BYTES,
	FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY,
	FLEET_MANAGEMENT_LANE_KINDS,
	isFleetJobKind,
	isFleetLocalAiCapability
} from '../fleet-jobs.types';

/** Local AI completions — the `ai-completion` job's wire shape. */
describe('the ai-completion kind', () => {
	it('is a job kind in every lockstep table', () => {
		expect(FLEET_AI_COMPLETION_JOB_KIND).toBe('ai-completion');
		expect(FLEET_JOB_KINDS).toContain('ai-completion');
		expect(isFleetJobKind('ai-completion')).toBe(true);
		expect(FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC['ai-completion']).toBe(7_200);
	});

	it('belongs to the local-AI lane under the work consent — never the management lane', () => {
		expect(FLEET_LOCAL_AI_LANE_KINDS).toEqual(['ai-completion']);
		expect(FLEET_LOCAL_AI_LANE_CONSENT).toBe('work');
		expect(FLEET_MANAGEMENT_LANE_KINDS).not.toContain('ai-completion');
	});

	it('keeps the encoded body well inside the job payload and result caps', () => {
		expect(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES).toBeLessThan(FLEET_JOB_MAX_PAYLOAD_BYTES - 16 * 1024);
		expect(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES).toBeLessThan(FLEET_JOB_MAX_RESULT_BYTES - 16 * 1024);
	});
});

describe('wire APIs', () => {
	it('names the three APIs a local provider can speak', () => {
		expect(FLEET_AI_WIRE_APIS).toEqual(['openai-chat', 'openai-responses', 'anthropic-messages']);
		for (const api of FLEET_AI_WIRE_APIS) expect(isFleetAiWireApi(api)).toBe(true);
		for (const value of ['openai', 'chat', '', null, 3]) expect(isFleetAiWireApi(value)).toBe(false);
	});

	it.each([
		['/v1/chat/completions', 'openai-chat'],
		['/api/v1/chat/completions/', 'openai-chat'],
		['/v1/responses', 'openai-responses'],
		['/v1/messages', 'anthropic-messages'],
		['/v1/models', null],
		['/v1/embeddings', null],
		['/v1/chat/completionsx', null]
	])('reads %s as %s', (path, api) => {
		expect(fleetAiWireApiForPath(path)).toBe(api);
	});
});

describe('timeouts', () => {
	it('clamps into [min, max] and defaults nonsense', () => {
		expect(clampFleetAiCompletionTimeoutSec(undefined)).toBe(FLEET_AI_COMPLETION_DEFAULT_TIMEOUT_SEC);
		expect(clampFleetAiCompletionTimeoutSec(-1)).toBe(FLEET_AI_COMPLETION_DEFAULT_TIMEOUT_SEC);
		expect(clampFleetAiCompletionTimeoutSec(Number.NaN)).toBe(FLEET_AI_COMPLETION_DEFAULT_TIMEOUT_SEC);
		expect(clampFleetAiCompletionTimeoutSec(1)).toBe(FLEET_AI_COMPLETION_MIN_TIMEOUT_SEC);
		expect(clampFleetAiCompletionTimeoutSec(1e9)).toBe(FLEET_AI_COMPLETION_MAX_TIMEOUT_SEC);
		expect(clampFleetAiCompletionTimeoutSec(120.4)).toBe(120);
	});
});

describe('model tags', () => {
	it('folds an id to the tag value the node advertises', () => {
		expect(fleetLocalModelTagSlug('flashnext')).toBe('flashnext');
		expect(fleetLocalModelTagSlug('Qwen3:8B')).toBe('qwen3-8b');
		expect(fleetLocalModelTagSlug('org/model--x')).toBe('org-model-x');
		expect(fleetLocalModelTagSlug('--a.b_')).toBe('a.b');
		expect(fleetLocalModelCapability('qwen3:8b')).toBe('local-model:qwen3-8b');
	});

	it('refuses an id whose tag would not fit (no node could ever advertise it)', () => {
		expect(fleetLocalModelTagSlug('a'.repeat(21))).toBeNull();
		expect(fleetLocalModelTagSlug('a'.repeat(20))).toBe('a'.repeat(20));
		expect(fleetLocalModelTagSlug('---')).toBeNull();
		expect(fleetLocalModelCapability('')).toBeNull();
		expect(fleetAiCompletionRequiredCapabilities('x'.repeat(40))).toBeNull();
	});

	it('trims a long run of separators in linear time', () => {
		const started = Date.now();
		expect(fleetLocalModelTagSlug(`a${'-'.repeat(100_000)}`)).toBe('a');
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it('reads the model back out of a tag, and only out of a well-formed one', () => {
		expect(fleetLocalModelFromCapability('local-model:flashnext')).toBe('flashnext');
		expect(fleetLocalModelFromCapability('local-model:')).toBeNull();
		expect(fleetLocalModelFromCapability('local-model:Bad Tag')).toBeNull();
		expect(fleetLocalModelFromCapability('local-ai')).toBeNull();
		expect(fleetLocalModelFromCapability(7)).toBeNull();
	});

	it('requires local-ai, the completions tag and the model tag — all of the local-AI family', () => {
		const required = fleetAiCompletionRequiredCapabilities('flashnext');
		expect(required).toEqual(['local-ai', FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY, 'local-model:flashnext']);
		for (const tag of required ?? []) expect(isFleetLocalAiCapability(tag)).toBe(true);
	});

	it('accepts the fleet opaque model id and nothing with structure in it', () => {
		expect(isFleetAiCompletionModelId('qwen3:8b')).toBe(true);
		expect(isFleetAiCompletionModelId('org/model-1.5')).toBe(true);
		for (const value of ['', 'a b', '$(x)', '-flag', 'a'.repeat(201), null]) {
			expect(isFleetAiCompletionModelId(value)).toBe(false);
		}
	});
});

describe('normalizeFleetAiCompletionPayload', () => {
	const valid = {
		api: 'openai-chat',
		model: 'flashnext',
		body: 'H4sI',
		bodyEncoding: 'gzip-base64',
		timeoutSec: 300
	};

	it('accepts a well-formed payload and clamps its timeout', () => {
		expect(normalizeFleetAiCompletionPayload(valid)).toEqual({ ok: true, value: valid });
		expect(normalizeFleetAiCompletionPayload({ ...valid, timeoutSec: 5 })).toMatchObject({
			ok: true,
			value: { timeoutSec: FLEET_AI_COMPLETION_MIN_TIMEOUT_SEC }
		});
	});

	it.each([
		['not an object', null],
		['an unknown api', { ...valid, api: 'openai' }],
		['a model with structure', { ...valid, model: 'a b' }],
		['an unknown encoding', { ...valid, bodyEncoding: 'zip' }],
		['an empty body', { ...valid, body: '' }],
		['a body that is not base64', { ...valid, body: '{"x":1}' }],
		['an oversized body', { ...valid, body: 'A'.repeat(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES + 1) }]
	])('refuses %s', (_label, raw) => {
		const parsed = normalizeFleetAiCompletionPayload(raw);
		expect(parsed.ok).toBe(false);
	});
});

describe('validateFleetAiCompletionRequestBody', () => {
	it('forwards a chat body without stream and stream_options', () => {
		const parsed = validateFleetAiCompletionRequestBody('openai-chat', {
			model: 'flashnext',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
			stream_options: { include_usage: true },
			tools: [{ type: 'function', function: { name: 'x' } }]
		});
		expect(parsed).toEqual({
			ok: true,
			value: {
				model: 'flashnext',
				messages: [{ role: 'user', content: 'hi' }],
				tools: [{ type: 'function', function: { name: 'x' } }]
			}
		});
		expect(FLEET_AI_COMPLETION_STRIPPED_MEMBERS).toEqual(['stream', 'stream_options']);
	});

	it('accepts a Responses body with string or list input, and a Messages body with max_tokens', () => {
		expect(validateFleetAiCompletionRequestBody('openai-responses', { input: 'hi' }).ok).toBe(true);
		expect(validateFleetAiCompletionRequestBody('openai-responses', { input: [{ role: 'user' }] }).ok).toBe(true);
		expect(
			validateFleetAiCompletionRequestBody('anthropic-messages', {
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 64
			}).ok
		).toBe(true);
	});

	it.each([
		['openai-chat', 'a non-object', 'hello'],
		['openai-chat', 'no messages', { model: 'm' }],
		['openai-chat', 'empty messages', { messages: [] }],
		['openai-chat', 'a non-object message', { messages: ['hi'] }],
		[
			'openai-chat',
			'too many messages',
			{ messages: Array.from({ length: FLEET_AI_COMPLETION_MAX_MESSAGES + 1 }, () => ({ role: 'user' })) }
		],
		[
			'openai-chat',
			'too many tools',
			{
				messages: [{ role: 'user' }],
				tools: Array.from({ length: FLEET_AI_COMPLETION_MAX_TOOLS + 1 }, () => ({}))
			}
		],
		['openai-chat', 'a model with structure', { model: '$(rm)', messages: [{ role: 'user' }] }],
		['openai-responses', 'empty input', { input: '' }],
		['openai-responses', 'no input', { messages: [{ role: 'user' }] }],
		['anthropic-messages', 'no max_tokens', { messages: [{ role: 'user' }] }],
		['anthropic-messages', 'a fractional max_tokens', { messages: [{ role: 'user' }], max_tokens: 1.5 }]
	] as const)('%s: refuses %s', (api, _label, body) => {
		expect(validateFleetAiCompletionRequestBody(api, body).ok).toBe(false);
	});
});

describe('normalizeFleetAiCompletionResult', () => {
	const valid = {
		status: 200,
		body: 'H4sI',
		bodyEncoding: 'gzip-base64',
		providerId: 'gpu',
		providerKind: 'llama-swap',
		model: 'flashnext',
		latencyMs: 1234.7,
		usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		costUsd: 0,
		costBasis: 'local'
	};

	it('reads a node result, always free', () => {
		expect(normalizeFleetAiCompletionResult(valid)).toEqual({ ok: true, value: { ...valid, latencyMs: 1234 } });
		expect(normalizeFleetAiCompletionResult({ ...valid, costUsd: 3, costBasis: 'cli' })).toMatchObject({
			ok: true,
			value: { costUsd: 0, costBasis: 'local' }
		});
	});

	it('keeps an error status: the provider refusing a request is an answer', () => {
		expect(normalizeFleetAiCompletionResult({ ...valid, status: 400 })).toMatchObject({
			ok: true,
			value: { status: 400 }
		});
	});

	it('drops garbage usage instead of refusing the answer', () => {
		expect(
			normalizeFleetAiCompletionResult({ ...valid, usage: { inputTokens: -1, outputTokens: 'x' } })
		).toMatchObject({ ok: true, value: { usage: null } });
	});

	it.each([
		['a non-object', 'x'],
		['a status that is not HTTP', { ...valid, status: 99 }],
		['a provider id with structure', { ...valid, providerId: 'GPU 1' }],
		['a provider kind with structure', { ...valid, providerKind: '../x' }],
		['a model with structure', { ...valid, model: 'a b' }],
		['an oversized body', { ...valid, body: 'A'.repeat(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES + 1) }]
	])('refuses %s', (_label, raw) => {
		expect(normalizeFleetAiCompletionResult(raw).ok).toBe(false);
	});
});

describe('readFleetAiCompletionUsage', () => {
	it('reads the Chat Completions usage block', () => {
		expect(
			readFleetAiCompletionUsage('openai-chat', {
				usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
			})
		).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
	});

	it('reads the Responses and Messages usage blocks, summing a missing total', () => {
		for (const api of ['openai-responses', 'anthropic-messages'] as const) {
			expect(readFleetAiCompletionUsage(api, { usage: { input_tokens: 7, output_tokens: 2 } })).toEqual({
				inputTokens: 7,
				outputTokens: 2,
				totalTokens: 9
			});
		}
	});

	it('answers null when the body reports none', () => {
		expect(readFleetAiCompletionUsage('openai-chat', { choices: [] })).toBeNull();
		expect(readFleetAiCompletionUsage('openai-chat', { usage: {} })).toBeNull();
		expect(readFleetAiCompletionUsage('openai-chat', null)).toBeNull();
	});
});

describe('outcomes', () => {
	it('names every failure the relay reports', () => {
		expect(FLEET_AI_COMPLETION_FAILURES).toEqual([
			'no-node',
			'stopped',
			'invalid-request',
			'too-large',
			'timeout',
			'cancelled',
			'failed'
		]);
		expect(isFleetAiCompletionFailure('no-node')).toBe(true);
		expect(isFleetAiCompletionFailure('nope')).toBe(false);
	});
});
