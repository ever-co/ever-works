import {
	CLOUDFLARE_API_BASE,
	type CloudflareWorkerDeployment,
	type CloudflareWorkerDomain,
	type CloudflareZone
} from './types.js';

/** A Cloudflare API call failed. The message never holds the token. */
export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly codes: readonly number[] = []
	) {
		super(message);
		this.name = 'CloudflareApiError';
	}
}

interface CloudflareEnvelope<T> {
	success?: boolean;
	result?: T;
	errors?: Array<{ code?: number; message?: string }>;
	result_info?: { page?: number; total_pages?: number };
}

interface RequestOptions {
	readonly query?: Record<string, string | undefined>;
	readonly body?: unknown;
	/** HTTP statuses answered as `null` instead of thrown (e.g. 404 = "does not exist"). */
	readonly nullOn?: readonly number[];
}

export interface CloudflareApiClientOptions {
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	/** Per-request timeout. */
	readonly timeoutMs?: number;
	/** Pause before the single retry of a 429 / 5xx / network failure. */
	readonly retryDelayMs?: number;
}

const MAX_PAGES = 20;

/** Strip control characters and cap the length of an upstream error string before it is logged or shown. */
function sanitize(text: string): string {
	return (
		text
			// eslint-disable-next-line no-control-regex
			.replace(/[\x00-\x1f\x7f]+/g, ' ')
			.trim()
			.slice(0, 300)
	);
}

function segment(value: string): string {
	return encodeURIComponent(value);
}

/**
 * Thin client over the Cloudflare v4 REST API — only the calls the Workers deploy provider needs. Plain
 * `fetch`, no SDK.
 */
export class CloudflareApiClient {
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly retryDelayMs: number;

	constructor(options: CloudflareApiClientOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
		this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, '');
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.retryDelayMs = options.retryDelayMs ?? 500;
	}

	/**
	 * Verify an **account-owned** API token. Account tokens are rejected by `/user/tokens/verify`, so this
	 * is the check to use whenever the account id is known.
	 */
	async verifyAccountToken(token: string, accountId: string): Promise<boolean> {
		const result = await this.request<{ status?: string }>(
			token,
			'GET',
			`/accounts/${segment(accountId)}/tokens/verify`,
			{ nullOn: [400, 401, 403, 404] }
		);
		return result?.status === 'active';
	}

	/** Verify a **user-owned** API token. */
	async verifyUserToken(token: string): Promise<boolean> {
		const result = await this.request<{ status?: string }>(token, 'GET', '/user/tokens/verify', {
			nullOn: [400, 401, 403, 404]
		});
		return result?.status === 'active';
	}

	/** Number of Worker scripts on the account — proves the token can read the account's Workers. */
	async countWorkerScripts(token: string, accountId: string): Promise<number> {
		const scripts = await this.request<unknown[]>(token, 'GET', `/accounts/${segment(accountId)}/workers/scripts`);
		return Array.isArray(scripts) ? scripts.length : 0;
	}

	/** The Worker's deployments, newest first; `null` when the Worker does not exist. */
	async getWorkerDeployments(
		token: string,
		accountId: string,
		scriptName: string
	): Promise<CloudflareWorkerDeployment[] | null> {
		const result = await this.request<{ deployments?: CloudflareWorkerDeployment[] }>(
			token,
			'GET',
			`/accounts/${segment(accountId)}/workers/scripts/${segment(scriptName)}/deployments`,
			{ nullOn: [404] }
		);
		if (result === null) return null;
		return Array.isArray(result.deployments) ? result.deployments : [];
	}

	/** Workers Custom Domains on the account, filtered server-side by Worker and/or hostname. */
	async listWorkerDomains(
		token: string,
		accountId: string,
		filter: { service?: string; hostname?: string } = {}
	): Promise<CloudflareWorkerDomain[]> {
		const out: CloudflareWorkerDomain[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const envelope = await this.requestEnvelope<CloudflareWorkerDomain[]>(
				token,
				'GET',
				`/accounts/${segment(accountId)}/workers/domains`,
				{ query: { service: filter.service, hostname: filter.hostname, page: String(page), per_page: '100' } }
			);
			const rows = Array.isArray(envelope?.result) ? envelope.result : [];
			out.push(...rows);
			const totalPages = envelope?.result_info?.total_pages ?? 1;
			if (rows.length === 0 || page >= totalPages) break;
		}
		// The server filters already; re-check so a widened upstream filter can never leak another
		// Worker's domains into this Work's list.
		return out.filter(
			(domain) =>
				(!filter.service || domain.service === filter.service) &&
				(!filter.hostname || domain.hostname?.toLowerCase() === filter.hostname.toLowerCase())
		);
	}

	/** Attach a hostname to a Worker as a Workers Custom Domain (Cloudflare creates DNS + certificate). */
	async attachWorkerDomain(
		token: string,
		accountId: string,
		input: { hostname: string; service: string; zoneId?: string }
	): Promise<CloudflareWorkerDomain> {
		const body: Record<string, unknown> = { hostname: input.hostname, service: input.service };
		if (input.zoneId) {
			body.zone_id = input.zoneId;
		}
		const result = await this.request<CloudflareWorkerDomain>(
			token,
			'PUT',
			`/accounts/${segment(accountId)}/workers/domains`,
			{
				body
			}
		);
		if (!result) {
			throw new CloudflareApiError('Cloudflare returned no domain for the attach request', 502);
		}
		return result;
	}

	/** Detach a Workers Custom Domain by id. `false` when it was already gone. */
	async detachWorkerDomain(token: string, accountId: string, domainId: string): Promise<boolean> {
		// A successful detach answers `result: null`, so the envelope (not the result) says whether it worked.
		const envelope = await this.requestEnvelope<unknown>(
			token,
			'DELETE',
			`/accounts/${segment(accountId)}/workers/domains/${segment(domainId)}`,
			{ nullOn: [404] }
		);
		return envelope !== null;
	}

	/** The zone with exactly this name on the account, or `null`. */
	async findZone(token: string, accountId: string, name: string): Promise<CloudflareZone | null> {
		const zones = await this.request<CloudflareZone[]>(token, 'GET', '/zones', {
			query: { name, 'account.id': accountId }
		});
		const match = (zones ?? []).find((zone) => zone.name?.toLowerCase() === name.toLowerCase());
		return match ?? null;
	}

	// --- transport ---------------------------------------------------------------------------------------

	private async request<T>(
		token: string,
		method: string,
		path: string,
		options: RequestOptions = {}
	): Promise<T | null> {
		const envelope = await this.requestEnvelope<T>(token, method, path, options);
		if (envelope === null) return null;
		return (envelope.result ?? null) as T | null;
	}

	private async requestEnvelope<T>(
		token: string,
		method: string,
		path: string,
		options: RequestOptions = {}
	): Promise<CloudflareEnvelope<T> | null> {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined && value !== '') url.searchParams.set(key, value);
		}
		const init: RequestInit = {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
				...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
			},
			...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
		};

		let response: Response;
		try {
			response = await this.send(url.toString(), init);
		} catch (cause) {
			throw new CloudflareApiError(
				`Cloudflare API ${method} ${path} failed: ${sanitize(cause instanceof Error ? cause.message : String(cause))}`,
				0
			);
		}

		if (options.nullOn?.includes(response.status)) {
			return null;
		}

		const envelope = (await response.json().catch(() => ({}))) as CloudflareEnvelope<T>;
		if (!response.ok || envelope.success === false) {
			const codes = (envelope.errors ?? []).map((e) => e.code).filter((c): c is number => typeof c === 'number');
			const detail = (envelope.errors ?? [])
				.map((e) => e.message)
				.filter(Boolean)
				.join('; ');
			throw new CloudflareApiError(
				`Cloudflare API ${method} ${path} returned HTTP ${response.status}${detail ? `: ${sanitize(detail)}` : ''}`,
				response.status,
				codes
			);
		}
		return envelope;
	}

	/** One request, retried once on 429 / 5xx / a network error. */
	private async send(url: string, init: RequestInit): Promise<Response> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0 && this.retryDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
			}
			try {
				const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
				if ((response.status === 429 || response.status >= 500) && attempt === 0) {
					lastError = new Error(`HTTP ${response.status}`);
					continue;
				}
				return response;
			} catch (cause) {
				lastError = cause;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
}
