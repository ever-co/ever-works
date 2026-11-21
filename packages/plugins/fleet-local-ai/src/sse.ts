import type { FleetAiWireApi } from '@ever-works/contracts';

/**
 * A streamed answer, rebuilt from a complete one.
 *
 * A fleet completion carries ONE answer (the node never streams: a job has
 * one result), so a client that asked to stream — the AI SDK's `streamText`,
 * LangChain's `.stream()` — is answered with the event stream the server
 * would have sent, synthesised from the full answer: the same deltas, the
 * same tool calls, the same finish reason and usage, in one burst.
 *
 * ## The extension point
 *
 * One synthesiser per wire API ({@link SSE_SYNTHESISERS}). The Chat
 * Completions API is the one the platform's pipelines stream today; a client
 * that streams another API is told plainly to ask without `stream`, and
 * supporting it is one entry here.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function event(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * The Chat Completions stream for a `chat.completion` body: per choice, the
 * role (with any reasoning the model returned), the content, every tool call
 * whole (id, name and complete arguments in one delta), then the finish
 * reason; then the usage chunk (`choices: []`, as `stream_options.include_usage`
 * sends it); then `[DONE]`.
 */
export function synthesiseChatCompletionStream(body: unknown): string {
	const answer = isObject(body) ? body : {};
	const id = typeof answer.id === 'string' ? answer.id : 'chatcmpl-fleet-local-ai';
	const created = typeof answer.created === 'number' ? answer.created : Math.floor(Date.now() / 1000);
	const model = typeof answer.model === 'string' ? answer.model : '';
	const chunk = (choices: unknown[], extra: Json = {}): string =>
		event({ id, object: 'chat.completion.chunk', created, model, choices, ...extra });

	let out = '';
	const choices = Array.isArray(answer.choices) ? answer.choices : [];
	for (const [position, raw] of choices.entries()) {
		const choice = isObject(raw) ? raw : {};
		const index = typeof choice.index === 'number' ? choice.index : position;
		const message = isObject(choice.message) ? choice.message : {};

		const opening: Json = { role: typeof message.role === 'string' ? message.role : 'assistant' };
		// Reasoning models (llama-server, vLLM, LM Studio) return it beside the
		// content; both spellings are passed through as the stream would carry them.
		for (const key of ['reasoning_content', 'reasoning']) {
			if (typeof message[key] === 'string' && message[key]) opening[key] = message[key];
		}
		out += chunk([{ index, delta: opening, finish_reason: null }]);

		if (typeof message.content === 'string' && message.content.length > 0) {
			out += chunk([{ index, delta: { content: message.content }, finish_reason: null }]);
		}

		const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
		const deltas = toolCalls.filter(isObject).map((call, callIndex) => {
			const fn = isObject(call.function) ? call.function : {};
			return {
				index: callIndex,
				id: typeof call.id === 'string' ? call.id : `call_${index}_${callIndex}`,
				type: 'function',
				function: {
					name: typeof fn.name === 'string' ? fn.name : '',
					arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
				}
			};
		});
		if (deltas.length > 0) {
			out += chunk([{ index, delta: { tool_calls: deltas }, finish_reason: null }]);
		}

		const finish =
			typeof choice.finish_reason === 'string' ? choice.finish_reason : deltas.length > 0 ? 'tool_calls' : 'stop';
		out += chunk([{ index, delta: {}, finish_reason: finish }]);
	}
	if (isObject(answer.usage)) out += chunk([], { usage: answer.usage });
	return `${out}data: [DONE]\n\n`;
}

/** The wire APIs a streamed request can be answered for, and how. */
export const SSE_SYNTHESISERS: Readonly<Partial<Record<FleetAiWireApi, (body: unknown) => string>>> = Object.freeze({
	'openai-chat': synthesiseChatCompletionStream
});
