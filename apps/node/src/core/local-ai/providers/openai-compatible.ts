import { FLEET_AGENT_EXECUTION_MODEL_PATTERN } from '@ever-works/contracts';
import type { LocalAiModelInfo, LocalAiProbeContext, LocalAiProviderDefinition } from '../types';

/** Most models one probe keeps. A real local server serves a handful; the cap bounds a hostile list. */
export const LOCAL_AI_MAX_MODELS = 256;

/**
 * A model id a run could actually be started with: the SAME opaque-id rule the
 * fleet applies to `--model` (it reaches a command line). Anything else a
 * server lists is not offered.
 */
export function isUsableLocalModelId(value: unknown): value is string {
	return typeof value === 'string' && FLEET_AGENT_EXECUTION_MODEL_PATTERN.test(value);
}

/** Read a finite, positive integer field, or undefined. */
export function positiveInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Parse an OpenAI `GET /v1/models` answer (`{ object: 'list', data: [{ id }] }`).
 *
 * `extra` lets a kind read its own per-entry fields (vLLM's `max_model_len`,
 * LM Studio's `state`) without re-implementing the list walk. An entry with no
 * usable id is skipped; a body that is not a model list at all THROWS, because
 * a server that answers 200 with something else is not the server the operator
 * configured.
 */
export function parseOpenAiModelList(
	json: unknown,
	extra?: (entry: Record<string, unknown>) => Partial<LocalAiModelInfo> | null
): LocalAiModelInfo[] {
	const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
	if (!Array.isArray(data)) {
		throw new Error('the model list is not an OpenAI-style { data: [...] } document');
	}
	const models: LocalAiModelInfo[] = [];
	const seen = new Set<string>();
	for (const raw of data) {
		if (models.length >= LOCAL_AI_MAX_MODELS) break;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		if (!isUsableLocalModelId(entry.id) || seen.has(entry.id)) continue;
		const more = extra ? extra(entry) : {};
		if (more === null) continue;
		seen.add(entry.id);
		models.push({ id: entry.id, ...more });
	}
	return models;
}

/** The shared probe: the OpenAI model list at `<root>/v1/models`. */
export async function probeOpenAiModels(
	context: LocalAiProbeContext,
	extra?: (entry: Record<string, unknown>) => Partial<LocalAiModelInfo> | null
): Promise<LocalAiModelInfo[]> {
	return parseOpenAiModelList(await context.getJson('/v1/models'), extra);
}

/**
 * `openai-compatible` — any server that answers the OpenAI API: LiteLLM,
 * llama.cpp's `llama-server`, LocalAI, TabbyAPI, a gateway of your own.
 *
 * The generic kind, and the base the specific ones extend. It promises only
 * what its name does — the Chat Completions API — so an operator whose server
 * also speaks the Responses or Anthropic Messages API declares that with
 * `apis`.
 */
export const openAiCompatibleProvider: LocalAiProviderDefinition = {
	kind: 'openai-compatible',
	displayName: 'OpenAI-compatible server',
	description: 'Any server that speaks the OpenAI API; probes GET /v1/models.',
	defaultApis: ['openai-chat'],
	probe: async (context) => ({ models: await probeOpenAiModels(context) })
};
