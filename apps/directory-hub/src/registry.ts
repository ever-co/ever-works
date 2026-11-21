/**
 * Directory Registry: the list of directories the hub spans (spec FR-1 to FR-6).
 *
 * Two document shapes are accepted:
 * - Directory Registry v1: `{ "version": 1, "directories": [{ "id", "url", "name"?, "description"?, "topics"?,
 *   "aliases"?, "listed"? }] }`, kept in its own catalog repository (ADR-014);
 * - a Contract v1 `items.json` of a "directory of directories", where each item's `website` is a directory origin.
 */

import { normalizeText } from './contract';

/** One directory the hub may read. `url` is always an HTTPS origin without a trailing slash. */
export interface DirectoryEntry {
	id: string;
	url: string;
	host: string;
	/** Fallback name, used only while the directory is unavailable */
	name: string | null;
	/** Fallback description, used only while the directory is unavailable */
	description: string | null;
	topics: string[];
	aliases: string[];
}

export interface Registry {
	name: string;
	entries: DirectoryEntry[];
}

/** Thrown when a registry document has neither accepted shape. */
export class RegistryError extends Error {}

/** Upper bound on registry entries, so a broken registry cannot make the hub fan out without limit. */
export const MAX_REGISTRY_ENTRIES = 2000;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown, max = 2000): string | null {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
		.map((entry) => entry.trim().slice(0, 200))
		.slice(0, 50);
}

/**
 * Parse a directory URL to its HTTPS origin; `null` for anything else (FR-3).
 *
 * @param value - URL as written in the registry
 */
export function httpsOrigin(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'https:' || url.username || url.password) return null;
		return url.origin;
	} catch {
		return null;
	}
}

function deriveId(host: string): string {
	return (host.split('.')[0] ?? host)
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 63);
}

function toEntry(raw: Record<string, unknown>, url: unknown): DirectoryEntry | null {
	if (raw['listed'] === false) return null;
	const origin = httpsOrigin(url);
	if (!origin) return null;
	const host = new URL(origin).host;
	const wantedId = typeof raw['id'] === 'string' ? raw['id'].trim().toLowerCase() : '';
	const id = ID_PATTERN.test(wantedId) ? wantedId : deriveId(host);
	if (!id) return null;
	return {
		id,
		url: origin,
		host,
		name: text(raw['name'], 200),
		description: text(raw['description']),
		topics: strings(raw['topics']),
		aliases: strings(raw['aliases'])
	};
}

/**
 * Parse a registry document.
 *
 * @param document - Parsed JSON
 * @returns The listed directories, first occurrence wins for duplicate ids or origins
 * @throws {RegistryError} When the document has neither accepted shape
 */
export function parseRegistry(document: unknown): Registry {
	const root = record(document);
	if (!root || root['version'] !== 1) throw new RegistryError('Registry must be a version 1 document');

	let raws: Array<{ raw: Record<string, unknown>; url: unknown }>;
	if (Array.isArray(root['directories'])) {
		raws = root['directories'].map(record).flatMap((raw) => (raw ? [{ raw, url: raw['url'] }] : []));
	} else if (Array.isArray(root['items'])) {
		// A "directory of directories": each item is a directory, its own website is the directory origin.
		raws = root['items'].map(record).flatMap((raw) =>
			raw
				? [
						{
							raw: {
								id: raw['slug'],
								name: raw['name'],
								description: raw['description'],
								topics: [...strings(raw['categories']), ...strings(raw['tags'])]
							},
							url: raw['website']
						}
					]
				: []
		);
	} else {
		throw new RegistryError('Registry must have a "directories" or an "items" array');
	}

	const entries: DirectoryEntry[] = [];
	const seen = new Set<string>();
	for (const { raw, url } of raws) {
		const entry = toEntry(raw, url);
		if (!entry || seen.has(entry.id) || seen.has(entry.url)) continue;
		seen.add(entry.id);
		seen.add(entry.url);
		entries.push(entry);
		if (entries.length >= MAX_REGISTRY_ENTRIES) break;
	}
	return { name: text(root['name'], 200) ?? 'Ever Works directories', entries };
}

/**
 * Resolve a caller's `directory` value (id, hostname or origin) to a registry entry. Never returns anything that is
 * not in the registry, so a caller can never make the hub fetch an arbitrary host (FR-23).
 *
 * @param registry - Parsed registry
 * @param value - Caller input
 */
export function resolveEntry(registry: Registry, value: string): DirectoryEntry | undefined {
	const wanted = normalizeText(value.trim());
	if (!wanted) return undefined;
	const byId = registry.entries.find((entry) => entry.id === wanted);
	if (byId) return byId;
	const origin = httpsOrigin(wanted);
	if (origin) return registry.entries.find((entry) => entry.url === origin);
	const host = wanted.replace(/\/+$/, '');
	return registry.entries.find((entry) => entry.host === host);
}
