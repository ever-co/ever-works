import type { FleetAiCompletionFailure, FleetAiCompletionUsage, FleetAiWireApi } from '@ever-works/contracts';

/**
 * The LOCAL AI RELAY — the platform service a plugin reaches the model
 * servers on the caller's OWN machines through (`PluginContext.services.localAi`).
 *
 * The platform implements it over the fleet: a request becomes an
 * `ai-completion` job offered only to the caller's online nodes that serve the
 * model, one of them sends it to a healthy local provider (llama-swap,
 * Ollama, LM Studio, vLLM, …) and the provider's answer comes back. A plugin
 * sees none of that — it hands over a wire request and gets the wire answer,
 * so tools, JSON mode and structured output work exactly as they do against
 * the server itself, and a new provider kind or wire API on the nodes needs
 * nothing from the plugin.
 *
 * Absent when the process cannot reach the fleet (a CLI, a test): a plugin
 * that needs it says so instead of guessing.
 *
 * Both methods resolve; an expected failure is a value
 * ({@link LocalAiRelayFailure}), never a throw — the outcome crosses a process
 * boundary in the Trigger.dev worker, where an error's class does not survive.
 */
export interface LocalAiRelayServiceRef {
	/** The models the caller's online nodes serve completions for, best first. */
	listModels(scope: LocalAiRelayScope): Promise<readonly LocalAiRelayModel[]>;
	/** Send ONE request and wait (bounded) for the answer. */
	complete(request: LocalAiRelayRequest): Promise<LocalAiRelayOutcome>;
}

/** Whose machines: the user the call is made for. */
export interface LocalAiRelayScope {
	readonly userId: string;
}

/** One model, as the caller's nodes advertise it. */
export interface LocalAiRelayModel {
	/** The id to request it by (the node's `local-model:` tag value). */
	readonly id: string;
	/** How many online nodes serve it right now. */
	readonly nodes: number;
}

export interface LocalAiRelayRequest extends LocalAiRelayScope {
	/** The Work the call is made for (attribution only). */
	readonly workId?: string;
	readonly api: FleetAiWireApi;
	/** A model id from {@link LocalAiRelayServiceRef.listModels} (or the exact id a node serves). */
	readonly model: string;
	/** The request body as a client would POST it; `stream` is ignored (one answer comes back). */
	readonly body: Record<string, unknown>;
	/** The whole wait, queueing included; the platform clamps it. */
	readonly timeoutMs?: number;
	/** Cancels the wait AND the job (best-effort on a node already running it). */
	readonly signal?: AbortSignal;
}

/** The provider's answer, as it gave it. */
export interface LocalAiRelaySuccess {
	readonly ok: true;
	/** The provider's HTTP status — an error status is an answer too. */
	readonly status: number;
	/** The provider's response body (JSON). */
	readonly body: unknown;
	/** The id the provider served the request under. */
	readonly model: string;
	/** The node provider kind that answered (`llama-swap`, `ollama`, …). */
	readonly providerKind: string;
	/** The node's own time on the request, ms. */
	readonly latencyMs: number;
	readonly usage: FleetAiCompletionUsage | null;
}

/** No answer, and why (`no-node`, `timeout`, `cancelled`, …). */
export interface LocalAiRelayFailure {
	readonly ok: false;
	readonly code: FleetAiCompletionFailure;
	/** One sentence a person can act on; never a prompt, an answer or a key. */
	readonly message: string;
}

export type LocalAiRelayOutcome = LocalAiRelaySuccess | LocalAiRelayFailure;
