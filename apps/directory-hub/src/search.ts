/**
 * Directory-aware ranking (spec FR-9, plan §5).
 *
 * Contract v1 scores an item against every query word and drops it when one word matches nothing. Across many
 * directories that is too strict: in "time tracking tools" the words "time tracking" describe the directory, not each
 * item. So a word may be matched either by the item (Contract v1 weights) or by the item's directory (its name, topics,
 * aliases or id). Filler words ("find", "best", "tools", …) are optional unless nothing else is left.
 */

import {
	matchesTaxonomy,
	normalizeText,
	prepareText,
	tokenize,
	tokenScore,
	type ItemSummary,
	type PreparedText
} from './contract';
import type { LoadedDirectory } from './loader';
import type { DirectoryEntry } from './registry';

/** Words that never have to match; they only add score when they do. */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
	'a',
	'about',
	'all',
	'an',
	'and',
	'any',
	'app',
	'apps',
	'are',
	'best',
	'by',
	'directories',
	'directory',
	'find',
	'for',
	'from',
	'get',
	'give',
	'good',
	'in',
	'is',
	'list',
	'me',
	'my',
	'of',
	'on',
	'or',
	'our',
	'platform',
	'platforms',
	'popular',
	'product',
	'products',
	'recommend',
	'search',
	'service',
	'services',
	'show',
	'software',
	'solution',
	'solutions',
	'some',
	'that',
	'the',
	'to',
	'tool',
	'tools',
	'top',
	'what',
	'which',
	'with'
]);

/** Directory-side weights (plan §5). */
const DIRECTORY_WEIGHTS = { nameWord: 6, topic: 4, id: 3, description: 1 } as const;
const DIRECTORY_FACTOR = 0.75;
const OPTIONAL_FACTOR = 0.5;

/** Query words split into the ones that must match and the optional filler. */
export interface ParsedQuery {
	required: string[];
	optional: string[];
	normalized: string;
}

/**
 * Split a query into required and optional tokens.
 *
 * @param query - Raw query
 */
export function parseQuery(query: string): ParsedQuery {
	const tokens = tokenize(query);
	const required = tokens.filter((token) => !FILLER_WORDS.has(token));
	return {
		required: required.length > 0 ? required : tokens,
		optional: required.length > 0 ? tokens.filter((token) => FILLER_WORDS.has(token)) : [],
		normalized: normalizeText(query).trim()
	};
}

/**
 * The token plus a naive singular, so "servers" also finds "server" and "companies" finds "company".
 *
 * @param token - Normalized token
 */
export function tokenVariants(token: string): string[] {
	if (token.length > 4 && token.endsWith('ies')) return [token, `${token.slice(0, -3)}y`];
	if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return [token, token.slice(0, -1)];
	return [token];
}

/** A directory's searchable text, normalized once. */
export interface DirectoryText {
	id: string;
	nameWords: string[];
	topics: string[];
	description: string;
}

function textOf(entry: DirectoryEntry, name: string, description: string): DirectoryText {
	return {
		id: entry.id,
		nameWords: normalizeText(name)
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word && word !== 'awesome'),
		topics: [...entry.topics, ...entry.aliases].map(normalizeText),
		description: normalizeText(description)
	};
}

/**
 * Normalize a directory's searchable fields. The word "awesome" (in every "Awesome X" name) is ignored.
 *
 * @param directory - Loaded directory
 */
export function directoryText(directory: LoadedDirectory): DirectoryText {
	return textOf(directory.entry, directory.info.name, directory.info.description);
}

/**
 * The same text built from the registry alone (fallback name and description), for a directory that cannot be read.
 *
 * @param entry - Registry entry
 */
export function entryText(entry: DirectoryEntry): DirectoryText {
	return textOf(entry, entry.name ?? entry.host, entry.description ?? '');
}

/**
 * Score one token against a directory. `strong` says whether the token is matched by the directory's name, topics,
 * aliases or id, which is what lets the token count as matched for every item in it; a description match only adds
 * score.
 */
export function directoryTokenScore(token: string, text: DirectoryText): { score: number; strong: boolean } {
	let best = { score: 0, strong: false };
	for (const variant of tokenVariants(token)) {
		let score = 0;
		if (text.nameWords.some((word) => word.startsWith(variant))) score += DIRECTORY_WEIGHTS.nameWord;
		if (text.topics.some((topic) => topic.includes(variant))) score += DIRECTORY_WEIGHTS.topic;
		if (text.id.includes(variant)) score += DIRECTORY_WEIGHTS.id;
		const strong = score > 0;
		if (text.description.includes(variant)) score += DIRECTORY_WEIGHTS.description;
		if (score > best.score) best = { score, strong };
	}
	return best;
}

/**
 * Contract v1 token score, also trying the token's singular.
 *
 * @param token - Normalized token
 * @param text - Prepared item text
 */
export function itemTokenScore(token: string, text: PreparedText): number {
	let best = 0;
	for (const variant of tokenVariants(token)) best = Math.max(best, tokenScore(variant, text));
	return best;
}

const preparedCache = new WeakMap<readonly ItemSummary[], PreparedText[]>();

function preparedItems(items: readonly ItemSummary[]): PreparedText[] {
	let prepared = preparedCache.get(items);
	if (!prepared) {
		prepared = items.map((item) =>
			prepareText({
				name: item.name,
				description: item.description,
				taxonomy: [...item.categories, ...item.tags]
			})
		);
		preparedCache.set(items, prepared);
	}
	return prepared;
}

/** One item in a cross-directory result. */
export interface HubItem extends ItemSummary {
	directory: { id: string; name: string; url: string };
	score: number;
}

export interface MatchedDirectory {
	id: string;
	name: string;
	url: string;
	/** Items that matched, before the per-directory cap */
	hits: number;
	/** Every required word is matched by the directory itself (its name, topics, aliases or id) */
	topic_match: boolean;
}

export interface SearchAllOptions {
	category?: string;
	tag?: string;
	limit: number;
	perDirectory: number;
}

export interface SearchAllResult {
	total: number;
	matched_directories: MatchedDirectory[];
	items: HubItem[];
}

interface Candidate {
	item: ItemSummary;
	directory: LoadedDirectory;
	score: number;
	topicMatch: boolean;
}

/**
 * Rank items across directories.
 *
 * @param sources - Each directory with its item summaries
 * @param query - Parsed query (see {@link parseQuery})
 * @param options - Filters and caps
 */
export function searchAll(
	sources: ReadonlyArray<{ directory: LoadedDirectory; items: readonly ItemSummary[] }>,
	query: ParsedQuery,
	options: SearchAllOptions
): SearchAllResult {
	const candidates: Candidate[] = [];
	const matched = new Map<string, MatchedDirectory & { best: number }>();

	for (const { directory, items } of sources) {
		const dirText = directoryText(directory);
		const requiredDir = query.required.map((token) => directoryTokenScore(token, dirText));
		const optionalDir = query.optional.map((token) => directoryTokenScore(token, dirText));
		const topicMatch = requiredDir.every((entry) => entry.strong);
		const prepared = preparedItems(items);

		items.forEach((item, index) => {
			if (options.category && !matchesTaxonomy(item.category_ids, item.categories, options.category)) return;
			if (options.tag && !matchesTaxonomy(item.tag_ids, item.tags, options.tag)) return;
			const text = prepared[index] as PreparedText;
			let score = 0;
			for (let i = 0; i < query.required.length; i++) {
				const own = itemTokenScore(query.required[i] as string, text);
				const dir = requiredDir[i] as { score: number; strong: boolean };
				if (own === 0 && !dir.strong) return;
				score += own + DIRECTORY_FACTOR * dir.score;
			}
			for (let i = 0; i < query.optional.length; i++) {
				const own = itemTokenScore(query.optional[i] as string, text);
				score += OPTIONAL_FACTOR * (own + (optionalDir[i] as { score: number }).score);
			}
			if (query.normalized && text.name === query.normalized) score += 10;
			if (item.featured) score += 0.5;
			candidates.push({ item, directory, score, topicMatch });

			const entry = matched.get(directory.entry.id) ?? {
				id: directory.entry.id,
				name: directory.info.name,
				url: directory.info.url,
				hits: 0,
				topic_match: topicMatch,
				best: 0
			};
			entry.hits += 1;
			entry.best = Math.max(entry.best, score);
			matched.set(directory.entry.id, entry);
		});
	}

	candidates.sort(
		(a, b) =>
			b.score - a.score ||
			Number(b.topicMatch) - Number(a.topicMatch) ||
			a.item.name.localeCompare(b.item.name) ||
			a.directory.entry.id.localeCompare(b.directory.entry.id)
	);

	const perDirectory = new Map<string, number>();
	const items: HubItem[] = [];
	for (const candidate of candidates) {
		if (items.length >= options.limit) break;
		const id = candidate.directory.entry.id;
		const used = perDirectory.get(id) ?? 0;
		if (used >= options.perDirectory) continue;
		perDirectory.set(id, used + 1);
		items.push({
			...candidate.item,
			directory: { id, name: candidate.directory.info.name, url: candidate.directory.info.url },
			score: Math.round(candidate.score * 100) / 100
		});
	}

	const byBest = (a: { best: number } & MatchedDirectory, b: { best: number } & MatchedDirectory) =>
		b.best - a.best || Number(b.topic_match) - Number(a.topic_match) || a.name.localeCompare(b.name);
	const matchedDirectories: MatchedDirectory[] = [];
	for (const entry of [...matched.values()].sort(byBest)) {
		const { id, name, url, hits, topic_match } = entry;
		matchedDirectories.push({ id, name, url, hits, topic_match });
	}

	return { total: candidates.length, matched_directories: matchedDirectories, items };
}

/**
 * Score a directory for `list_directories`: every required word must match its name, topics, aliases, id or
 * description; `0` otherwise.
 *
 * @param directory - Loaded directory
 * @param query - Parsed query
 */
export function scoreDirectory(directory: LoadedDirectory, query: ParsedQuery): number {
	return scoreText(directoryText(directory), query);
}

/**
 * Score a registry entry the same way, from its fallback name, description, topics, aliases and id.
 *
 * @param entry - Registry entry
 * @param query - Parsed query
 */
export function scoreEntry(entry: DirectoryEntry, query: ParsedQuery): number {
	return scoreText(entryText(entry), query);
}

function scoreText(text: DirectoryText, query: ParsedQuery): number {
	let total = 0;
	for (const token of query.required) {
		const { score } = directoryTokenScore(token, text);
		if (score === 0) return 0;
		total += score;
	}
	for (const token of query.optional) total += OPTIONAL_FACTOR * directoryTokenScore(token, text).score;
	return total;
}
