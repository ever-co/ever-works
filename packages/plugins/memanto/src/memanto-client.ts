import { createHash } from 'node:crypto';
import {
	DEFAULT_BASE_URL,
	DEFAULT_TIMEOUT_MS,
	MEMANTO_CLIENT_HEADER_VALUE,
	type MemantoHealthResponse,
	type MemantoRecallResponse,
	type MemantoRememberResponse,
	type MemantoSessionResponse
} from './types.js';

/**
 * Shared session-token store. The plugin passes its `PluginContext.cache`
 * (backed by the API's cache manager — shared across replicas when that is
 * Redis/Valkey), so replicas converge on ONE current token per Memanto agent
 * instead of rotating each other's tokens out on every call.
 */
export interface MemantoTokenStore {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string, ttlSeconds?: number): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface MemantoClientOptions {
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	readonly tokenStore?: MemantoTokenStore;
	readonly logger?: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/** A non-2xx Memanto answer, with the Memanto error code when it sent one. */
export class MemantoHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string
	) {
		super(message);
		this.name = 'MemantoHttpError';
	}
}

/** Thrown (internally) when a READ targets a Memanto agent that does not exist yet. */
class MemantoAgentMissing extends Error {
	constructor(readonly agentId: string) {
		super(`Memanto agent '${agentId}' does not exist yet`);
		this.name = 'MemantoAgentMissing';
	}
}

const EMPTY_RECALL = { memories: [], count: 0 } as const;

/** Memanto error codes that mean "this session token is no longer usable — activate again". */
const SESSION_RETRY_CODES = new Set(['InvalidSessionToken', 'SessionExpired', 'SessionNotFound']);

/** Process-local token cache (first tier; the shared store is the second). */
const localTokens = new Map<string, string>();
/** In-flight activations, so concurrent calls for one agent activate once. */
const inflight = new Map<string, Promise<string>>();

/** Session tokens default to 6 h; cache a little less so a stale token is rare. */
const TOKEN_TTL_SECONDS = 5 * 60 * 60;

/**
 * HTTP client for a Memanto server (`/api/v2`).
 *
 * Owns the awkward part of Memanto's auth model: one live JWT session per
 * Memanto agent, created on demand (agent auto-created on first use),
 * re-activated once on a 401 session error, and kept in sync with the
 * `X-Session-Token` header the server returns when it rotates a session.
 */
export class MemantoClient {
	private readonly baseUrl: string;
	private readonly apiKey: string | undefined;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly tokenStore: MemantoTokenStore | undefined;
	private readonly logger: NonNullable<MemantoClientOptions['logger']>;

	constructor(options: MemantoClientOptions = {}) {
		this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
		this.apiKey = options.apiKey?.trim() || undefined;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.tokenStore = options.tokenStore;
		this.logger = options.logger ?? console;
	}

	// ── public, unauthenticated ─────────────────────────────────────────

	/** `GET /health` — always HTTP 200; `status` says whether Moorcheh is reachable. */
	async health(): Promise<MemantoHealthResponse> {
		return (await this.request<MemantoHealthResponse>('GET', '/health')) ?? {};
	}

	// ── management (X-Api-Key) ──────────────────────────────────────────

	/** `GET /api/v2/agents` — proves the management credential works. */
	async listAgents(): Promise<{ agents?: unknown[]; count?: number }> {
		return (
			(await this.request<{ agents?: unknown[]; count?: number }>('GET', '/api/v2/agents', {
				management: true,
				query: { include_counts: 'false' }
			})) ?? {}
		);
	}

	/** Create the Memanto agent (and its Moorcheh namespace) if it does not exist yet. */
	async ensureAgent(agentId: string): Promise<void> {
		try {
			await this.request('POST', '/api/v2/agents', {
				management: true,
				body: {
					agent_id: agentId,
					pattern: 'project',
					description: 'Ever Works agent memory'
				}
			});
		} catch (error) {
			// 409 AgentAlreadyExists — someone (another replica) created it first.
			if (error instanceof MemantoHttpError && error.status === 409) return;
			throw error;
		}
	}

	// ── memory (X-Session-Token) ────────────────────────────────────────

	/**
	 * Make sure a usable session exists for the agent (auto-creating the agent
	 * on first use). Free when a token is already cached — no request at all.
	 */
	async ensureSession(agentId: string): Promise<void> {
		const key = this.tokenKey(agentId);
		if (await this.currentToken(key)) return;
		try {
			await this.activate(agentId, key, false);
		} catch (error) {
			// Nothing stored for this project yet — the first write creates the agent.
			if (!(error instanceof MemantoAgentMissing)) throw error;
		}
	}

	async remember(agentId: string, body: Record<string, unknown>): Promise<MemantoRememberResponse> {
		// The only call that creates the Memanto agent (and its Moorcheh namespace).
		return this.withSession(
			agentId,
			(token) => this.request<MemantoRememberResponse>('POST', `${agentPath(agentId)}/remember`, { token, body }),
			true
		);
	}

	async recall(agentId: string, body: Record<string, unknown>): Promise<MemantoRecallResponse> {
		return this.read(agentId, '/recall', body);
	}

	async recallRecent(agentId: string, body: Record<string, unknown>): Promise<MemantoRecallResponse> {
		return this.read(agentId, '/recall/recent', body);
	}

	async recallAll(agentId: string, body: Record<string, unknown>): Promise<MemantoRecallResponse> {
		return this.read(agentId, '/recall/all', body);
	}

	async deleteMemory(agentId: string, memoryId: string): Promise<void> {
		try {
			await this.withSession(agentId, (token) =>
				this.request('DELETE', `${agentPath(agentId)}/memories/${encodeURIComponent(memoryId)}`, { token })
			);
		} catch (error) {
			// Idempotent forget: no agent, or the memory is already gone (plain
			// 404 with no session error code), means there is nothing to delete.
			if (error instanceof MemantoAgentMissing) return;
			if (error instanceof MemantoHttpError && error.status === 404 && !error.code) return;
			throw error;
		}
	}

	/** Reads never create an agent: a project with no memories yet just recalls nothing. */
	private async read(agentId: string, route: string, body: Record<string, unknown>): Promise<MemantoRecallResponse> {
		try {
			return await this.withSession(
				agentId,
				async (token) =>
					(await this.request<MemantoRecallResponse>('POST', `${agentPath(agentId)}${route}`, {
						token,
						body
					})) ?? {}
			);
		} catch (error) {
			if (error instanceof MemantoAgentMissing) return { ...EMPTY_RECALL, memories: [] };
			throw error;
		}
	}

	// ── session handling ────────────────────────────────────────────────

	private tokenKey(agentId: string): string {
		// The key never carries the credential itself — only a digest of it.
		const digest = createHash('sha256')
			.update(`${this.baseUrl}\n${this.apiKey ?? ''}\n${agentId}`)
			.digest('hex')
			.slice(0, 32);
		return `memanto-session:${digest}`;
	}

	private async currentToken(key: string): Promise<string | undefined> {
		const local = localTokens.get(key);
		if (local) return local;
		const shared = await this.tokenStore?.get(key).catch(() => undefined);
		if (shared) localTokens.set(key, shared);
		return shared;
	}

	private async storeToken(key: string, token: string): Promise<void> {
		localTokens.set(key, token);
		await this.tokenStore?.set(key, token, TOKEN_TTL_SECONDS).catch(() => undefined);
	}

	private async dropToken(key: string, token: string): Promise<void> {
		if (localTokens.get(key) === token) localTokens.delete(key);
		const shared = await this.tokenStore?.get(key).catch(() => undefined);
		if (shared === token) await this.tokenStore?.delete(key).catch(() => undefined);
	}

	/**
	 * Activate and cache the new token, deduplicated per agent. With `create`
	 * a missing agent is created first; without it the caller gets
	 * `MemantoAgentMissing` (reads must not spend a Moorcheh namespace).
	 */
	private activate(agentId: string, key: string, create: boolean): Promise<string> {
		const pending = inflight.get(`${key}:${create}`) ?? (create ? undefined : inflight.get(`${key}:true`));
		if (pending) return pending;
		const run = (async () => {
			let session: MemantoSessionResponse | undefined;
			try {
				session = await this.request<MemantoSessionResponse>('POST', `${agentPath(agentId)}/activate`, {
					management: true
				});
			} catch (error) {
				if (!(error instanceof MemantoHttpError && error.code === 'AgentNotFound')) throw error;
				if (!create) throw new MemantoAgentMissing(agentId);
				await this.ensureAgent(agentId);
				session = await this.request<MemantoSessionResponse>('POST', `${agentPath(agentId)}/activate`, {
					management: true
				});
			}
			const token = session?.session_token;
			if (!token) throw new Error('Memanto activate returned no session_token');
			await this.storeToken(key, token);
			return token;
		})();
		const slot = `${key}:${create}`;
		inflight.set(slot, run);
		return run.finally(() => inflight.delete(slot));
	}

	private async withSession<T>(agentId: string, call: (token: string) => Promise<T>, create = false): Promise<T> {
		const key = this.tokenKey(agentId);
		let token = (await this.currentToken(key)) ?? (await this.activate(agentId, key, create));
		try {
			return await call(token);
		} catch (error) {
			if (!isSessionError(error)) throw error;
			await this.dropToken(key, token);
			// Another replica may already have activated — prefer its token over
			// rotating it out again with our own activate.
			const shared = await this.tokenStore?.get(key).catch(() => undefined);
			token = shared && shared !== token ? shared : await this.activate(agentId, key, create);
			localTokens.set(key, token);
			return call(token);
		}
	}

	// ── transport ───────────────────────────────────────────────────────

	private async request<T>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		options: {
			management?: boolean;
			token?: string;
			body?: unknown;
			query?: Record<string, string>;
		} = {}
	): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

		const headers: Record<string, string> = {
			Accept: 'application/json',
			'X-Memanto-Client': MEMANTO_CLIENT_HEADER_VALUE
		};
		// Management credential on management calls; on memory calls too, so a
		// server with SESSION_AUTO_ACTIVATE_ENABLED can transparently renew an
		// expired session instead of answering 401.
		if (this.apiKey && (options.management || options.token)) headers['X-Api-Key'] = this.apiKey;
		if (options.token) headers['X-Session-Token'] = options.token;
		let body: string | undefined;
		if (options.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(options.body);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;
		try {
			response = await this.fetchImpl(url.toString(), { method, headers, body, signal: controller.signal });
		} catch (error) {
			if (isAbortError(error)) throw new Error(`Memanto request timed out: ${method} ${path}`);
			throw new Error(
				`Memanto is unreachable (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			clearTimeout(timer);
		}

		// The server rotates the session near expiry and says so in this header.
		const rotated = response.headers.get('x-session-token');
		if (rotated && options.token && rotated !== options.token) {
			const agentId = agentIdFromPath(path);
			if (agentId) await this.storeToken(this.tokenKey(agentId), rotated);
		}

		const text = await response.text().catch(() => '');
		if (!response.ok) throw buildHttpError(response.status, text, method, path);
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			this.logger.warn(`Memanto ${method} ${path} returned non-JSON`);
			return undefined as T;
		}
	}
}

function agentPath(agentId: string): string {
	return `/api/v2/agents/${encodeURIComponent(agentId)}`;
}

function agentIdFromPath(path: string): string | undefined {
	const m = /^\/api\/v2\/agents\/([^/]+)\//.exec(path);
	return m ? decodeURIComponent(m[1]) : undefined;
}

function isSessionError(error: unknown): boolean {
	return (
		error instanceof MemantoHttpError &&
		(error.status === 401 || error.status === 404) &&
		!!error.code &&
		SESSION_RETRY_CODES.has(error.code)
	);
}

function isAbortError(error: unknown): boolean {
	const name = (error as { name?: string } | null)?.name;
	return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Translate a FastAPI error body into a readable error. Only the PATH goes
 * into the message (never the base URL: it can name internal hosts).
 */
function buildHttpError(status: number, text: string, method: string, path: string): MemantoHttpError {
	let code: string | undefined;
	let detail = '';
	try {
		const parsed = JSON.parse(text) as { detail?: unknown };
		const d = parsed?.detail;
		if (typeof d === 'string') detail = d;
		else if (Array.isArray(d)) {
			detail = d
				.map((e) =>
					e && typeof e === 'object'
						? `${(e as { loc?: unknown[] }).loc?.join('.') ?? ''}: ${(e as { msg?: string }).msg ?? ''}`
						: String(e)
				)
				.join('; ');
		} else if (d && typeof d === 'object') {
			const obj = d as { error?: unknown; message?: unknown };
			if (typeof obj.error === 'string') code = obj.error;
			detail = typeof obj.message === 'string' ? obj.message : JSON.stringify(d);
		}
	} catch {
		detail = text.slice(0, 300);
	}
	detail = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;

	if (status === 401 && !code) {
		return new MemantoHttpError(
			"Memanto rejected the management credential — set `apiKey` to the server's MOORCHEH_API_KEY (Moorcheh Cloud backend) or MEMANTO_SECRET_KEY (on-prem backend).",
			status
		);
	}
	if (status === 403 && !code) {
		return new MemantoHttpError(
			`Memanto refused the request (403) for ${method} ${path}${detail ? ` — ${detail}` : ''}`,
			status
		);
	}
	if (status === 429) {
		return new MemantoHttpError(
			'Memanto (or its Moorcheh backend) rate-limited the request. Retry after a short delay.',
			status,
			code
		);
	}
	return new MemantoHttpError(
		`Memanto request failed (${status}${code ? ` ${code}` : ''}) for ${method} ${path}${detail ? ` — ${detail}` : ''}`,
		status,
		code
	);
}

/** Test seam — forget every cached token / in-flight activation. */
export function resetMemantoSessionCache(): void {
	localTokens.clear();
	inflight.clear();
}
