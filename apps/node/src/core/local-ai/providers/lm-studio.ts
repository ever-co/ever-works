import type { LocalAiModelInfo, LocalAiProviderDefinition } from '../types';
import { LocalAiHttpError } from '../http';
import { parseOpenAiModelList, positiveInteger } from './openai-compatible';

/**
 * `lm-studio` — LM Studio's local server. Matches the platform's `lm-studio`
 * AI-provider plugin id.
 *
 * Reads LM Studio's REST model list, `GET /api/v0/models`, which (unlike the
 * OpenAI one) says each model's `type` — embedding models are not offered to
 * an agent — whether it is `loaded`, and its context length. A server too old
 * or too new to have that endpoint (404) falls back to `GET /v1/models`.
 *
 * Default wire APIs: Chat Completions, Responses and (LM Studio 0.4+) the
 * Anthropic Messages API. An older LM Studio: declare `apis`.
 */
export const lmStudioProvider: LocalAiProviderDefinition = {
	kind: 'lm-studio',
	displayName: 'LM Studio',
	description: 'LM Studio local server; probes GET /api/v0/models (falls back to /v1/models).',
	defaultBaseUrl: 'http://127.0.0.1:1234',
	defaultApis: ['openai-chat', 'openai-responses', 'anthropic-messages'],
	probe: async (context) => {
		let json: unknown;
		try {
			json = await context.getJson('/api/v0/models');
		} catch (error) {
			if (!(error instanceof LocalAiHttpError) || error.status !== 404) throw error;
			return { models: parseOpenAiModelList(await context.getJson('/v1/models')) };
		}
		return { models: parseLmStudioModels(json) };
	}
};

/** `GET /api/v0/models` → models, embedding models left out. */
export function parseLmStudioModels(json: unknown): LocalAiModelInfo[] {
	return parseOpenAiModelList(json, (entry) => {
		if (entry.type === 'embeddings') return null;
		const info: Partial<LocalAiModelInfo> = {};
		if (entry.state === 'loaded') info.loaded = true;
		else if (entry.state === 'not-loaded') info.loaded = false;
		const context = positiveInteger(entry.max_context_length);
		if (context !== undefined) info.contextLength = context;
		return info;
	});
}
