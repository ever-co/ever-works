import {
	FLEET_AGENT_EXECUTION_MODEL_PATTERN,
	FLEET_LOCAL_AI_CAPABILITY,
	FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY,
	FLEET_LOCAL_MODEL_CAPABILITY_PREFIX,
	type FleetJobKind
} from './fleet-jobs.types.js';
import type { FleetConsentKey } from './fleet-link.types.js';
import { FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH } from './fleet-node.types.js';

/**
 * Local AI completions on fleet nodes — the `ai-completion` job.
 *
 * A node whose operator runs a model server on (or next to) the machine
 * (llama-swap, Ollama, LM Studio, vLLM, any OpenAI-compatible server) already
 * advertises it (`local-ai`, `local-model:<id>`). This job lets the PLATFORM
 * use it: ONE model request — the body a client would POST to the server —
 * travels to one of the owner's nodes as a job payload, the node sends it to a
 * healthy provider that serves the model, and the provider's answer comes back
 * as the job result. That is how a Work generation runs on the owner's own GPU
 * for free.
 *
 * ## Why a request body, not a prompt
 *
 * The payload is the wire request itself (`api` says which wire), so tools,
 * JSON mode, structured output and reasoning settings behave exactly as they
 * do against the server directly, and a future provider kind or wire API needs
 * no change to the job. `stream` is forced off: a job carries one answer, and
 * a client that asked to stream is answered by its own transport (the platform
 * plugin synthesises the event stream from the full answer).
 *
 * ## Bounds
 *
 * Bodies travel gzip-compressed and base64-encoded, so a long context fits the
 * job's {@link FLEET_JOB_MAX_PAYLOAD_BYTES} cap; both the encoded size and the
 * decoded size are bounded, in both directions, and both are checked by the
 * sender AND the receiver.
 *
 * ## Routing
 *
 * A completion requires `local-ai`, `local-ai-completions` and the model's own
 * `local-model:<slug>` tag ({@link fleetAiCompletionRequiredCapabilities}), so
 * it is only ever offered to a node that serves completions AND reported the
 * model on a healthy provider — never to a machine without local AI. The
 * platform knows a model by its tag VALUE (the slug); the node maps it back to
 * the id its provider serves.
 *
 * This module is the zero-dependency wire shape only: compression lives with
 * the producers (the platform service, the node executor), which run on Node.
 */

/** The job kind, named once. */
export const FLEET_AI_COMPLETION_JOB_KIND = 'ai-completion' satisfies FleetJobKind;

/**
 * The node lane that leases `ai-completion`: the LOCAL-AI lane, a lease loop of
 * its own beside the work lane (its own concurrency, so a GPU node serves
 * completions without taking an Agent's slot, and the work lane never leases
 * this kind).
 */
export const FLEET_LOCAL_AI_LANE_KINDS: readonly FleetJobKind[] = [FLEET_AI_COMPLETION_JOB_KIND];

/** The consent the local-AI lane needs: lending this machine for work (`--work`). */
export const FLEET_LOCAL_AI_LANE_CONSENT: FleetConsentKey = 'work';

// ─── Wire APIs ──────────────────────────────────────────────────────────────

/**
 * The wire API a completion body speaks — the same vocabulary the node's local
 * AI providers declare (`apis`):
 *
 *   - `openai-chat`        — `POST /v1/chat/completions`
 *   - `openai-responses`   — `POST /v1/responses`
 *   - `anthropic-messages` — `POST /v1/messages`
 */
export type FleetAiWireApi = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export const FLEET_AI_WIRE_APIS: readonly FleetAiWireApi[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];

export function isFleetAiWireApi(value: unknown): value is FleetAiWireApi {
	return typeof value === 'string' && (FLEET_AI_WIRE_APIS as readonly string[]).includes(value);
}

/**
 * The path suffix a client POSTs each wire API to, matched against the END of
 * a request path (a client may put its base URL anywhere: `…/v1`, `…/api/v1`).
 */
export const FLEET_AI_WIRE_API_PATH_SUFFIXES: Readonly<Record<FleetAiWireApi, string>> = Object.freeze({
	'openai-chat': '/chat/completions',
	'openai-responses': '/responses',
	'anthropic-messages': '/messages'
});

/** The wire API a client request path addresses, or null for any other path. */
export function fleetAiWireApiForPath(pathname: string): FleetAiWireApi | null {
	if (typeof pathname !== 'string') return null;
	const path = pathname.replace(/\/+$/, '');
	for (const api of FLEET_AI_WIRE_APIS) {
		if (path.endsWith(FLEET_AI_WIRE_API_PATH_SUFFIXES[api])) return api;
	}
	return null;
}

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** How a body is carried: plain JSON text, or gzip-compressed then base64-encoded. */
export type FleetAiCompletionBodyEncoding = 'json' | 'gzip-base64';

export const FLEET_AI_COMPLETION_BODY_ENCODINGS: readonly FleetAiCompletionBodyEncoding[] = ['json', 'gzip-base64'];

/** Largest request body (as JSON text, decoded) one completion carries. */
export const FLEET_AI_COMPLETION_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Largest response body (as JSON text, decoded) one completion carries back. */
export const FLEET_AI_COMPLETION_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Largest ENCODED body, either direction. Leaves headroom under the job's
 * 256 KiB payload and result caps for the fields around it.
 */
export const FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES = 200 * 1024;

/** Budget the node gives the provider for one answer, when the caller names none. */
export const FLEET_AI_COMPLETION_DEFAULT_TIMEOUT_SEC = 600;
export const FLEET_AI_COMPLETION_MIN_TIMEOUT_SEC = 10;
export const FLEET_AI_COMPLETION_MAX_TIMEOUT_SEC = 1800;

/** Most conversation entries (`messages` / `input`) one request may carry. */
export const FLEET_AI_COMPLETION_MAX_MESSAGES = 4096;
/** Most tool definitions one request may carry. */
export const FLEET_AI_COMPLETION_MAX_TOOLS = 256;

/** Clamp a caller's provider budget into the supported range (seconds). Nonsense → the default. */
export function clampFleetAiCompletionTimeoutSec(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return FLEET_AI_COMPLETION_DEFAULT_TIMEOUT_SEC;
	}
	return Math.min(
		Math.max(Math.round(value), FLEET_AI_COMPLETION_MIN_TIMEOUT_SEC),
		FLEET_AI_COMPLETION_MAX_TIMEOUT_SEC
	);
}

// ─── Model tags ─────────────────────────────────────────────────────────────

const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)*$/;

/**
 * A model id as a `local-model:` tag VALUE — THE normalisation the node's
 * heartbeat applies (`localModelTagSlug` on the node delegates here):
 * lower-cased, every character outside the tag grammar (`:` and `/` of
 * `qwen3:8b`, `org/model`) folded to `-`, runs of `-` collapsed, separators
 * trimmed from both ends. Null when the resulting tag would not fit
 * {@link FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH}. Lossy on purpose — the tag
 * is a routing hint; the exact id lives in the request the node serves.
 */
export function fleetLocalModelTagSlug(modelId: string): string | null {
	if (typeof modelId !== 'string') return null;
	const folded = modelId
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/-{2,}/g, '-');
	// Trimmed by index, not by an end-anchored regex: the id can come from a
	// server's model list, and `[-._]+$` is quadratic on a long run of them.
	const edge = (char: string | undefined): boolean => char === '-' || char === '.' || char === '_';
	let start = 0;
	let end = folded.length;
	while (start < end && edge(folded[start])) start += 1;
	while (end > start && edge(folded[end - 1])) end -= 1;
	const slug = folded.slice(start, end);
	if (!slug) return null;
	const tag = `${FLEET_LOCAL_MODEL_CAPABILITY_PREFIX}${slug}`;
	return tag.length <= FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH && TAG_PATTERN.test(tag) ? slug : null;
}

/** The `local-model:<slug>` tag for a model id, or null when it cannot be one. */
export function fleetLocalModelCapability(modelId: string): string | null {
	const slug = fleetLocalModelTagSlug(modelId);
	return slug ? `${FLEET_LOCAL_MODEL_CAPABILITY_PREFIX}${slug}` : null;
}

/** The model slug a `local-model:<slug>` tag names, or null for any other tag. */
export function fleetLocalModelFromCapability(tag: unknown): string | null {
	if (typeof tag !== 'string' || !tag.startsWith(FLEET_LOCAL_MODEL_CAPABILITY_PREFIX)) return null;
	const slug = tag.slice(FLEET_LOCAL_MODEL_CAPABILITY_PREFIX.length);
	return slug && fleetLocalModelTagSlug(slug) === slug ? slug : null;
}

/**
 * The tags an `ai-completion` for `model` requires, or null when the model's
 * tag cannot be formed (no node could ever advertise it, so the job could
 * never be leased — refuse it instead of queueing it).
 */
export function fleetAiCompletionRequiredCapabilities(model: string): string[] | null {
	const modelTag = fleetLocalModelCapability(model);
	return modelTag ? [FLEET_LOCAL_AI_CAPABILITY, FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY, modelTag] : null;
}

/** A model id the relay accepts: the fleet's opaque-id rule (no spaces, no shell structure). */
export function isFleetAiCompletionModelId(value: unknown): value is string {
	return typeof value === 'string' && FLEET_AGENT_EXECUTION_MODEL_PATTERN.test(value);
}

// ─── Payload ────────────────────────────────────────────────────────────────

/** Executor input of an `ai-completion` job. */
export interface FleetAiCompletionPayload {
	api: FleetAiWireApi;
	/**
	 * The model as the platform names it: a `local-model:` tag value (what a
	 * node advertised) or the exact id. The node resolves it to the id a
	 * healthy provider serves and writes that into the body.
	 */
	model: string;
	/** The request body (see {@link validateFleetAiCompletionRequestBody}), encoded per {@link bodyEncoding}. */
	body: string;
	bodyEncoding: FleetAiCompletionBodyEncoding;
	/** The provider's budget for the answer, seconds ({@link clampFleetAiCompletionTimeoutSec}). */
	timeoutSec: number;
}

/**
 * A parse outcome. Both arms name both fields (one of them `undefined`), so a
 * consumer compiled WITHOUT `strictNullChecks` — which does not narrow on `ok` —
 * still reads `reason` / `value` type-safely.
 */
export type FleetAiCompletionParse<T> =
	| { ok: true; value: T; reason?: undefined }
	| { ok: false; reason: string; value?: undefined };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readEncodedBody(
	raw: Record<string, unknown>
): FleetAiCompletionParse<{ body: string; bodyEncoding: FleetAiCompletionBodyEncoding }> {
	const encoding = raw.bodyEncoding;
	if (typeof encoding !== 'string' || !(FLEET_AI_COMPLETION_BODY_ENCODINGS as readonly string[]).includes(encoding)) {
		return { ok: false, reason: 'bodyEncoding must be json or gzip-base64' };
	}
	if (typeof raw.body !== 'string' || raw.body.length === 0) {
		return { ok: false, reason: 'body must be a non-empty string' };
	}
	if (raw.body.length > FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES) {
		return { ok: false, reason: `body is larger than ${FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES} bytes encoded` };
	}
	if (encoding === 'gzip-base64' && !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.body)) {
		return { ok: false, reason: 'body is not base64' };
	}
	return { ok: true, value: { body: raw.body, bodyEncoding: encoding as FleetAiCompletionBodyEncoding } };
}

/**
 * Validate an `ai-completion` payload's SHAPE (the node calls it on what it
 * leased, the platform on what it is about to enqueue). The body is checked
 * for size and encoding here; its JSON is checked, once decoded, by
 * {@link validateFleetAiCompletionRequestBody}.
 */
export function normalizeFleetAiCompletionPayload(raw: unknown): FleetAiCompletionParse<FleetAiCompletionPayload> {
	if (!isPlainObject(raw)) return { ok: false, reason: 'the payload is not an object' };
	if (!isFleetAiWireApi(raw.api)) {
		return { ok: false, reason: `api must be one of ${FLEET_AI_WIRE_APIS.join(', ')}` };
	}
	if (!isFleetAiCompletionModelId(raw.model)) return { ok: false, reason: 'model is not a model id' };
	const body = readEncodedBody(raw);
	if (!body.ok) return { ok: false, reason: body.reason ?? 'the body is not readable' };
	return {
		ok: true,
		value: {
			api: raw.api,
			model: raw.model,
			body: body.value.body,
			bodyEncoding: body.value.bodyEncoding,
			timeoutSec: clampFleetAiCompletionTimeoutSec(raw.timeoutSec)
		}
	};
}

/** Request members a relay never forwards: a job carries ONE answer, so streaming is the caller's transport's business. */
export const FLEET_AI_COMPLETION_STRIPPED_MEMBERS: readonly string[] = ['stream', 'stream_options'];

function boundedList(value: unknown, max: number, name: string, required: boolean): string | null {
	if (value === undefined && !required) return null;
	if (!Array.isArray(value)) return `${name} must be an array`;
	if (required && value.length === 0) return `${name} must not be empty`;
	if (value.length > max) return `${name} has more than ${max} entries`;
	return null;
}

/**
 * Validate one decoded request body for `api` and return the copy a node
 * forwards: a JSON object with the conversation member the wire API needs
 * (`messages` for the Chat Completions and Messages APIs, `input` for the
 * Responses API), bounded lists, and without {@link FLEET_AI_COMPLETION_STRIPPED_MEMBERS}.
 * `model` is optional here (the node writes the id it serves) but, when
 * present, must be a model id.
 */
export function validateFleetAiCompletionRequestBody(
	api: FleetAiWireApi,
	body: unknown
): FleetAiCompletionParse<Record<string, unknown>> {
	if (!isPlainObject(body)) return { ok: false, reason: 'the request body is not a JSON object' };
	if (body.model !== undefined && !isFleetAiCompletionModelId(body.model)) {
		return { ok: false, reason: 'the request names a model that is not a model id' };
	}
	let problem: string | null = null;
	if (api === 'openai-chat' || api === 'anthropic-messages') {
		problem = boundedList(body.messages, FLEET_AI_COMPLETION_MAX_MESSAGES, 'messages', true);
		if (!problem && !(body.messages as unknown[]).every((entry) => isPlainObject(entry))) {
			problem = 'every message must be an object';
		}
	} else if (typeof body.input !== 'string') {
		problem = boundedList(body.input, FLEET_AI_COMPLETION_MAX_MESSAGES, 'input', true);
	} else if (body.input.length === 0) {
		problem = 'input must not be empty';
	}
	if (!problem && api === 'anthropic-messages') {
		const maxTokens = body.max_tokens;
		if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
			problem = 'max_tokens must be a positive integer (the Messages API requires it)';
		}
	}
	if (!problem) problem = boundedList(body.tools, FLEET_AI_COMPLETION_MAX_TOOLS, 'tools', false);
	if (problem) return { ok: false, reason: problem };
	const forwarded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (!FLEET_AI_COMPLETION_STRIPPED_MEMBERS.includes(key)) forwarded[key] = value;
	}
	return { ok: true, value: forwarded };
}

// ─── Result ─────────────────────────────────────────────────────────────────

/** Token counts the provider reported, when it did (any of them may be absent). */
export interface FleetAiCompletionUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

/** What an `ai-completion` job completes with. */
export interface FleetAiCompletionResult {
	/** The provider's own HTTP status (an error status is an answer too: the provider refused the request). */
	status: number;
	/** The provider's response body, encoded per {@link bodyEncoding}. */
	body: string;
	bodyEncoding: FleetAiCompletionBodyEncoding;
	/** The node's provider id and kind that answered (`gpu`, `llama-swap`). */
	providerId: string;
	providerKind: string;
	/** The id the provider served the request under. */
	model: string;
	/** Wall-clock from the node sending the request to the provider's last byte. */
	latencyMs: number;
	usage: FleetAiCompletionUsage | null;
	/** Always 0 with `costBasis: 'local'`: the model ran on the owner's own hardware. */
	costUsd: 0;
	costBasis: 'local';
}

const PROVIDER_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function readCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** Validate what a node completed an `ai-completion` with (the platform's half of the contract). */
export function normalizeFleetAiCompletionResult(raw: unknown): FleetAiCompletionParse<FleetAiCompletionResult> {
	if (!isPlainObject(raw)) return { ok: false, reason: 'the result is not an object' };
	const status = raw.status;
	if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
		return { ok: false, reason: 'status is not an HTTP status' };
	}
	const body = readEncodedBody(raw);
	if (!body.ok) return { ok: false, reason: body.reason ?? 'the body is not readable' };
	if (typeof raw.providerId !== 'string' || !PROVIDER_LABEL_PATTERN.test(raw.providerId)) {
		return { ok: false, reason: 'providerId is not a provider id' };
	}
	if (typeof raw.providerKind !== 'string' || !PROVIDER_LABEL_PATTERN.test(raw.providerKind)) {
		return { ok: false, reason: 'providerKind is not a provider kind' };
	}
	if (!isFleetAiCompletionModelId(raw.model)) return { ok: false, reason: 'model is not a model id' };
	const latencyMs = readCount(raw.latencyMs) ?? 0;
	let usage: FleetAiCompletionUsage | null = null;
	if (isPlainObject(raw.usage)) {
		const counts: FleetAiCompletionUsage = {};
		const inputTokens = readCount(raw.usage.inputTokens);
		const outputTokens = readCount(raw.usage.outputTokens);
		const totalTokens = readCount(raw.usage.totalTokens);
		if (inputTokens !== undefined) counts.inputTokens = inputTokens;
		if (outputTokens !== undefined) counts.outputTokens = outputTokens;
		if (totalTokens !== undefined) counts.totalTokens = totalTokens;
		usage = Object.keys(counts).length > 0 ? counts : null;
	}
	return {
		ok: true,
		value: {
			status,
			body: body.value.body,
			bodyEncoding: body.value.bodyEncoding,
			providerId: raw.providerId,
			providerKind: raw.providerKind,
			model: raw.model,
			latencyMs,
			usage,
			costUsd: 0,
			costBasis: 'local'
		}
	};
}

/**
 * The token counts a provider's response body reports, per wire API: the Chat
 * Completions API's `usage.prompt_tokens` / `completion_tokens` /
 * `total_tokens`, the Responses and Messages APIs' `usage.input_tokens` /
 * `output_tokens`. Null when the body reports none.
 */
export function readFleetAiCompletionUsage(api: FleetAiWireApi, body: unknown): FleetAiCompletionUsage | null {
	const usage = isPlainObject(body) && isPlainObject(body.usage) ? body.usage : null;
	if (!usage) return null;
	const counts: FleetAiCompletionUsage = {};
	const input = readCount(api === 'openai-chat' ? usage.prompt_tokens : usage.input_tokens);
	const output = readCount(api === 'openai-chat' ? usage.completion_tokens : usage.output_tokens);
	if (input !== undefined) counts.inputTokens = input;
	if (output !== undefined) counts.outputTokens = output;
	const total =
		readCount(usage.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
	if (total !== undefined) counts.totalTokens = total;
	return Object.keys(counts).length > 0 ? counts : null;
}

// ─── Outcomes ───────────────────────────────────────────────────────────────

/**
 * Why a completion produced no provider answer — one vocabulary for the
 * platform service, the relay a plugin calls, and the HTTP status a plugin's
 * transport maps each to:
 *
 *   - `no-node`         no online node of the owner serves the model;
 *   - `stopped`         the fleet's global stop flag is set;
 *   - `invalid-request` the body is not a request the relay forwards;
 *   - `too-large`       the request (or the answer) exceeds the relay's bounds;
 *   - `timeout`         no answer before the caller's deadline;
 *   - `cancelled`       the caller cancelled;
 *   - `failed`          a node took the request and reported a failure.
 */
export type FleetAiCompletionFailure =
	| 'no-node'
	| 'stopped'
	| 'invalid-request'
	| 'too-large'
	| 'timeout'
	| 'cancelled'
	| 'failed';

export const FLEET_AI_COMPLETION_FAILURES: readonly FleetAiCompletionFailure[] = [
	'no-node',
	'stopped',
	'invalid-request',
	'too-large',
	'timeout',
	'cancelled',
	'failed'
];

export function isFleetAiCompletionFailure(value: unknown): value is FleetAiCompletionFailure {
	return typeof value === 'string' && (FLEET_AI_COMPLETION_FAILURES as readonly string[]).includes(value);
}
