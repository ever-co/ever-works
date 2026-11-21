import type { FleetAgentExecutionProvider } from '@ever-works/contracts';

/**
 * Local AI on fleet nodes — the shared vocabulary.
 *
 * A LOCAL AI PROVIDER is a model server the machine's operator runs on (or
 * next to) the node: llama-swap, Ollama, LM Studio, vLLM, or anything that
 * speaks the OpenAI API. The node does three things with one:
 *
 *   1. probes it (health, which models it serves) on an interval, time-bounded
 *      and cached, so the heartbeat can advertise what is really there;
 *   2. advertises it as capability tags (`local-ai`, `local-ai:<kind>`,
 *      `local-model:<id>`, `local-agent:<cli>`), so the platform can route
 *      work to the machines that have it;
 *   3. when the operator binds an agent CLI to it (`agentRuntime`), runs that
 *      CLI's Tasks on the local model instead of the cloud seat — the env
 *      overlay, the model, a `0` cost marked `costBasis: 'local'`;
 *   4. under `--work`, serves the PLATFORM's own model requests on it
 *      (`ai-completion` jobs, the local-AI lane — `completion-lane.ts`): one
 *      request body in, the provider's answer out, so a Work generation runs
 *      on the owner's own GPU for free.
 *
 * ## The extension point
 *
 * Every provider KIND is one {@link LocalAiProviderDefinition}: a kind id, a
 * default address, the wire APIs it is documented to speak, and a `probe`
 * that reads its model list. Adding a kind is one file under `providers/`
 * plus one line in `providers/index.ts`; nothing else in the node changes.
 * The definitions never touch the network at import time, never see the
 * secret except through the probe context's own authenticated request, and
 * never decide anything about the agent CLIs — that lives in
 * `agent-binding.ts`, keyed by the wire API a CLI needs.
 */

/**
 * The wire APIs an agent CLI can be pointed at.
 *
 *   - `openai-chat`         — `POST /v1/chat/completions`
 *   - `openai-responses`    — `POST /v1/responses` (what Codex speaks)
 *   - `anthropic-messages`  — `POST /v1/messages` (what Claude Code speaks)
 */
export type LocalAiWireApi = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export const LOCAL_AI_WIRE_APIS: readonly LocalAiWireApi[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];

export function isLocalAiWireApi(value: unknown): value is LocalAiWireApi {
	return typeof value === 'string' && (LOCAL_AI_WIRE_APIS as readonly string[]).includes(value);
}

/** Where a provider's API key lives. Never the key itself: a file path or an env var NAME. */
export type LocalAiApiKeyRef = { source: 'file'; path: string } | { source: 'env'; name: string };

/** One provider as the operator configured it — validated, normalised, and holding no secret. */
export interface LocalAiProviderSettings {
	/** Operator-chosen id (`gpu`, `ollama`), `[a-z0-9][a-z0-9_-]{0,31}`; the kind when not given. */
	id: string;
	/** A kind registered in the {@link LocalAiProviderDefinition} registry. */
	kind: string;
	/**
	 * The server ROOT, no trailing slash and no `/v1`: `http://192.168.1.69:8000`.
	 * Never carries a credential — a URL with `user:password@` is refused.
	 */
	baseUrl: string;
	/** Where the API key is read from at use time, or null for a keyless server. */
	apiKey: LocalAiApiKeyRef | null;
	/** Models the operator declared (an allow-list for tags and the default pick); empty = what the server lists. */
	models: string[];
	/** The model a bound agent CLI uses when its `agentRuntime` names none. */
	defaultModel: string | null;
	/** The wire APIs this provider speaks: declared by the operator, else the kind's documented set. */
	apis: LocalAiWireApi[];
	/** True when {@link apis} came from the operator rather than the kind's defaults. */
	apisDeclared: boolean;
}

/** "Run this agent CLI's Tasks on that local provider" (`localAi.agentRuntime`). */
export interface LocalAiAgentRuntimeSettings {
	cli: FleetAgentExecutionProvider;
	/** A provider id. May name a provider that failed validation: the binding then fails CLOSED. */
	provider: string;
	/** The model for every run; absent → the provider's `defaultModel`, else its only model. */
	model: string | null;
	/** Claude Code's small/fast model (summaries, compaction); absent → {@link model}. */
	smallModel: string | null;
}

/**
 * Serving the platform's own model requests (`ai-completion` jobs) — the
 * local-AI lane (`localAi.completions`, `EVER_WORKS_NODE_LOCAL_AI_COMPLETIONS*`).
 */
export interface LocalAiCompletionSettings {
	/**
	 * On by default once a provider is configured: the lane still runs only
	 * under `--work`, and only the owner's own requests ever reach it.
	 */
	enabled: boolean;
	/** Completions in flight at once — the GPU's share of this node (default 1). */
	concurrency: number;
	/** Ceiling on the budget a request may ask for; the node never waits longer on a provider. */
	maxTimeoutMs: number;
	/** How often an idle lane asks for a completion (a lane that just served one asks every second). */
	idlePollMs: number;
}

/** Everything the node runs local AI from, resolved from the config file and the environment. */
export interface LocalAiSettings {
	providers: LocalAiProviderSettings[];
	agentRuntimes: LocalAiAgentRuntimeSettings[];
	/** How long a probe answer stays fresh. */
	probeIntervalMs: number;
	/** Wall-clock budget of ONE probe of one provider (all of its requests together). */
	probeTimeoutMs: number;
	/**
	 * Serving `ai-completion` jobs. Optional so a settings object built by hand
	 * (an embedder, an older test) keeps compiling; absent reads as the
	 * defaults (`resolveLocalAiCompletionSettings`).
	 */
	completions?: LocalAiCompletionSettings;
}

/** One model a provider serves, as its own list reported it. */
export interface LocalAiModelInfo {
	id: string;
	/** True when the server said the model is loaded in memory right now (when it says). */
	loaded?: boolean;
	/** The context window the server reported, in tokens (when it says). */
	contextLength?: number;
}

/** What a definition's probe returns on success. A probe that fails THROWS. */
export interface LocalAiProbeOutcome {
	models: LocalAiModelInfo[];
	/** The server's own version string, when it has an endpoint for it. */
	version?: string | null;
}

/** A provider's health as the node last saw it. Safe to print and to send: no URL credential, no key. */
export interface LocalAiProviderStatus {
	id: string;
	kind: string;
	/** `unknown` until the first probe finished. */
	status: 'up' | 'down' | 'unknown';
	checkedAt: string | null;
	latencyMs: number | null;
	models: LocalAiModelInfo[];
	version: string | null;
	/** Why it is down — one line, never a key, never a response body. */
	error: string | null;
	apis: LocalAiWireApi[];
}

/** What a definition's probe is handed. */
export interface LocalAiProbeContext {
	readonly provider: Readonly<LocalAiProviderSettings>;
	/**
	 * GET `path` (relative to the server root, e.g. `/v1/models`) and parse
	 * the body as JSON — with the provider's auth header, inside the probe's
	 * time budget, and refusing an oversized body. Throws a
	 * {@link LocalAiHttpError} for anything but a 2xx JSON answer.
	 */
	getJson(path: string): Promise<unknown>;
	readonly signal: AbortSignal;
}

/**
 * One provider KIND — the plugin interface (see the module comment).
 *
 * Implementations are plain objects: no constructor side effects, no network
 * at import time, no state. The registry hands them settings it already
 * validated; the probe gets its HTTP through {@link LocalAiProbeContext}, so a
 * definition can never send the key anywhere but its own server.
 */
export interface LocalAiProviderDefinition {
	/** Stable id used in config and tags (`llama-swap`). `[a-z0-9][a-z0-9-]{0,23}`. */
	readonly kind: string;
	/** Human name for `local-ai list` and the docs. */
	readonly displayName: string;
	/** One sentence: what the kind is and what its probe reads. */
	readonly description: string;
	/** The address a default install listens on, when there is one (Ollama: `http://127.0.0.1:11434`). */
	readonly defaultBaseUrl?: string;
	/**
	 * The wire APIs a current release of this server is documented to speak.
	 * The operator's `apis` replaces this list whenever it is given, so a kind
	 * never has to guess about an older or newer server.
	 */
	readonly defaultApis: readonly LocalAiWireApi[];
	/** Health + models. Throw (a {@link LocalAiHttpError} is ideal) when the server is not usable. */
	probe(context: LocalAiProbeContext): Promise<LocalAiProbeOutcome>;
	/**
	 * The base URL a client of `api` is pointed at. Optional: by default the
	 * OpenAI APIs live at `<root>/v1` and the Anthropic Messages API at
	 * `<root>` (Claude Code appends `/v1/messages` itself).
	 */
	endpoint?(provider: Readonly<LocalAiProviderSettings>, api: LocalAiWireApi): string;
}

/** A configuration the node cannot use as written. Its message names the key, never a secret. */
export class LocalAiConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LocalAiConfigError';
	}
}

/** The base URL a client of `api` uses on a provider (see {@link LocalAiProviderDefinition.endpoint}). */
export function defaultLocalAiEndpoint(baseUrl: string, api: LocalAiWireApi): string {
	return api === 'anthropic-messages' ? baseUrl : `${baseUrl}/v1`;
}
