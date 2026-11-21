/**
 * Reads the registry and each directory's published documents, with bounded concurrency, timeouts, size caps, an
 * in-memory cache per isolate, the Cloudflare edge cache (`cf.cacheTtl`) and a last-known-good fallback (spec FR-21
 * to FR-23).
 *
 * Every URL fetched here is built from a registry origin; endpoints read from a directory's own `directory.json` are
 * only used when they stay on that directory's origin.
 */

import type { DirectoryEndpoints, DirectoryInfo, ItemDetail, ItemSummary } from './contract';
import { parseRegistry, type DirectoryEntry, type Registry } from './registry';

/** A directory that answered with a valid Contract v1 `directory.json`. */
export interface LoadedDirectory {
	entry: DirectoryEntry;
	info: DirectoryInfo;
	/** Served from the last good copy because the latest refresh failed */
	stale: boolean;
}

/** A registry entry that is not usable right now. */
export interface UnavailableDirectory {
	id: string;
	url: string;
	name: string | null;
	reason: string;
}

export interface DirectorySet {
	registry: Registry;
	available: LoadedDirectory[];
	unavailable: UnavailableDirectory[];
}

/** Byte caps per document type. */
export interface SizeLimits {
	registry: number;
	directory: number;
	items: number;
	item: number;
	taxonomy: number;
	mcp: number;
}

export type FetchFn = (input: string, init?: RequestInit & { cf?: Record<string, unknown> }) => Promise<Response>;

export interface LoaderOptions {
	/** Where the registry document lives */
	registryUrl: string;
	fetch?: FetchFn;
	now?: () => number;
	/** In-memory freshness (ms) */
	memoryTtl?: { registry?: number; directory?: number };
	/** Edge cache TTL passed to `fetch` (seconds) */
	edgeTtl?: { registry?: number; directory?: number };
	/** Per-request timeout (ms), default 4000 */
	timeoutMs?: number;
	/** Parallel fetches, default 6 (the Workers limit for simultaneous open connections) */
	concurrency?: number;
	limits?: Partial<SizeLimits>;
	/** User-Agent sent to directories */
	userAgent?: string;
}

export const DEFAULT_LIMITS: SizeLimits = {
	registry: 1_000_000,
	directory: 256_000,
	items: 8_000_000,
	item: 1_000_000,
	taxonomy: 1_000_000,
	mcp: 2_000_000
};

/** A fetch that failed in a way worth reporting to callers (no URLs or stack traces in the message). */
export class FetchFailure extends Error {
	constructor(
		message: string,
		readonly status?: number
	) {
		super(message);
	}
}

/** A directory's MCP server answered with a JSON-RPC error. */
export class UpstreamRpcError extends Error {}

interface CacheSlot<T> {
	value?: T;
	fetchedAt: number;
	stale: boolean;
	error?: Error;
	inflight?: Promise<{ value: T; stale: boolean }>;
}

/** How long a failed load is remembered before it is tried again (ms). */
export const RETRY_AFTER_MS = 60_000;

const CONTRACT_PATHS: Record<keyof Omit<DirectoryEndpoints, 'mcp'>, string> = {
	items: '/data/items.json',
	item: '/data/items/{slug}.json',
	categories: '/data/categories.json',
	tags: '/data/tags.json',
	openapi: '/data/openapi.json',
	llms: '/llms.txt',
	llms_full: '/llms-full.txt',
	sitemap: '/sitemap-index.xml'
};

/** Slugs are passed into a URL path: letters, digits, `.`, `_` and `-` only, and no `..` (spec FR-12). */
export const SLUG_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function nullableStr(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function sameOrigin(value: unknown, origin: string): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value, origin);
		return url.origin === origin ? url.toString().replace(/%7Bslug%7D/gi, '{slug}') : null;
	} catch {
		return null;
	}
}

/**
 * Validate a `directory.json` against Contract v1 and the registry entry (spec FR-4).
 *
 * @returns The normalized info, or a reason why the directory is unavailable
 */
export function toDirectoryInfo(document: unknown, entry: DirectoryEntry): DirectoryInfo | string {
	const root = record(document);
	if (!root || root['version'] !== 1) return 'no Agent Access Contract v1 directory.json';
	const name = str(root['name']).trim();
	if (!name) return 'directory.json has no name';
	let origin: string;
	try {
		origin = new URL(str(root['url'])).origin;
	} catch {
		return 'directory.json has no valid url';
	}
	if (origin !== entry.url) return 'directory.json url does not match the registry';

	const rawEndpoints = record(root['endpoints']) ?? {};
	const endpoints = {} as DirectoryEndpoints;
	for (const [key, path] of Object.entries(CONTRACT_PATHS) as Array<[keyof typeof CONTRACT_PATHS, string]>) {
		endpoints[key] = sameOrigin(rawEndpoints[key], origin) ?? `${origin}${path}`;
	}
	if (!endpoints.item.includes('{slug}')) endpoints.item = `${origin}${CONTRACT_PATHS.item}`;
	endpoints.mcp = rawEndpoints['mcp'] === null ? null : sameOrigin(rawEndpoints['mcp'], origin);

	const counts = record(root['counts']) ?? {};
	return {
		version: 1,
		name: name.slice(0, 200),
		description: str(root['description']).slice(0, 2000),
		url: origin,
		item_name: str(root['item_name'], 'Item') || 'Item',
		items_name: str(root['items_name'], 'Items') || 'Items',
		counts: {
			items: count(counts['items']),
			categories: count(counts['categories']),
			tags: count(counts['tags']),
			collections: count(counts['collections']),
			comparisons: count(counts['comparisons'])
		},
		updated_at: nullableStr(root['updated_at']),
		data_repository: nullableStr(root['data_repository']),
		submit_url: sameOrigin(root['submit_url'], origin),
		endpoints,
		generator: str(root['generator'], 'unknown')
	};
}

/**
 * Normalize one Contract v1 item summary; `null` when it lacks a slug or a name.
 *
 * @param value - Raw item
 */
export function toItemSummary(value: unknown): ItemSummary | null {
	const raw = record(value);
	if (!raw) return null;
	const slug = str(raw['slug']).trim();
	const name = str(raw['name']).trim();
	if (!slug || !name) return null;
	return {
		slug,
		name,
		description: str(raw['description']),
		url: str(raw['url']),
		website: nullableStr(raw['website']),
		categories: strArray(raw['categories']),
		category_ids: strArray(raw['category_ids']),
		tags: strArray(raw['tags']),
		tag_ids: strArray(raw['tag_ids']),
		featured: raw['featured'] === true,
		logo: nullableStr(raw['logo']),
		updated_at: nullableStr(raw['updated_at'])
	};
}

/**
 * Run `task` over `items` with at most `limit` in flight; results keep input order.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index] as T);
		}
	});
	await Promise.all(workers);
	return results;
}

async function readCapped(response: Response, max: number): Promise<string> {
	const declared = Number(response.headers.get('Content-Length'));
	if (Number.isFinite(declared) && declared > max) throw new FetchFailure('document too large');
	if (!response.body) return '';
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			throw new FetchFailure('document too large');
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function describeError(error: unknown): string {
	if (error instanceof FetchFailure) return error.message;
	if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timed out';
	return 'network error';
}

/**
 * Loads and caches everything the hub reads. One instance per isolate.
 */
export class DirectoryLoader {
	private readonly fetchFn: FetchFn;
	private readonly now: () => number;
	private readonly limits: SizeLimits;
	private readonly timeoutMs: number;
	private readonly concurrency: number;
	private readonly memoryTtl: { registry: number; directory: number };
	private readonly edgeTtl: { registry: number; directory: number };
	private readonly userAgent: string;
	private readonly slots = new Map<string, CacheSlot<unknown>>();

	constructor(private readonly options: LoaderOptions) {
		this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
		this.now = options.now ?? Date.now;
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		this.timeoutMs = options.timeoutMs ?? 4000;
		this.concurrency = options.concurrency ?? 6;
		this.memoryTtl = { registry: 600_000, directory: 600_000, ...options.memoryTtl };
		this.edgeTtl = { registry: 3600, directory: 900, ...options.edgeTtl };
		this.userAgent = options.userAgent ?? 'ever-works-directory-hub/1.0 (+https://directories.ever.works/llms.txt)';
	}

	/** Fetch and parse JSON with a timeout, a byte cap and the edge cache. */
	async fetchJson(url: string, maxBytes: number, edgeTtl: number): Promise<unknown> {
		const response = await this.fetchFn(url, {
			headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
			signal: AbortSignal.timeout(this.timeoutMs),
			// No redirects: a directory must not be able to send the hub to another host.
			redirect: 'manual',
			// Cloudflare edge cache; 404s (old builds without /data/) are cached briefly, server errors not at all.
			cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': edgeTtl, '404': 60, '500-599': 0 } }
		});
		if (response.status === 404) throw new FetchFailure('not found (HTTP 404)', 404);
		if (!response.ok) throw new FetchFailure(`HTTP ${response.status}`, response.status);
		const body = await readCapped(response, maxBytes);
		try {
			return JSON.parse(body) as unknown;
		} catch {
			throw new FetchFailure('invalid JSON');
		}
	}

	/**
	 * Memoize `load` under `key` for `ttl` ms. Concurrent callers share one in-flight load. When a refresh fails the
	 * last good value is served as `stale` and the next attempt waits {@link RETRY_AFTER_MS}; a failure with no good
	 * value is remembered for the same time, so a directory that is down is not fetched on every request.
	 */
	private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
		const slot = (this.slots.get(key) as CacheSlot<T> | undefined) ?? { fetchedAt: 0, stale: false };
		this.slots.set(key, slot as CacheSlot<unknown>);
		const age = this.now() - slot.fetchedAt;
		if (slot.value !== undefined && age < ttl) return { value: slot.value, stale: slot.stale };
		if (slot.value === undefined && slot.error !== undefined && age < RETRY_AFTER_MS) throw slot.error;
		if (slot.inflight) return slot.inflight;
		slot.inflight = load().then(
			(value) => {
				Object.assign(slot, {
					value,
					fetchedAt: this.now(),
					stale: false,
					error: undefined,
					inflight: undefined
				});
				return { value, stale: false };
			},
			(error: unknown) => {
				slot.inflight = undefined;
				slot.error = error instanceof Error ? error : new FetchFailure('network error');
				if (slot.value === undefined) {
					slot.fetchedAt = this.now();
					throw error;
				}
				// Serve the last good copy, retry after RETRY_AFTER_MS instead of on every call.
				slot.stale = true;
				slot.fetchedAt = this.now() - ttl + Math.min(ttl, RETRY_AFTER_MS);
				return { value: slot.value, stale: true };
			}
		);
		return slot.inflight;
	}

	/** The registry (last good copy when a refresh fails). */
	async getRegistry(): Promise<Registry> {
		const { value } = await this.cached('registry', this.memoryTtl.registry, async () =>
			parseRegistry(await this.fetchJson(this.options.registryUrl, this.limits.registry, this.edgeTtl.registry))
		);
		return value;
	}

	private async loadDirectory(entry: DirectoryEntry): Promise<LoadedDirectory | UnavailableDirectory> {
		const unavailable = (reason: string): UnavailableDirectory => ({
			id: entry.id,
			url: entry.url,
			name: entry.name,
			reason
		});
		try {
			const { value, stale } = await this.cached(`dir:${entry.url}`, this.memoryTtl.directory, async () => {
				const info = toDirectoryInfo(
					await this.fetchJson(
						`${entry.url}/data/directory.json`,
						this.limits.directory,
						this.edgeTtl.directory
					),
					entry
				);
				if (typeof info === 'string') throw new FetchFailure(info);
				return info;
			});
			return { entry, info: value, stale };
		} catch (error) {
			return unavailable(describeError(error));
		}
	}

	/** Every registry directory, split into available and unavailable (spec FR-4, FR-22). */
	async getDirectories(): Promise<DirectorySet> {
		const registry = await this.getRegistry();
		const results = await mapLimit(registry.entries, this.concurrency, (entry) => this.loadDirectory(entry));
		const available: LoadedDirectory[] = [];
		const unavailable: UnavailableDirectory[] = [];
		for (const result of results) {
			if ('info' in result) available.push(result);
			else unavailable.push(result);
		}
		return { registry, available, unavailable };
	}

	/** One directory's item summaries (last good copy when a refresh fails). */
	async getItems(directory: LoadedDirectory): Promise<{ items: ItemSummary[]; stale: boolean }> {
		const { value, stale } = await this.cached(
			`items:${directory.entry.url}`,
			this.memoryTtl.directory,
			async () => {
				const root = record(
					await this.fetchJson(directory.info.endpoints.items, this.limits.items, this.edgeTtl.directory)
				);
				if (!root || !Array.isArray(root['items'])) throw new FetchFailure('items.json has no items array');
				return root['items'].map(toItemSummary).filter((item): item is ItemSummary => item !== null);
			}
		);
		return { items: value, stale };
	}

	/**
	 * Items of several directories; directories whose items cannot be read are returned as unavailable.
	 */
	async getItemsFor(directories: readonly LoadedDirectory[]): Promise<{
		loaded: Array<{ directory: LoadedDirectory; items: ItemSummary[] }>;
		failed: UnavailableDirectory[];
	}> {
		type Outcome = { directory: LoadedDirectory; items: ItemSummary[] } | UnavailableDirectory;
		const results = await mapLimit<LoadedDirectory, Outcome>(directories, this.concurrency, async (directory) => {
			try {
				const { items, stale } = await this.getItems(directory);
				return { directory: stale ? { ...directory, stale: true } : directory, items };
			} catch (error) {
				return {
					id: directory.entry.id,
					url: directory.entry.url,
					name: directory.info.name,
					reason: describeError(error)
				};
			}
		});
		const loaded: Array<{ directory: LoadedDirectory; items: ItemSummary[] }> = [];
		const failed: UnavailableDirectory[] = [];
		for (const result of results) {
			if ('items' in result) loaded.push(result);
			else failed.push(result);
		}
		return { loaded, failed };
	}

	/** One item's full detail, `null` when the directory does not have it. */
	async getItemDetail(directory: LoadedDirectory, slug: string): Promise<ItemDetail | null> {
		if (!SLUG_PATTERN.test(slug)) return null;
		const url = directory.info.endpoints.item.replace('{slug}', encodeURIComponent(slug));
		let document: unknown;
		try {
			document = await this.fetchJson(url, this.limits.item, this.edgeTtl.directory);
		} catch (error) {
			if (error instanceof FetchFailure && error.status === 404) return null;
			throw error;
		}
		const summary = toItemSummary(document);
		const raw = record(document);
		if (!summary || !raw) throw new FetchFailure('invalid item document');
		return {
			...summary,
			markdown: nullableStr(raw['markdown']),
			markdown_url: str(raw['markdown_url']),
			images: strArray(raw['images']),
			brand: nullableStr(raw['brand']),
			publisher: nullableStr(raw['publisher']),
			related: strArray(raw['related'])
		};
	}

	/** A taxonomy document (`categories.json` or `tags.json`) read from the directory's read API. */
	async getTaxonomy(directory: LoadedDirectory, kind: 'categories' | 'tags'): Promise<unknown[]> {
		const root = record(
			await this.fetchJson(directory.info.endpoints[kind], this.limits.taxonomy, this.edgeTtl.directory)
		);
		const list = root?.[kind];
		if (!Array.isArray(list)) throw new FetchFailure(`${kind}.json has no ${kind} array`);
		return list as unknown[];
	}

	/**
	 * Call one Contract v1 tool on a directory's own MCP server and return its `result` unchanged (spec FR-13).
	 *
	 * @throws {UpstreamRpcError} When the directory answers with a JSON-RPC error
	 * @throws {FetchFailure} When the directory cannot be reached or answers with something else
	 */
	async callDirectoryTool(directory: LoadedDirectory, tool: string, args: Record<string, unknown>): Promise<unknown> {
		const endpoint = directory.info.endpoints.mcp;
		if (!endpoint) throw new FetchFailure('the directory has no MCP endpoint');
		const response = await this.fetchFn(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2025-06-18',
				'User-Agent': this.userAgent
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: tool, arguments: args }
			}),
			signal: AbortSignal.timeout(this.timeoutMs),
			redirect: 'manual'
		});
		if (!response.ok) throw new FetchFailure(`HTTP ${response.status}`, response.status);
		let body = await readCapped(response, this.limits.mcp);
		if ((response.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
			// A streaming server: take the first `data:` event, which carries the response to our single request.
			const data = body.split(/\r?\n/).find((line) => line.startsWith('data:'));
			body = data ? data.slice(5).trim() : '';
		}
		let message: Record<string, unknown> | null;
		try {
			message = record(JSON.parse(body));
		} catch {
			throw new FetchFailure('invalid JSON-RPC response');
		}
		const error = record(message?.['error']);
		if (error) throw new UpstreamRpcError(str(error['message'], 'the directory rejected the call').slice(0, 300));
		const result = record(message?.['result']);
		if (!result) throw new FetchFailure('invalid JSON-RPC response');
		return result;
	}
}
