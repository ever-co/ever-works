/**
 * Agent Access Contract v1 — the shapes every Ever Works directory publishes, and the text helpers its ranking uses.
 *
 * Source of truth: `.specify/features/agent-access.md` and `packages/agent-api` in
 * `ever-works/directory-web-minimal-template`. That package is private to the template repository, so the few helpers
 * the hub needs are copied here; the scoring weights are part of the contract and are pinned by `test/contract.spec.ts`.
 */

/** Protocol revisions the hub speaks, newest first (same list as Contract v1). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** Contract v1 MCP tool names, as served by every directory's `/mcp`. */
export const CONTRACT_TOOL_NAMES = [
	'get_directory_info',
	'search_items',
	'list_items',
	'get_item',
	'list_categories',
	'list_tags'
] as const;

export type ContractToolName = (typeof CONTRACT_TOOL_NAMES)[number];

export interface DirectoryEndpoints {
	items: string;
	/** Item endpoint template containing `{slug}` */
	item: string;
	categories: string;
	tags: string;
	openapi: string;
	llms: string;
	llms_full: string;
	sitemap: string;
	mcp: string | null;
}

export interface DirectoryInfo {
	version: 1;
	name: string;
	description: string;
	url: string;
	item_name: string;
	items_name: string;
	counts: { items: number; categories: number; tags: number; collections: number; comparisons: number };
	updated_at: string | null;
	data_repository: string | null;
	submit_url: string | null;
	endpoints: DirectoryEndpoints;
	generator: string;
}

export interface ItemSummary {
	slug: string;
	name: string;
	description: string;
	url: string;
	website: string | null;
	categories: string[];
	category_ids: string[];
	tags: string[];
	tag_ids: string[];
	featured: boolean;
	logo: string | null;
	updated_at: string | null;
}

export interface ItemDetail extends ItemSummary {
	markdown: string | null;
	markdown_url: string;
	images: string[];
	brand: string | null;
	publisher: string | null;
	related: string[];
}

/**
 * Normalize text for matching: lowercase, accents stripped.
 *
 * @param value - Any text
 */
export function normalizeText(value: string): string {
	const decomposed = value.toLowerCase().normalize('NFKD');
	return decomposed.replace(/[\u0300-\u036f]/g, '');
}

/**
 * Split a query into normalized, unique tokens (letters and digits of any script).
 *
 * @param query - Raw query
 */
export function tokenize(query: string): string[] {
	const tokens = normalizeText(query)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0);
	return [...new Set(tokens)];
}

/**
 * Normalize a taxonomy value (id, name or slug) to a comparison key.
 *
 * @param value - Category or tag id, name or slug
 */
export function taxonomySlug(value: string): string {
	return normalizeText(String(value).trim())
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Contract v1 category/tag filter: matches an id, a display name or a slug, case-insensitively. Values that slugify to
 * an empty string (non-Latin names) compare as normalized text, never through the empty slug.
 *
 * @param ids - Item category or tag ids
 * @param names - Item category or tag display names
 * @param wanted - Filter value from the caller
 */
export function matchesTaxonomy(ids: readonly string[], names: readonly string[], wanted: string): boolean {
	const key = taxonomySlug(wanted);
	if (!key) {
		const text = normalizeText(wanted.trim());
		return [...ids, ...names].some((value) => normalizeText(value.trim()) === text);
	}
	return ids.some((id) => taxonomySlug(id) === key) || names.some((name) => taxonomySlug(name) === key);
}

/** An item's searchable text, normalized once. */
export interface PreparedText {
	name: string;
	words: string[];
	description: string;
	taxonomy: string[];
}

/**
 * Normalize an item's searchable fields once, so ranking many queries over it stays cheap.
 *
 * @param item - Item name, description and category/tag names
 */
export function prepareText(item: { name: string; description: string; taxonomy: readonly string[] }): PreparedText {
	const name = normalizeText(item.name);
	return {
		name,
		words: name.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
		description: normalizeText(item.description ?? ''),
		taxonomy: item.taxonomy.map(normalizeText)
	};
}

/**
 * Contract v1 score of one token against an item: `+8` whole name, `+5` a name word starts with it, `+3` the name
 * contains it, plus `+2` when a category/tag name contains it and `+1` when the description contains it.
 *
 * @param token - One normalized token
 * @param text - Prepared item text
 * @returns The token's score, `0` when it matches nothing
 */
export function tokenScore(token: string, text: PreparedText): number {
	let score = 0;
	if (text.name === token) score += 8;
	else if (text.words.some((word) => word.startsWith(token))) score += 5;
	else if (text.name.includes(token)) score += 3;
	if (text.taxonomy.some((value) => value.includes(token))) score += 2;
	if (text.description.includes(token)) score += 1;
	return score;
}

/**
 * Contract v1 item score: every token must match (else `0`); `+10` when the whole query equals the name; `+0.5` for
 * featured items. Kept for parity with the directories' own `search_items`.
 *
 * @param tokens - Output of {@link tokenize}
 * @param text - Prepared item text
 * @param fullQuery - Normalized full query
 * @param featured - Whether the item is featured
 */
export function scoreItem(tokens: readonly string[], text: PreparedText, fullQuery = '', featured = false): number {
	if (tokens.length === 0) return 0;
	let total = 0;
	for (const token of tokens) {
		const score = tokenScore(token, text);
		if (score === 0) return 0;
		total += score;
	}
	if (fullQuery && text.name === fullQuery.trim()) total += 10;
	if (featured) total += 0.5;
	return total;
}
