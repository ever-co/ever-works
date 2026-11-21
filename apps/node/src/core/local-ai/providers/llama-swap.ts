import type { LocalAiProviderDefinition } from '../types';
import { isUsableLocalModelId, openAiCompatibleProvider, probeOpenAiModels } from './openai-compatible';

/**
 * `llama-swap` — a model-swapping proxy in front of `llama-server` (and other
 * OpenAI-compatible upstreams): one address, many models, the one asked for
 * is loaded on demand.
 *
 * Extends `openai-compatible`: health and models come from the SAME
 * `GET /v1/models` (llama-swap lists every model in its config there, and
 * answers it without loading one). On top of that it reads llama-swap's own
 * `GET /running`, best-effort, to mark which model is loaded right now — a
 * probe must never be what makes llama-swap swap, so nothing here sends a
 * completion.
 *
 * Default wire APIs: all three. llama-swap forwards `/v1/chat/completions`,
 * `/v1/responses` and `/v1/messages` to its upstream, and a current
 * `llama-server` answers all three; an operator whose upstream does not
 * declares `apis` (and `ever-works-node local-ai test` shows which work).
 */
export const llamaSwapProvider: LocalAiProviderDefinition = {
	...openAiCompatibleProvider,
	kind: 'llama-swap',
	displayName: 'llama-swap',
	description: 'llama-swap model-swapping proxy; probes GET /v1/models and GET /running.',
	defaultApis: ['openai-chat', 'openai-responses', 'anthropic-messages'],
	probe: async (context) => {
		const models = await probeOpenAiModels(context);
		const loaded = await readRunningModels(context.getJson.bind(context));
		if (loaded) {
			for (const model of models) model.loaded = loaded.has(model.id);
		}
		return { models };
	}
};

/** llama-swap's `GET /running` (`{ running: [{ model, state }] }`), or null when it cannot be read. */
async function readRunningModels(getJson: (path: string) => Promise<unknown>): Promise<Set<string> | null> {
	let json: unknown;
	try {
		json = await getJson('/running');
	} catch {
		return null;
	}
	const running = json && typeof json === 'object' ? (json as { running?: unknown }).running : undefined;
	if (!Array.isArray(running)) return null;
	const ids = new Set<string>();
	for (const entry of running) {
		if (!entry || typeof entry !== 'object') continue;
		const { model, state } = entry as { model?: unknown; state?: unknown };
		if (isUsableLocalModelId(model) && (state === undefined || state === 'ready')) ids.add(model);
	}
	return ids;
}
