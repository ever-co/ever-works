import { describe, expect, it } from 'vitest';
import { SSE_SYNTHESISERS, synthesiseChatCompletionStream } from '../sse';
import { chatCompletion } from './fake-relay';

/** The event stream rebuilt from a whole Chat Completions answer. */

function events(stream: string): unknown[] {
	return stream
		.split('\n\n')
		.filter((block) => block.startsWith('data: '))
		.map((block) => block.slice('data: '.length))
		.map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
}

describe('synthesiseChatCompletionStream', () => {
	it('emits the role with the reasoning, the content, the finish reason, the usage and [DONE]', () => {
		const stream = events(
			synthesiseChatCompletionStream(chatCompletion({ content: 'hello', reasoning_content: 'thinking' }))
		);
		expect(stream).toEqual([
			expect.objectContaining({
				object: 'chat.completion.chunk',
				id: 'chatcmpl-local-1',
				model: 'flashnext',
				choices: [
					{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking' }, finish_reason: null }
				]
			}),
			expect.objectContaining({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }),
			expect.objectContaining({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
			expect.objectContaining({
				choices: [],
				usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
			}),
			'[DONE]'
		]);
	});

	it('emits every tool call whole, with its id, name and complete arguments', () => {
		const stream = events(
			synthesiseChatCompletionStream(
				chatCompletion(
					{
						content: null,
						tool_calls: [
							{ id: 'a', type: 'function', function: { name: 'one', arguments: '{"x":1}' } },
							{ id: 'b', type: 'function', function: { name: 'two', arguments: { y: 2 } } }
						]
					},
					'tool_calls'
				)
			)
		);
		expect(stream[1]).toMatchObject({
			choices: [
				{
					delta: {
						tool_calls: [
							{ index: 0, id: 'a', type: 'function', function: { name: 'one', arguments: '{"x":1}' } },
							{ index: 1, id: 'b', type: 'function', function: { name: 'two', arguments: '{"y":2}' } }
						]
					}
				}
			]
		});
		expect(stream[2]).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] });
	});

	it('survives an answer that is not a completion (ends the stream cleanly)', () => {
		expect(events(synthesiseChatCompletionStream(null))).toEqual(['[DONE]']);
	});

	it('is the only streaming wire for now — the extension point names it', () => {
		expect(Object.keys(SSE_SYNTHESISERS)).toEqual(['openai-chat']);
	});
});
