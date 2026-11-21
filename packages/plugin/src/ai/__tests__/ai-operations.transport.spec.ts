import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiOperations } from '../ai-operations';

/**
 * A provider's own transport (`AiOperationsConfig.fetch`, from
 * `IAiProviderPlugin.createTransport`): every request the OpenAI client makes
 * — chat, streaming, the model list, the connection test — goes through it,
 * never through the global `fetch`, and the SSRF guard (which protects the
 * DEFAULT transport) does not refuse its placeholder origin.
 */

const BASE = 'https://fleet-local-ai.invalid/v1';

function answer(content: string): Response {
	return new Response(
		JSON.stringify({
			id: 'r1',
			object: 'chat.completion',
			created: 1,
			model: 'flashnext',
			choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

function stream(content: string): Response {
	const chunk = (delta: Record<string, unknown>, finish: string | null) =>
		`data: ${JSON.stringify({
			id: 'r1',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'flashnext',
			choices: [{ index: 0, delta, finish_reason: finish }]
		})}\n\n`;
	return new Response(`${chunk({ role: 'assistant', content }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' }
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('AiOperations — a supplied transport', () => {
	it('sends a chat completion through the transport and never through the global fetch', async () => {
		const global = vi.fn(async () => answer('from the network'));
		vi.stubGlobal('fetch', global);
		const seen: string[] = [];
		const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(`${String(input)} ${String(init?.method)}`);
			return answer('from the transport');
		});
		const ops = new AiOperations({
			apiKey: 'placeholder',
			model: 'flashnext',
			baseURL: BASE,
			providerType: 'fleet-local-ai',
			fetch: transport
		});

		const response = await ops.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

		expect(response.choices[0].message.content).toBe('from the transport');
		expect(seen).toEqual([`${BASE}/chat/completions POST`]);
		expect(global).not.toHaveBeenCalled();
	});

	it('streams through the transport', async () => {
		const transport = vi.fn(async () => stream('streamed'));
		const ops = new AiOperations({
			apiKey: 'placeholder',
			model: 'flashnext',
			baseURL: BASE,
			providerType: 'fleet-local-ai'
		});

		let text = '';
		for await (const chunk of ops.createStreamingChatCompletion(
			{ messages: [{ role: 'user', content: 'hi' }] },
			{ fetch: transport }
		)) {
			const content = chunk.choices[0]?.delta.content;
			if (typeof content === 'string') text += content;
		}

		expect(text).toBe('streamed');
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it('lists models through the transport', async () => {
		const transport = vi.fn(
			async () =>
				new Response(JSON.stringify({ object: 'list', data: [{ id: 'flashnext' }] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const ops = new AiOperations({ apiKey: 'p', model: 'm', baseURL: BASE, providerType: 'x', fetch: transport });

		const models = await ops.listModels();

		expect(models.map((model) => model.id)).toEqual(['flashnext']);
		expect(transport).toHaveBeenCalledWith(`${BASE}/models`, expect.anything());
	});

	it('still refuses a private address on the DEFAULT transport', async () => {
		const ops = new AiOperations({
			apiKey: 'k',
			model: 'm',
			baseURL: 'http://169.254.169.254/v1',
			providerType: 'openai'
		});
		await expect(ops.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
			/baseURL is not allowed/
		);
	});
});
