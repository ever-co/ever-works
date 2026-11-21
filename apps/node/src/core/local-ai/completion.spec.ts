import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES, type FleetConsents } from '@ever-works/contracts';
import { resolveLocalAiSettings, type NodeLocalAiConfig } from './config';
import { decodeLocalAiCompletionBody, encodeLocalAiCompletionBody } from './completion-codec';
import { LocalAiLaneCadence, planLocalAiLane } from './completion-lane';
import { LOCAL_AI_COMPLETION_WIRES, resolveServedModelId, selectLocalAiCompletionTarget } from './completion';
import { defaultLocalAiProviderRegistry } from './registry';
import type { LocalAiModelInfo, LocalAiProviderStatus } from './types';

/**
 * Local AI completions on the node — choosing the provider, the body codec,
 * and the lane's plan and cadence. The relay itself is pinned in
 * `executors/ai-completion.spec.ts`; the lane in the runtime in
 * `runtime.local-ai-lane.spec.ts`.
 */

const registry = defaultLocalAiProviderRegistry();

function settingsOf(stored: NodeLocalAiConfig, env: Record<string, string> = {}) {
	return resolveLocalAiSettings({ stored, env }, registry);
}

function status(id: string, kind: string, models: Array<string | LocalAiModelInfo>, up = true): LocalAiProviderStatus {
	return {
		id,
		kind,
		status: up ? 'up' : 'down',
		checkedAt: '2026-11-21T00:00:00.000Z',
		latencyMs: 5,
		models: models.map((model) => (typeof model === 'string' ? { id: model } : model)),
		version: null,
		error: up ? null : 'connection refused',
		apis: []
	};
}

const TWO: NodeLocalAiConfig = {
	providers: [
		{ id: 'a', kind: 'llama-swap', baseUrl: 'http://10.0.0.1:8000' },
		{ id: 'b', kind: 'openai-compatible', baseUrl: 'http://10.0.0.2:8080' }
	]
};

describe('selectLocalAiCompletionTarget', () => {
	it('builds the URL from the wire table: /v1 + path for OpenAI APIs, the root for Messages', () => {
		const { settings } = settingsOf({ providers: [TWO.providers![0]!] });
		const statuses = [status('a', 'llama-swap', ['m1'])];
		const chat = selectLocalAiCompletionTarget(settings!, statuses, registry, 'openai-chat', 'm1');
		const responses = selectLocalAiCompletionTarget(settings!, statuses, registry, 'openai-responses', 'm1');
		const messages = selectLocalAiCompletionTarget(settings!, statuses, registry, 'anthropic-messages', 'm1');
		expect(chat).toMatchObject({ ok: true, target: { url: 'http://10.0.0.1:8000/v1/chat/completions' } });
		expect(responses).toMatchObject({ ok: true, target: { url: 'http://10.0.0.1:8000/v1/responses' } });
		expect(messages).toMatchObject({
			ok: true,
			target: {
				url: 'http://10.0.0.1:8000/v1/messages',
				headers: LOCAL_AI_COMPLETION_WIRES['anthropic-messages'].headers
			}
		});
	});

	it('prefers a provider that has the model loaded, then config order, and skips one that is down', () => {
		const { settings } = settingsOf(TWO);
		expect(
			selectLocalAiCompletionTarget(
				settings!,
				[status('a', 'llama-swap', ['m1']), status('b', 'openai-compatible', [{ id: 'm1', loaded: true }])],
				registry,
				'openai-chat',
				'm1'
			)
		).toMatchObject({ ok: true, target: { provider: { id: 'b' } } });
		expect(
			selectLocalAiCompletionTarget(
				settings!,
				[status('a', 'llama-swap', ['m1']), status('b', 'openai-compatible', ['m1'])],
				registry,
				'openai-chat',
				'm1'
			)
		).toMatchObject({ ok: true, target: { provider: { id: 'a' } } });
		expect(
			selectLocalAiCompletionTarget(
				settings!,
				[status('a', 'llama-swap', ['m1'], false), status('b', 'openai-compatible', ['m1'])],
				registry,
				'openai-chat',
				'm1'
			)
		).toMatchObject({ ok: true, target: { provider: { id: 'b' } } });
	});

	it('says why it found nothing', () => {
		const { settings } = settingsOf(TWO);
		expect(selectLocalAiCompletionTarget(settings!, [], registry, 'openai-chat', 'm1')).toEqual({
			ok: false,
			reason: 'no local AI provider on this node is up'
		});
		// A generic OpenAI-compatible server promises only Chat Completions; llama-swap is down.
		expect(
			selectLocalAiCompletionTarget(
				settings!,
				[status('a', 'llama-swap', ['m1'], false), status('b', 'openai-compatible', ['m1'])],
				registry,
				'openai-responses',
				'm1'
			)
		).toMatchObject({ ok: false, reason: expect.stringContaining('speaks openai-responses') });
	});
});

describe('resolveServedModelId', () => {
	const { settings } = settingsOf({ providers: [{ kind: 'ollama' }] });
	const provider = settings!.providers[0]!;

	it("matches an exact id, Ollama's implicit :latest, then the tag value", () => {
		const served = status('ollama', 'ollama', ['qwen3:8b', 'llama3.2:latest', 'Org/Big-Model']);
		expect(resolveServedModelId(provider, served, 'qwen3:8b')).toBe('qwen3:8b');
		expect(resolveServedModelId(provider, served, 'llama3.2')).toBe('llama3.2:latest');
		expect(resolveServedModelId(provider, served, 'qwen3-8b')).toBe('qwen3:8b');
		expect(resolveServedModelId(provider, served, 'org-big-model')).toBe('Org/Big-Model');
		expect(resolveServedModelId(provider, served, 'nope')).toBeNull();
	});

	it('keeps to the operator’s declared models when there are any', () => {
		const declared = settingsOf({ providers: [{ kind: 'ollama', models: ['qwen3:8b'] }] }).settings!.providers[0]!;
		const served = status('ollama', 'ollama', ['qwen3:8b', 'llama3.2:latest']);
		expect(resolveServedModelId(declared, served, 'qwen3:8b')).toBe('qwen3:8b');
		expect(resolveServedModelId(declared, served, 'llama3.2')).toBeNull();
	});
});

describe('the completion body codec', () => {
	it('round-trips JSON through gzip + base64', () => {
		const value = { choices: [{ message: { content: 'héllo' } }] };
		const encoded = encodeLocalAiCompletionBody(value);
		expect(encoded.bodyEncoding).toBe('gzip-base64');
		expect(decodeLocalAiCompletionBody(encoded.body, 'gzip-base64', 1024)).toEqual(value);
		expect(decodeLocalAiCompletionBody(JSON.stringify(value), 'json', 1024)).toEqual(value);
	});

	it('refuses to inflate past the decoded cap (a zip bomb stays small)', () => {
		const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024, 0x20)).toString('base64');
		expect(bomb.length).toBeLessThan(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES);
		expect(() => decodeLocalAiCompletionBody(bomb, 'gzip-base64', 1024 * 1024)).toThrow(
			'the request is larger than 1048576 bytes decoded'
		);
	});

	it('refuses a body that is not gzip or not JSON, and an answer over the encoded cap', () => {
		expect(() => decodeLocalAiCompletionBody('aGVsbG8=', 'gzip-base64', 1024)).toThrow('not gzip-compressed');
		expect(() =>
			decodeLocalAiCompletionBody(gzipSync(Buffer.from('nope')).toString('base64'), 'gzip-base64', 1024)
		).toThrow('not JSON');
		expect(() => decodeLocalAiCompletionBody('x'.repeat(2048), 'json', 1024)).toThrow('larger than 1024 bytes');
		const noise = randomBytes(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES).toString('base64');
		expect(() => encodeLocalAiCompletionBody({ noise })).toThrow(/KiB a completion carries back/);
	});
});

describe('planLocalAiLane', () => {
	const work: FleetConsents = { work: true, attend: false, manage: false, usageScan: false };
	const manage: FleetConsents = { work: false, attend: false, manage: true, usageScan: false };

	it('plans the lane under --work with a provider, at the configured concurrency', () => {
		expect(
			planLocalAiLane(work, settingsOf({ ...TWO, completions: { concurrency: 3, idlePollSec: 2 } }).settings)
		).toEqual({
			enabled: true,
			kinds: ['ai-completion'],
			concurrency: 3,
			idlePollMs: 2_000,
			maxTimeoutMs: 1_800_000
		});
	});

	it('says why there is no lane', () => {
		expect(planLocalAiLane(work, null)).toEqual({ enabled: false, reason: 'no local AI provider is configured' });
		expect(planLocalAiLane(manage, settingsOf(TWO).settings)).toEqual({
			enabled: false,
			reason: 'the node was not started with --work'
		});
		expect(planLocalAiLane(work, settingsOf({ ...TWO, completions: { enabled: false } }).settings)).toMatchObject({
			enabled: false,
			reason: expect.stringContaining('switched off')
		});
		// An agent binding alone (no valid provider) is no lane.
		expect(
			planLocalAiLane(work, settingsOf({ agentRuntime: { cli: 'codex', provider: 'missing' } }).settings)
		).toMatchObject({ enabled: false });
	});
});

describe('LocalAiLaneCadence', () => {
	it('polls every second for a while after a lease, then back off to the idle poll', () => {
		let now = 0;
		const cadence = new LocalAiLaneCadence({ idlePollMs: 5_000, now: () => now });
		expect(cadence.nextIdleDelayMs()).toBe(5_000);
		cadence.recordPoll(0);
		expect(cadence.nextIdleDelayMs()).toBe(5_000);
		cadence.recordPoll(1);
		expect(cadence.nextIdleDelayMs()).toBe(1_000);
		now += 119_000;
		expect(cadence.nextIdleDelayMs()).toBe(1_000);
		now += 2_000;
		expect(cadence.nextIdleDelayMs()).toBe(5_000);
	});

	it('never polls slower than the configured idle poll when that is faster than a second', () => {
		const cadence = new LocalAiLaneCadence({ idlePollMs: 500, now: () => 0 });
		cadence.recordPoll(1);
		expect(cadence.nextIdleDelayMs()).toBe(500);
	});
});
