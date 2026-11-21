import type { LocalAiModelInfo, LocalAiProviderDefinition } from '../types';
import { parseOpenAiModelList, positiveInteger } from './openai-compatible';

/**
 * `vllm` — a vLLM OpenAI-compatible server (`vllm serve <model>`). Matches the
 * platform's `vllm` AI-provider plugin id.
 *
 * Models from `GET /v1/models`, whose entries carry vLLM's own
 * `max_model_len` (kept as the context length); the version from
 * `GET /version`, best-effort. vLLM's `--api-key` is a Bearer token, as here.
 *
 * Default wire APIs: Chat Completions and Responses. A vLLM that also serves
 * the Anthropic Messages API (`/v1/messages`) is pointed at by Claude Code
 * once the operator adds `anthropic-messages` to `apis`.
 */
export const vllmProvider: LocalAiProviderDefinition = {
	kind: 'vllm',
	displayName: 'vLLM',
	description: 'vLLM OpenAI-compatible server; probes GET /v1/models and /version.',
	defaultBaseUrl: 'http://127.0.0.1:8000',
	defaultApis: ['openai-chat', 'openai-responses'],
	probe: async (context) => {
		const [models, version] = await Promise.all([
			context.getJson('/v1/models').then(parseVllmModels),
			context.getJson('/version').then(
				(json) => {
					const value =
						json && typeof json === 'object' ? (json as { version?: unknown }).version : undefined;
					return typeof value === 'string' && value.length <= 64 ? value : null;
				},
				() => null
			)
		]);
		return { models, version };
	}
};

/** vLLM's `GET /v1/models` → models with their context length. */
export function parseVllmModels(json: unknown): LocalAiModelInfo[] {
	return parseOpenAiModelList(json, (entry) => {
		const context = positiveInteger(entry.max_model_len);
		return context === undefined ? {} : { contextLength: context };
	});
}
