import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';
import { FleetLocalAiPlugin } from '../fleet-local-ai.plugin';
import { answered, chatCompletion, fakeRelay } from './fake-relay';

/**
 * The transport under the two clients that actually use it — the AI SDK
 * (what the agent pipeline builds from `getProviderConfig`) and the plugin's
 * own LangChain path (`AiOperations`, what the AI facade calls) — proving that
 * a tool call, a plain answer and a STREAMED answer all come through intact,
 * and that nothing ever reaches the network.
 */

const SCOPE = { userId: 'user-1', workId: 'work-1' };

const TOOL_CALL = chatCompletion(
	{
		content: null,
		tool_calls: [
			{
				id: 'call_save_1',
				type: 'function',
				function: { name: 'save_item', arguments: '{"name":"Ever Works","url":"https://ever.works"}' }
			}
		]
	},
	'tool_calls'
);
const FINAL = chatCompletion({ content: 'Saved one item.', reasoning_content: 'The tool succeeded.' });

/** Answers the first request with a tool call and the next with the final text. */
function toolThenText() {
	let turn = 0;
	return fakeRelay(() => answered(turn++ === 0 ? TOOL_CALL : FINAL));
}

async function loadedPlugin(relay: ReturnType<typeof fakeRelay>) {
	const plugin = new FleetLocalAiPlugin();
	await plugin.onLoad({
		pluginId: 'fleet-local-ai',
		logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
		services: { localAi: relay }
	} as unknown as PluginContext);
	return plugin;
}

const saveItem = {
	save_item: tool({
		description: 'Save one directory item',
		inputSchema: jsonSchema<{ name: string; url: string }>({
			type: 'object',
			properties: { name: { type: 'string' }, url: { type: 'string' } },
			required: ['name', 'url']
		}),
		execute: async (input: { name: string; url: string }) => ({ saved: input.name })
	})
};

function networkGuard() {
	const network = vi.fn(async () => new Response('the network must not be used', { status: 599 }));
	vi.stubGlobal('fetch', network);
	return network;
}

describe('the AI SDK over the transport (the agent pipeline’s client)', () => {
	it('runs a tool loop: the tool call and the final answer both come back through the relay', async () => {
		const network = networkGuard();
		const relay = toolThenText();
		const transport = (await loadedPlugin(relay)).createTransport(SCOPE, { defaultModel: 'flashnext' });
		const provider = createOpenAICompatible({
			name: 'fleet-local-ai',
			baseURL: transport.baseUrl,
			apiKey: transport.apiKey,
			fetch: transport.fetch
		});

		const result = await generateText({
			model: provider('flashnext'),
			tools: saveItem,
			stopWhen: stepCountIs(3),
			prompt: 'Add Ever Works to the directory'
		});

		expect(result.text).toBe('Saved one item.');
		expect(result.steps[0]?.toolCalls).toEqual([
			expect.objectContaining({
				toolCallId: 'call_save_1',
				toolName: 'save_item',
				input: { name: 'Ever Works', url: 'https://ever.works' }
			})
		]);
		expect(relay.requests).toHaveLength(2);
		expect(relay.requests[0]).toMatchObject({
			userId: 'user-1',
			workId: 'work-1',
			api: 'openai-chat',
			model: 'flashnext'
		});
		expect(relay.requests[0]?.body.tools).toEqual([
			expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'save_item' }) })
		]);
		// The second turn carries the tool's result back to the model.
		const toolMessage = (
			relay.requests[1]?.body.messages as Array<{ role: string; content: string; tool_call_id?: string }>
		).find((message) => message.role === 'tool');
		expect(toolMessage?.tool_call_id).toBe('call_save_1');
		expect(JSON.parse(toolMessage?.content ?? 'null')).toEqual({ saved: 'Ever Works' });
		expect(network).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('streams: a synthesised event stream yields the tool call, the reasoning, the text and the usage', async () => {
		const network = networkGuard();
		const relay = toolThenText();
		const transport = (await loadedPlugin(relay)).createTransport(SCOPE);
		const provider = createOpenAICompatible({
			name: 'fleet-local-ai',
			baseURL: transport.baseUrl,
			apiKey: transport.apiKey,
			fetch: transport.fetch,
			includeUsage: true
		});

		const stream = streamText({
			model: provider('flashnext'),
			tools: saveItem,
			stopWhen: stepCountIs(3),
			prompt: 'Add Ever Works to the directory'
		});
		const parts: string[] = [];
		for await (const part of stream.fullStream) parts.push(part.type);

		expect(await stream.text).toBe('Saved one item.');
		expect(await stream.reasoningText).toBe('The tool succeeded.');
		expect((await stream.steps)[0]?.toolCalls[0]).toMatchObject({ toolName: 'save_item' });
		expect((await stream.totalUsage).inputTokens).toBe(24);
		expect(parts).toEqual(expect.arrayContaining(['tool-call', 'tool-result', 'reasoning-delta', 'text-delta']));
		expect(relay.requests.every((request) => request.body.stream === true)).toBe(true);
		expect(network).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('surfaces "no computer serves this model" as an API error the SDK reports', async () => {
		networkGuard();
		const relay = fakeRelay(() => ({
			ok: false,
			code: 'no-node',
			message: 'No local AI node of yours is online for model "flashnext"'
		}));
		const transport = (await loadedPlugin(relay)).createTransport(SCOPE);
		const provider = createOpenAICompatible({
			name: 'fleet-local-ai',
			baseURL: transport.baseUrl,
			apiKey: transport.apiKey,
			fetch: transport.fetch
		});

		await expect(generateText({ model: provider('flashnext'), prompt: 'hi', maxRetries: 0 })).rejects.toThrow(
			/No local AI node of yours is online for model "flashnext"/
		);
		vi.unstubAllGlobals();
	});
});

describe('the plugin’s own calls over the transport (the AI facade’s path)', () => {
	it('createChatCompletion maps a tool call back, never touching the network', async () => {
		const network = networkGuard();
		const relay = fakeRelay(() => answered(TOOL_CALL));
		const plugin = await loadedPlugin(relay);

		const response = await plugin.createChatCompletion({
			model: 'flashnext',
			messages: [{ role: 'user', content: 'add it' }],
			tools: [{ type: 'function', function: { name: 'save_item', parameters: { type: 'object' } } }],
			scope: SCOPE
		});

		expect(response.choices[0]?.finishReason).toBe('tool_calls');
		expect(response.choices[0]?.message.toolCalls?.[0]).toMatchObject({
			id: 'call_save_1',
			function: { name: 'save_item' }
		});
		expect(relay.requests[0]).toMatchObject({ userId: 'user-1', api: 'openai-chat', model: 'flashnext' });
		expect(network).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('createStreamingChatCompletion streams the synthesised answer', async () => {
		networkGuard();
		const plugin = await loadedPlugin(fakeRelay(() => answered(FINAL)));
		let text = '';
		for await (const chunk of plugin.createStreamingChatCompletion({
			model: 'flashnext',
			messages: [{ role: 'user', content: 'hi' }],
			scope: SCOPE
		})) {
			const content = chunk.choices[0]?.delta.content;
			if (typeof content === 'string') text += content;
		}
		expect(text).toBe('Saved one item.');
		vi.unstubAllGlobals();
	});

	it('askJson returns the parsed structured answer', async () => {
		networkGuard();
		const { z } = await import('zod');
		const relay = fakeRelay((request) => {
			const tools = request.body.tools as Array<{ function: { name: string } }> | undefined;
			const format = request.body.response_format as { type?: string } | undefined;
			// LangChain asks for structured output either as a forced tool or as a JSON schema.
			if (tools?.length) {
				return answered(
					chatCompletion(
						{
							content: null,
							tool_calls: [
								{
									id: 'call_1',
									type: 'function',
									function: { name: tools[0]!.function.name, arguments: '{"title":"Ever Works"}' }
								}
							]
						},
						'tool_calls'
					)
				);
			}
			expect(format?.type).toBeDefined();
			return answered(chatCompletion({ content: '{"title":"Ever Works"}' }));
		});
		const plugin = await loadedPlugin(relay);

		const response = await plugin.askJson('Name the site', {
			model: 'flashnext',
			schema: z.object({ title: z.string() }),
			scope: SCOPE
		});

		expect(response.result).toEqual({ title: 'Ever Works' });
		expect(relay.requests[0]).toMatchObject({ userId: 'user-1', model: 'flashnext' });
		vi.unstubAllGlobals();
	});
});
