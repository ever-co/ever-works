import { fleetLocalModelTagSlug } from '@ever-works/contracts';
import { resolveLocalAiEndpoint, servesModel } from './agent-binding';
import { isSameLocalAiOrigin } from './http';
import type { LocalAiProviderRegistry } from './registry';
import type { LocalAiProviderSettings, LocalAiProviderStatus, LocalAiSettings, LocalAiWireApi } from './types';

/**
 * Where an `ai-completion` goes on this node: which healthy provider, which of
 * its model ids, and the exact URL.
 *
 * ## The wire table (the extension point for wire APIs)
 *
 * Each wire API is ONE entry of {@link LOCAL_AI_COMPLETION_WIRES}: the path it
 * is POSTed to, relative to the endpoint a client of that API is pointed at
 * (`resolveLocalAiEndpoint` — `<root>/v1` for the OpenAI APIs, `<root>` for the
 * Anthropic one, or what a kind's `endpoint()` says), and any header the API
 * needs. A provider KIND needs nothing here: a new kind declares the APIs it
 * speaks, and its requests take the same path every other kind's do.
 *
 * ## Fails closed
 *
 * Only a provider whose last probe said `up`, that speaks the API, and that
 * serves the model — within the operator's own allow-list when one is
 * declared, exactly what the node advertises — is ever chosen, and the URL
 * must be on that provider's own origin (the key goes with it).
 */

export interface LocalAiCompletionWire {
	/** Appended to the provider's endpoint for this API. */
	readonly path: string;
	/** Headers the API needs besides the provider's own Authorization. */
	readonly headers?: Readonly<Record<string, string>>;
}

export const LOCAL_AI_COMPLETION_WIRES: Readonly<Record<LocalAiWireApi, LocalAiCompletionWire>> = Object.freeze({
	'openai-chat': { path: '/chat/completions' },
	'openai-responses': { path: '/responses' },
	// The endpoint is the server root (Claude Code appends `/v1/messages` itself).
	'anthropic-messages': { path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' } }
});

/** The provider, model id and URL a completion is sent to. */
export interface LocalAiCompletionTarget {
	provider: LocalAiProviderSettings;
	/** The id the provider serves — written into the request body. */
	modelId: string;
	url: string;
	headers: Record<string, string>;
}

export type LocalAiCompletionSelection = { ok: true; target: LocalAiCompletionTarget } | { ok: false; reason: string };

/**
 * The id `provider` serves for `model` — the platform names a model by its
 * `local-model:` tag VALUE (lossy) or by its exact id — or null. Exact ids win
 * (Ollama's implicit `:latest` counted), then the tag value. Restricted to the
 * operator's declared models when there are any: those are the ones this node
 * advertises.
 */
export function resolveServedModelId(
	provider: LocalAiProviderSettings,
	status: LocalAiProviderStatus,
	model: string
): string | null {
	const served = status.models.map((entry) => entry.id);
	const declared = [provider.defaultModel, ...provider.models].filter(
		(id): id is string => typeof id === 'string' && id.length > 0
	);
	const offered = provider.models.length > 0 ? served.filter((id) => declared.includes(id)) : served;
	if (offered.includes(model)) return model;
	if (servesModel(offered, model)) {
		if (offered.includes(`${model}:latest`)) return `${model}:latest`;
		if (model.endsWith(':latest')) return model.slice(0, -':latest'.length);
	}
	const slug = fleetLocalModelTagSlug(model);
	if (!slug) return null;
	return offered.find((id) => fleetLocalModelTagSlug(id) === slug) ?? null;
}

/**
 * Pick the provider for one completion from the statuses as last probed.
 * Among the providers that qualify, one that reports the model LOADED right
 * now wins (llama-swap's `/running`: no swap), then config order.
 */
export function selectLocalAiCompletionTarget(
	settings: LocalAiSettings,
	statuses: readonly LocalAiProviderStatus[],
	registry: LocalAiProviderRegistry,
	api: LocalAiWireApi,
	model: string
): LocalAiCompletionSelection {
	const up = settings.providers.filter(
		(provider) => statuses.find((status) => status.id === provider.id)?.status === 'up'
	);
	if (up.length === 0) return { ok: false, reason: 'no local AI provider on this node is up' };
	const speaking = up.filter((provider) => provider.apis.includes(api));
	if (speaking.length === 0) {
		return { ok: false, reason: `no healthy local AI provider on this node speaks ${api}` };
	}
	const candidates: Array<{ provider: LocalAiProviderSettings; modelId: string; loaded: boolean }> = [];
	for (const provider of speaking) {
		const status = statuses.find((entry) => entry.id === provider.id)!;
		const modelId = resolveServedModelId(provider, status, model);
		if (!modelId) continue;
		const loaded = status.models.find((entry) => entry.id === modelId)?.loaded === true;
		candidates.push({ provider, modelId, loaded });
	}
	if (candidates.length === 0) {
		return { ok: false, reason: `no healthy local AI provider on this node serves model "${model}" over ${api}` };
	}
	candidates.sort((a, b) => Number(b.loaded) - Number(a.loaded));
	const wire = LOCAL_AI_COMPLETION_WIRES[api];
	for (const { provider, modelId } of candidates) {
		const endpoint = resolveLocalAiEndpoint(registry, provider, api);
		if (!endpoint) continue;
		const url = `${endpoint}${wire.path}`;
		if (!isSameLocalAiOrigin(url, provider.baseUrl)) continue;
		return { ok: true, target: { provider, modelId, url, headers: { ...(wire.headers ?? {}) } } };
	}
	return {
		ok: false,
		reason: `every local AI provider that serves model "${model}" points ${api} away from its own address — refused`
	};
}
