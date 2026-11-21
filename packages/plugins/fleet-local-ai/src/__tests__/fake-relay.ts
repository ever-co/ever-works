import { vi } from 'vitest';
import type { LocalAiRelayOutcome, LocalAiRelayRequest, LocalAiRelayServiceRef } from '@ever-works/plugin';

/**
 * A fake of the platform's local AI relay: records every request (as the
 * relay would receive it) and answers from a script — a provider body, or a
 * relay failure.
 */
export function fakeRelay(
	answer: (request: LocalAiRelayRequest) => LocalAiRelayOutcome | Promise<LocalAiRelayOutcome>,
	models: Array<{ id: string; nodes: number }> = [{ id: 'flashnext', nodes: 1 }]
): LocalAiRelayServiceRef & { requests: LocalAiRelayRequest[] } {
	const requests: LocalAiRelayRequest[] = [];
	return {
		requests,
		listModels: vi.fn(async () => models),
		complete: vi.fn(async (request: LocalAiRelayRequest) => {
			requests.push(request);
			return answer(request);
		})
	};
}

/** A provider's 200 answer, the way the relay hands it back. */
export function answered(body: unknown, status = 200): LocalAiRelayOutcome {
	return { ok: true, status, body, model: 'flashnext', providerKind: 'llama-swap', latencyMs: 42, usage: null };
}

/** An OpenAI `chat.completion` body. */
export function chatCompletion(message: Record<string, unknown>, finishReason = 'stop') {
	return {
		id: 'chatcmpl-local-1',
		object: 'chat.completion',
		created: 1_763_000_000,
		model: 'flashnext',
		choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
		usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
	};
}
