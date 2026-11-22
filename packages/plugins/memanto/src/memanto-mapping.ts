import { createHash } from 'node:crypto';
import type { AgentMemoryRecord } from '@ever-works/plugin';
import {
	DEFAULT_AGENT_PREFIX,
	MEMANTO_MAX_AGENT_ID_CHARS,
	MEMANTO_MAX_TAGS,
	MEMANTO_MAX_TAG_CHARS,
	MEMANTO_MEMORY_TYPES,
	type MemantoMemoryItem,
	type MemantoMemoryType
} from './types.js';

/**
 * Pure mapping between the Ever Works `agent-memory` contract and Memanto.
 *
 * ## Why tags carry metadata
 *
 * Memanto stores a flat, fixed schema (content, title, type, confidence,
 * tags, source, provenance, lifecycle). It has NO free-form `metadata`
 * field. The platform relies on metadata round-tripping — most importantly
 * the `ownerUserId` stamp the API controller writes on every save and reads
 * back before a delete-by-id (EW-711 #29, IDOR guard). Dropping it would
 * silently turn that check fail-open. So scalar metadata is encoded into
 * reserved tags and decoded on read:
 *
 *   - `ew:<key>=<value>`   — metadata (not filterable; `:` is allowed on
 *                            write but rejected as a recall filter token).
 *   - `ew:<key>.<i>.<n>=<part>`  — a value too long for one 64-char tag,
 *                            split into `n` parts (`i` = 0…n-1) and joined on
 *                            read; `ew:<key>.x<i>.<n>=` when the value holds
 *                            characters outside the tag-safe set, so the
 *                            joined parts are its base64url (UTF-8) form. A
 *                            value is restored only when every part is there.
 *   - `ew.session.<id>`    — the Ever Works session a memory was written in.
 *   - `ew.project.<id>`    — the project, only when several projects share one
 *                            pinned Memanto agent (`agentId` setting); used as
 *                            a recall filter, hence the filter-safe charset.
 *
 * Reserved tags are stripped from the `tags` the platform sees. User tags
 * are normalised to Memanto's recall-filter charset (`[A-Za-z0-9_.-]`) on
 * BOTH write and search, so a tag that was saved can always be filtered on.
 */

const FILTER_SAFE = /[^A-Za-z0-9_.-]+/g;
const AGENT_ID_UNSAFE = /[^A-Za-z0-9_-]+/g;
/** Tag values Memanto's injection guard would reject (`INJECTION_PATTERNS`, whitespace-free forms). */
const INJECTION_WORD = /\bexfiltrate\b/i;
/** Metadata values we are willing to encode: no whitespace, commas or control chars. */
const META_VALUE_SAFE = /^[A-Za-z0-9_.:@/+-]+$/;
/** Key charset. No `.` or `-`, so `<key>.<i>.<n>` can never be mistaken for a plain key. */
const META_KEY_CHARS = 'A-Za-z0-9_';
const META_KEY_SAFE = new RegExp(`^[${META_KEY_CHARS}]+$`);
/** Keys that would reach Object.prototype when assigned on a plain object. */
const FORBIDDEN_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isMetaKey(key: string): boolean {
	return META_KEY_SAFE.test(key) && !FORBIDDEN_META_KEYS.has(key);
}
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const META_TAG_PREFIX = 'ew:';
export const SESSION_TAG_PREFIX = 'ew.session.';
export const PROJECT_TAG_PREFIX = 'ew.project.';

/** Metadata keys encoded first, in this order, so the security stamp never loses the tag budget. */
const PRIORITY_META_KEYS = ['ownerUserId', 'agentId', 'runId', 'workId', 'source', 'kind'];

/**
 * Provenance keys encoded right after the user tags, before any other
 * metadata: Memory source facets and chat citations read them back
 * (`event-ingest.service.ts`, `meetings.service.ts`).
 */
const PROVENANCE_META_KEYS = ['sourceUrl', 'sourceEventId', 'ingestedEventId'];

/**
 * The most parts one value may take. Every tag is appended to the text
 * Memanto embeds, so a longer value is dropped rather than spread across
 * half the 20-tag budget. One digit keeps the part header a fixed width.
 */
const MAX_META_PARTS = 6;
const META_PART_NAME = new RegExp(`^([${META_KEY_CHARS}]+)\\.(x?)(\\d)\\.(\\d)$`);

/**
 * Strict base64url → UTF-8: `null` unless the text is canonical base64url
 * (it re-encodes to itself) of valid UTF-8. `Buffer.from` alone skips bad
 * characters silently, which would turn a damaged part into garbage metadata.
 */
function decodeBase64urlStrict(text: string): string | null {
	if (!BASE64URL.test(text)) return null;
	const bytes = Buffer.from(text, 'base64url');
	if (bytes.toString('base64url') !== text) return null;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Reserved metadata keys that map onto first-class Memanto fields instead of tags. */
const FIELD_META_KEYS = new Set(['memoryType', 'title', 'confidence']);

export function isReservedTag(tag: string): boolean {
	return tag.startsWith('ew:') || tag.startsWith('ew.');
}

/** Normalise one user tag to the recall-filter charset; '' when nothing usable is left. */
export function normalizeUserTag(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	// The reserved namespace is ours: a user tag can never claim it, not even
	// in a form that normalisation would turn into something harmless.
	if (/^\s*ew[:.]/i.test(raw)) return '';
	const tag = raw
		.trim()
		.replace(FILTER_SAFE, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, MEMANTO_MAX_TAG_CHARS);
	if (!tag || isReservedTag(tag) || INJECTION_WORD.test(tag)) return '';
	return tag;
}

export function normalizeUserTags(raw: readonly unknown[] | undefined): string[] {
	if (!raw) return [];
	const out: string[] = [];
	for (const t of raw) {
		const tag = normalizeUserTag(t);
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out;
}

/** Filter-safe id fragment for session / project tags. */
export function tagSafeId(id: string): string {
	return id.replace(FILTER_SAFE, '-').slice(0, MEMANTO_MAX_TAG_CHARS - SESSION_TAG_PREFIX.length);
}

export function sessionTag(sessionId: string): string {
	return `${SESSION_TAG_PREFIX}${tagSafeId(sessionId)}`;
}

export function projectTag(projectId: string): string {
	return `${PROJECT_TAG_PREFIX}${tagSafeId(projectId)}`;
}

function metaValueString(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	return null;
}

/**
 * The tags that carry one metadata value: one `ew:<key>=<value>` tag when it
 * fits, else up to {@link MAX_META_PARTS} part tags; `null` when the value
 * cannot be stored (not a scalar, injection-shaped, or too long).
 */
function encodeMetaTags(key: string, value: unknown): string[] | null {
	if (!isMetaKey(key)) return null;
	const v = metaValueString(value);
	// The WHOLE value is checked first; the per-part check below is extra, never a replacement.
	if (!v || INJECTION_WORD.test(v)) return null;
	const plain = META_VALUE_SAFE.test(v);
	if (plain) {
		const tag = `${META_TAG_PREFIX}${key}=${v}`;
		if (tag.length <= MEMANTO_MAX_TAG_CHARS) return [tag];
	}
	const body = plain ? v : Buffer.from(v, 'utf8').toString('base64url');
	const marker = plain ? '' : 'x';
	// `ew:` + key + `.` + marker + one-digit index + `.` + one-digit count + `=`
	const room = MEMANTO_MAX_TAG_CHARS - (META_TAG_PREFIX.length + key.length + marker.length + 5);
	if (room < 8) return null;
	const n = Math.ceil(body.length / room);
	if (n > MAX_META_PARTS) return null;
	const tags: string[] = [];
	for (let i = 0; i < n; i++) {
		const part = body.slice(i * room, (i + 1) * room);
		// A cut can turn `exfiltrated` into a part ending in `exfiltrate`, which Memanto would reject
		// (and the whole write with it). The base64url alphabet can spell it too, so a rare valid
		// value is dropped here on purpose: a lost key beats a lost memory.
		if (INJECTION_WORD.test(part)) return null;
		tags.push(`${META_TAG_PREFIX}${key}.${marker}${i}.${n}=${part}`);
	}
	return tags;
}

/**
 * Assemble the tag list for one write, within Memanto's 20-tag cap:
 * internal routing tags and priority metadata (owner stamp first) win the
 * budget, then user tags, then any remaining encodable metadata.
 */
export function buildWriteTags(input: {
	userTags?: readonly unknown[];
	metadata?: Record<string, unknown>;
	sessionId?: string;
	projectTagValue?: string;
}): { tags: string[]; droppedMetadataKeys: string[] } {
	const tags: string[] = [];
	const push = (t: string | null): boolean => {
		if (!t || tags.includes(t) || tags.length >= MEMANTO_MAX_TAGS) return false;
		tags.push(t);
		return true;
	};
	// All of a value's tags or none: half a URL is worse than no URL.
	const pushAll = (group: string[] | null): boolean => {
		if (!group || tags.length + group.length > MEMANTO_MAX_TAGS) return false;
		if (group.some((t) => tags.includes(t))) return false;
		tags.push(...group);
		return true;
	};

	if (input.projectTagValue) push(projectTag(input.projectTagValue));
	if (input.sessionId) push(sessionTag(input.sessionId));

	const metadata = input.metadata ?? {};
	const dropped: string[] = [];
	const metaKeys = Object.keys(metadata).filter((k) => !FIELD_META_KEYS.has(k));
	const priority = PRIORITY_META_KEYS.filter((k) => metaKeys.includes(k));
	const provenance = PROVENANCE_META_KEYS.filter((k) => metaKeys.includes(k));
	const rest = metaKeys.filter((k) => !PRIORITY_META_KEYS.includes(k) && !PROVENANCE_META_KEYS.includes(k));

	for (const key of priority) {
		if (!pushAll(encodeMetaTags(key, metadata[key]))) dropped.push(key);
	}
	for (const tag of normalizeUserTags(input.userTags)) push(tag);
	for (const key of [...provenance, ...rest]) {
		if (!pushAll(encodeMetaTags(key, metadata[key]))) dropped.push(key);
	}
	return { tags, droppedMetadataKeys: dropped };
}

/** Split a stored tag list back into user tags, metadata and the session id. */
export function decodeTags(raw: readonly string[] | undefined): {
	tags: string[];
	metadata: Record<string, string>;
	sessionId?: string;
	projectTagValue?: string;
} {
	const tags: string[] = [];
	const metadata: Record<string, string> = {};
	const parted = new Map<string, { encoded: boolean; count: number; parts: Map<number, string> }>();
	let sessionId: string | undefined;
	let projectTagValue: string | undefined;
	for (const tag of raw ?? []) {
		if (tag.startsWith(META_TAG_PREFIX)) {
			const body = tag.slice(META_TAG_PREFIX.length);
			const eq = body.indexOf('=');
			if (eq <= 0) continue;
			const name = body.slice(0, eq);
			const value = body.slice(eq + 1);
			const part = META_PART_NAME.exec(name);
			if (!part) {
				// Only keys the writer could have produced; never `__proto__` & co.
				if (isMetaKey(name)) metadata[name] = value;
				continue;
			}
			const [, key, x, index, count] = part;
			if (!isMetaKey(key)) continue;
			const entry = parted.get(key) ?? { encoded: x === 'x', count: Number(count), parts: new Map() };
			// Parts that disagree on encoding or count belong to no single value.
			if (entry.encoded !== (x === 'x') || entry.count !== Number(count)) entry.count = -1;
			entry.parts.set(Number(index), value);
			parted.set(key, entry);
		} else if (tag.startsWith(SESSION_TAG_PREFIX)) {
			sessionId = tag.slice(SESSION_TAG_PREFIX.length);
		} else if (tag.startsWith(PROJECT_TAG_PREFIX)) {
			projectTagValue = tag.slice(PROJECT_TAG_PREFIX.length);
		} else if (!isReservedTag(tag)) {
			tags.push(tag);
		}
	}
	for (const [key, { encoded, count, parts }] of parted) {
		if (count < 1 || parts.size !== count || Object.prototype.hasOwnProperty.call(metadata, key)) continue;
		const pieces: string[] = [];
		for (let i = 0; i < count; i++) {
			const piece = parts.get(i);
			if (piece === undefined) break;
			pieces.push(piece);
		}
		if (pieces.length !== count) continue;
		const joined = pieces.join('');
		const value = encoded ? decodeBase64urlStrict(joined) : joined;
		if (value) metadata[key] = value;
	}
	return { tags, metadata, sessionId, projectTagValue };
}

/** Clamp text to `max` chars, marking the cut. */
export function clampText(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

export function toMemantoType(value: unknown): MemantoMemoryType | undefined {
	return typeof value === 'string' && (MEMANTO_MEMORY_TYPES as readonly string[]).includes(value)
		? (value as MemantoMemoryType)
		: undefined;
}

/**
 * Memanto agent id for a project: `<prefix>-<projectId>` sanitised to
 * `^[a-zA-Z0-9_-]+$`, or the bare prefix when there is no project. An
 * over-long id is shortened with a stable hash so two projects never collide.
 */
export function deriveAgentId(prefix: string | undefined, projectId: string | undefined): string {
	const p = sanitizeAgentId(prefix || DEFAULT_AGENT_PREFIX) || DEFAULT_AGENT_PREFIX;
	if (!projectId) return p.slice(0, MEMANTO_MAX_AGENT_ID_CHARS);
	const candidate = `${p}-${sanitizeAgentId(projectId)}`;
	if (candidate.length <= MEMANTO_MAX_AGENT_ID_CHARS) return candidate;
	const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 16);
	return `${p.slice(0, MEMANTO_MAX_AGENT_ID_CHARS - hash.length - 1)}-${hash}`;
}

export function sanitizeAgentId(value: string): string {
	return value
		.replace(AGENT_ID_UNSAFE, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Record ids handed to the platform are `<memantoAgentId>:<memoryId>`, so a
 * later `deleteEntry(id)` — which carries no project — still reaches the
 * right Memanto agent. Neither half can contain `:`.
 */
export function composeRecordId(agentId: string, memoryId: string): string {
	return `${agentId}:${memoryId}`;
}

export function parseRecordId(id: string): { agentId?: string; memoryId: string } {
	const idx = id.indexOf(':');
	if (idx <= 0) return { memoryId: id };
	return { agentId: id.slice(0, idx), memoryId: id.slice(idx + 1) };
}

/** Map a Memanto `MemoryItem` onto the platform record shape. */
export function toAgentMemoryRecord(item: MemantoMemoryItem, agentId: string, projectId?: string): AgentMemoryRecord {
	const decoded = decodeTags(item.tags);
	const metadata: Record<string, unknown> = { ...decoded.metadata };
	if (item.type) metadata.memoryType = item.type;
	if (item.title) metadata.title = item.title;
	if (typeof item.confidence === 'number') metadata.confidence = item.confidence;
	if (item.status) metadata.status = item.status;
	if (item.provenance) metadata.provenance = item.provenance;
	return {
		id: composeRecordId(agentId, item.id),
		content: item.content ?? item.text ?? '',
		...(decoded.tags.length > 0 ? { tags: decoded.tags } : {}),
		metadata,
		...(decoded.sessionId ? { sessionId: decoded.sessionId } : {}),
		...(projectId ? { projectId } : {}),
		createdAt: item.created_at ?? new Date().toISOString(),
		...(typeof item.score === 'number' ? { score: item.score } : {})
	};
}

/** One prompt line per memory: `- [type] content`. */
export function formatContextLine(item: MemantoMemoryItem): string {
	const type = item.type ? `[${item.type}] ` : '';
	const body = (item.content ?? item.text ?? '').replace(/\s+/g, ' ').trim();
	return `- ${type}${body}`;
}

/**
 * Pack recalled memories into a context payload of at most `maxChars`,
 * best-first (the input order). Whole lines only, so no memory is cut
 * mid-sentence; returns the lines used for `references`.
 */
export function packContext(
	items: readonly MemantoMemoryItem[],
	maxChars: number
): { content: string; used: MemantoMemoryItem[] } {
	const lines: string[] = [];
	const used: MemantoMemoryItem[] = [];
	let size = 0;
	for (const item of items) {
		const line = formatContextLine(item);
		if (line.length <= 2) continue;
		const add = (lines.length > 0 ? 1 : 0) + line.length;
		if (size + add > maxChars) {
			if (lines.length === 0) {
				// A single huge memory still contributes its head rather than nothing.
				lines.push(clampText(line, maxChars));
				used.push(item);
			}
			break;
		}
		lines.push(line);
		used.push(item);
		size += add;
	}
	return { content: lines.join('\n'), used };
}
