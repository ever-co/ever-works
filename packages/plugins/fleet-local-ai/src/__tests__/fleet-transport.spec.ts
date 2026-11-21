import { describe, expect, it } from 'vitest';
import { createFleetLocalAiFetch, FLEET_LOCAL_AI_BASE_URL } from '../fleet-transport';
import { answered, chatCompletion, fakeRelay } from './fake-relay';

/**
 * The transport an OpenAI-compatible client is given: what reaches the relay
 * (and what never leaves the process), how a provider's answer comes back,
 * how a streamed request is answered, and how each relay failure reads to a
 * client.
 */

const SCOPE = { userId: 'user-1', workId: 'work-1' };
const CHAT_URL = `${FLEET_LOCAL_AI_BASE_URL}/chat/completions`;

function post(body: unknown, extra: RequestInit = {}): RequestInit {
	return { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...extra };
}

describe('createFleetLocalAiFetch — a completion', () => {
	it("relays a chat completion for the caller and answers with the provider's status and body", async () => {
		const answer = chatCompletion({ content: 'hello' });
		const relay = fakeRelay(() => answered(answer));
		const fetch = createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 60_000 });
		const body = { model: 'flashnext', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 };

		const response = await fetch(CHAT_URL, post(body));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('x-fleet-local-ai-provider')).toBe('llama-swap');
		expect(await response.json()).toEqual(answer);
		expect(relay.requests).toEqual([
			{ userId: 'user-1', workId: 'work-1', api: 'openai-chat', model: 'flashnext', body, timeoutMs: 60_000 }
		]);
	});

	it('passes an error status from the provider through as an answer', async () => {
		const refusal = { error: { message: 'context length exceeded' } };
		const relay = fakeRelay(() => answered(refusal, 400));
		const response = await createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 })(
			CHAT_URL,
			post({ model: 'flashnext', messages: [] })
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual(refusal);
	});

	it('answers a streamed request with the event stream rebuilt from the whole answer', async () => {
		const relay = fakeRelay(() => answered(chatCompletion({ content: 'streamed' })));
		const response = await createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 })(
			CHAT_URL,
			post({ model: 'flashnext', messages: [{ role: 'user', content: 'hi' }], stream: true })
		);

		expect(response.headers.get('content-type')).toBe('text/event-stream');
		const text = await response.text();
		expect(text).toContain('"content":"streamed"');
		expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
		// The relay was asked for the whole answer; the node never streams.
		expect(relay.requests[0]?.body.stream).toBe(true);
	});

	it('reads a Request object and a byte body as well as a string', async () => {
		const relay = fakeRelay(() => answered(chatCompletion({ content: 'ok' })));
		const fetch = createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 });
		await fetch(new Request(CHAT_URL, post({ model: 'flashnext', messages: [{ role: 'user' }] })));
		await fetch(CHAT_URL, {
			method: 'POST',
			body: new TextEncoder().encode(JSON.stringify({ model: 'flashnext', messages: [{ role: 'user' }] }))
		});
		expect(relay.requests.map((request) => request.model)).toEqual(['flashnext', 'flashnext']);
	});

	it('routes the Responses and Messages APIs by path', async () => {
		const relay = fakeRelay(() => answered({ id: 'x' }));
		const fetch = createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 });
		await fetch(`${FLEET_LOCAL_AI_BASE_URL}/responses`, post({ model: 'flashnext', input: 'hi' }));
		await fetch(
			'https://fleet-local-ai.invalid/v1/messages',
			post({ model: 'flashnext', messages: [], max_tokens: 5 })
		);
		expect(relay.requests.map((request) => request.api)).toEqual(['openai-responses', 'anthropic-messages']);
	});
});

describe('createFleetLocalAiFetch — models', () => {
	it("answers the model list from the caller's computers", async () => {
		const relay = fakeRelay(
			() => answered({}),
			[
				{ id: 'flashnext', nodes: 2 },
				{ id: 'qwen3-8b', nodes: 1 }
			]
		);
		const response = await createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 })(
			`${FLEET_LOCAL_AI_BASE_URL}/models`
		);
		expect(await response.json()).toEqual({
			object: 'list',
			data: [
				{ id: 'flashnext', object: 'model', owned_by: 'fleet-local-ai', nodes: 2 },
				{ id: 'qwen3-8b', object: 'model', owned_by: 'fleet-local-ai', nodes: 1 }
			]
		});
		expect(relay.listModels).toHaveBeenCalledWith({ userId: 'user-1' });
	});
});

describe('createFleetLocalAiFetch — refusals and failures', () => {
	it.each([
		['no-node', 503],
		['stopped', 503],
		['invalid-request', 400],
		['too-large', 413],
		['timeout', 504],
		['failed', 502]
	] as const)('maps the relay failure %s to HTTP %i with an OpenAI-shaped error', async (code, status) => {
		const relay = fakeRelay(() => ({ ok: false, code, message: `relay said ${code}` }));
		const response = await createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 })(
			CHAT_URL,
			post({ model: 'flashnext', messages: [{ role: 'user' }] })
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({
			error: { message: `relay said ${code}`, type: 'fleet_local_ai_error', code }
		});
	});

	it('rejects with an AbortError on a cancel, like fetch does', async () => {
		const controller = new AbortController();
		const relay = fakeRelay(() => {
			controller.abort();
			return { ok: false, code: 'cancelled', message: 'cancelled' };
		});
		const fetch = createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 });

		await expect(
			fetch(CHAT_URL, post({ model: 'flashnext', messages: [{ role: 'user' }] }, { signal: controller.signal }))
		).rejects.toMatchObject({ name: 'AbortError' });
		await expect(
			fetch(CHAT_URL, post({ model: 'flashnext', messages: [] }, { signal: controller.signal }))
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(relay.complete).toHaveBeenCalledTimes(1);
		expect(relay.requests[0]?.signal).toBe(controller.signal);
	});

	it('never sends anything to another origin', async () => {
		const relay = fakeRelay(() => answered({}));
		const fetch = createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 });
		await expect(fetch('https://api.openai.com/v1/chat/completions', post({ model: 'x' }))).rejects.toThrow(
			/does not send requests to https:\/\/api\.openai\.com/
		);
		expect(relay.complete).not.toHaveBeenCalled();
	});

	it.each([
		['without the relay', { relay: undefined, scope: SCOPE }, post({ model: 'm', messages: [] }), 503],
		['without the caller', { scope: {} }, post({ model: 'm', messages: [] }), 400],
		['a body that is not JSON', {}, { method: 'POST', body: '{' }, 400],
		['a body that names no model', {}, post({ messages: [] }), 400],
		['a streamed Responses request', {}, post({ model: 'm', input: 'x', stream: true }), 400]
	])('refuses %s, sending nothing', async (_label, overrides, init, status) => {
		const relay = fakeRelay(() => answered({}));
		const fetch = createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1, ...overrides });
		const path = (init.body as string | undefined)?.includes('"input"') ? '/responses' : '/chat/completions';
		const response = await fetch(`${FLEET_LOCAL_AI_BASE_URL}${path}`, init);
		expect(response.status).toBe(status);
		expect(relay.complete).not.toHaveBeenCalled();
	});

	it('answers 404 for a path it does not serve', async () => {
		const relay = fakeRelay(() => answered({}));
		const response = await createFleetLocalAiFetch({ relay, scope: SCOPE, timeoutMs: 1 })(
			`${FLEET_LOCAL_AI_BASE_URL}/embeddings`,
			post({ model: 'm', input: 'x' })
		);
		expect(response.status).toBe(404);
	});
});
