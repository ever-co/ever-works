/**
 * Local types + constants for the Memanto agent-memory plugin.
 *
 * Wire format verified against the Memanto 0.3.0 server source
 * (`memanto/app/routes/{memory,sessions,health,auth_deps}.py`,
 * `memanto/app/models/*.py`) AND exercised end to end against a running
 * Memanto 0.3.0 server (see `src/__tests__/memanto.contract.spec.ts`):
 *
 *   - Management calls (`/api/v2/agents*`, `/activate`) take
 *     `X-Api-Key: <key>`. On the Moorcheh-Cloud backend the key IS the
 *     server's `MOORCHEH_API_KEY`; on the on-prem backend it is the
 *     server's `MEMANTO_SECRET_KEY`. Loopback callers may omit it.
 *   - Memory calls (`/api/v2/agents/{id}/...`) take `X-Session-Token`, a JWT
 *     from `POST /api/v2/agents/{id}/activate`. ONE live session per Memanto
 *     agent: every activate invalidates the previous token (401
 *     `InvalidSessionToken`), so the client re-activates once on 401 and
 *     shares the current token through the plugin cache.
 *   - Errors are FastAPI `{ detail }` — either a string or
 *     `{ error, message, details }` for Memanto domain errors.
 */

/** Default Memanto server URL (`memanto serve` binds :8000). */
export const DEFAULT_BASE_URL = 'http://localhost:8000';

/** Default per-request timeout. Recall over Moorcheh is sub-second; activate may call the backend. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;

/** Prefix for derived Memanto agent ids (`<prefix>-<projectId>`). */
export const DEFAULT_AGENT_PREFIX = 'ever-works';

/** Memanto hard limits (`memanto/app/core.py`, cost guards). */
export const MEMANTO_MAX_CONTENT_CHARS = 10_000;
export const MEMANTO_MAX_QUERY_CHARS = 1_000;
export const MEMANTO_MAX_TAGS = 20;
export const MEMANTO_MAX_TAG_CHARS = 64;
export const MEMANTO_MAX_RECALL_LIMIT = 100;
/** Default recall size when the caller does not ask for one. */
export const DEFAULT_RECALL_LIMIT = 10;
/** Memanto agent ids: `^[a-zA-Z0-9_-]+$`. We cap length so the Moorcheh namespace stays short. */
export const MEMANTO_MAX_AGENT_ID_CHARS = 64;

/** `source` stamped on every memory Ever Works writes (Memanto attribution label). */
export const MEMANTO_SOURCE = 'ever-works';
/** Sent as `X-Memanto-Client` (activity-log attribution only). */
export const MEMANTO_CLIENT_HEADER_VALUE = 'ever-works';

/**
 * The 13 Memanto memory types (`memanto/app/constants.py`). A caller may
 * pass one through `metadata.memoryType`; otherwise Memanto's rule-based
 * parser assigns it (no LLM call on write).
 */
export const MEMANTO_MEMORY_TYPES = [
	'fact',
	'preference',
	'goal',
	'decision',
	'artifact',
	'learning',
	'event',
	'instruction',
	'relationship',
	'context',
	'observation',
	'commitment',
	'error'
] as const;
export type MemantoMemoryType = (typeof MEMANTO_MEMORY_TYPES)[number];

/** Env-var fallbacks read manually in `resolveSettings` (not `x-envVar`, which would lock the field out of the UI). */
export const ENV_VAR_BASE_URL = 'MEMANTO_BASE_URL';
export const ENV_VAR_API_KEY = 'MEMANTO_API_KEY';
export const ENV_VAR_AGENT_PREFIX = 'MEMANTO_AGENT_PREFIX';
export const ENV_VAR_AGENT_ID = 'MEMANTO_AGENT_ID';

export interface MemantoSettings {
	baseUrl?: string;
	/** Management credential (Moorcheh API key on the cloud backend, MEMANTO_SECRET_KEY on-prem). */
	apiKey?: string;
	/** Prefix for per-project agent ids. */
	agentPrefix?: string;
	/**
	 * Pin every project of this scope to ONE Memanto agent (one Moorcheh
	 * namespace). Projects are then separated by an internal tag. Useful on
	 * Moorcheh's free tier, which caps namespaces at 20.
	 */
	agentId?: string;
	/** Optional recall similarity floor (0..1). */
	minSimilarity?: number;
	timeoutMs?: number;
}

/** `MemoryItem` as returned by every Memanto recall route. */
export interface MemantoMemoryItem {
	readonly id: string;
	readonly title?: string;
	readonly content?: string;
	readonly text?: string;
	readonly type?: string;
	readonly confidence?: number;
	readonly status?: string;
	readonly tags?: readonly string[];
	readonly created_at?: string;
	readonly updated_at?: string;
	readonly agent_id?: string;
	readonly source?: string;
	readonly score?: number | null;
	readonly provenance?: string;
}

export interface MemantoRecallResponse {
	readonly agent_id?: string;
	readonly memories?: readonly MemantoMemoryItem[];
	readonly count?: number;
}

export interface MemantoRememberResponse {
	readonly memory_id: string;
	readonly agent_id?: string;
	readonly status?: string;
	readonly type?: string;
}

export interface MemantoSessionResponse {
	readonly session_id: string;
	readonly session_token: string;
	readonly agent_id: string;
	readonly expires_at?: string;
}

export interface MemantoHealthResponse {
	readonly status?: string;
	readonly service?: string;
	readonly version?: string;
	readonly moorcheh_connected?: boolean;
}
