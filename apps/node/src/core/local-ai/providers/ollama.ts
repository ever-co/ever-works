import type { LocalAiModelInfo, LocalAiProviderDefinition } from '../types';
import { isUsableLocalModelId, LOCAL_AI_MAX_MODELS } from './openai-compatible';

/**
 * `ollama` — Ollama (ollama.com). Matches the platform's `ollama` AI-provider
 * plugin id.
 *
 * Reads Ollama's NATIVE model list, `GET /api/tags` (every pulled model, as
 * `name:tag`), plus two best-effort extras: `GET /api/ps` for what is loaded
 * and `GET /api/version`. None of them loads a model.
 *
 * Default wire APIs: Ollama serves the OpenAI Chat Completions and Responses
 * APIs under `/v1` and, since 0.14, the Anthropic Messages API at
 * `/v1/messages` — so Claude Code and Codex can both be pointed at it. An
 * older Ollama: declare `apis`.
 *
 * Keyless by default. A key, when configured, is sent as a Bearer token —
 * for an Ollama behind an authenticating proxy.
 */
export const ollamaProvider: LocalAiProviderDefinition = {
	kind: 'ollama',
	displayName: 'Ollama',
	description: 'Ollama; probes GET /api/tags (models), /api/ps (loaded) and /api/version.',
	defaultBaseUrl: 'http://127.0.0.1:11434',
	defaultApis: ['openai-chat', 'openai-responses', 'anthropic-messages'],
	probe: async (context) => {
		const models = parseOllamaTags(await context.getJson('/api/tags'));
		const [loaded, version] = await Promise.all([
			context.getJson('/api/ps').then(parseOllamaRunning, () => null),
			context.getJson('/api/version').then(
				(json) => {
					const value =
						json && typeof json === 'object' ? (json as { version?: unknown }).version : undefined;
					return typeof value === 'string' && value.length <= 64 ? value : null;
				},
				() => null
			)
		]);
		if (loaded) {
			for (const model of models) model.loaded = loaded.has(model.id);
		}
		return { models, version };
	}
};

/** `GET /api/tags` → models. Throws when the body is not Ollama's `{ models: [...] }`. */
export function parseOllamaTags(json: unknown): LocalAiModelInfo[] {
	const list = json && typeof json === 'object' ? (json as { models?: unknown }).models : undefined;
	if (!Array.isArray(list)) throw new Error('the model list is not an Ollama { models: [...] } document');
	const models: LocalAiModelInfo[] = [];
	const seen = new Set<string>();
	for (const raw of list) {
		if (models.length >= LOCAL_AI_MAX_MODELS) break;
		const id = ollamaModelId(raw);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		models.push({ id });
	}
	return models;
}

function parseOllamaRunning(json: unknown): Set<string> | null {
	const list = json && typeof json === 'object' ? (json as { models?: unknown }).models : undefined;
	if (!Array.isArray(list)) return null;
	const ids = new Set<string>();
	for (const raw of list) {
		const id = ollamaModelId(raw);
		if (id) ids.add(id);
	}
	return ids;
}

/** Ollama names a model in both `model` and `name`; `model` is the one its APIs accept. */
function ollamaModelId(raw: unknown): string | null {
	if (!raw || typeof raw !== 'object') return null;
	const { model, name } = raw as { model?: unknown; name?: unknown };
	if (isUsableLocalModelId(model)) return model;
	if (isUsableLocalModelId(name)) return name;
	return null;
}
