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
const META_KEY_SAFE = /^[A-Za-z0-9_]+$/;

export const META_TAG_PREFIX = 'ew:';
export const SESSION_TAG_PREFIX = 'ew.session.';
export const PROJECT_TAG_PREFIX = 'ew.project.';

/** Metadata keys encoded first, in this order, so the security stamp never loses the tag budget. */
const PRIORITY_META_KEYS = ['ownerUserId', 'agentId', 'runId', 'workId', 'source', 'kind'];

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

function encodeMetaTag(key: string, value: unknown): string | null {
	if (!META_KEY_SAFE.test(key)) return null;
	let v: string;
	if (typeof value === 'string') v = value;
	else if (typeof value === 'number' && Number.isFinite(value)) v = String(value);
	else if (typeof value === 'boolean') v = value ? 'true' : 'false';
	else return null;
	if (!v || !META_VALUE_SAFE.test(v) || INJECTION_WORD.test(v)) return null;
	const tag = `${META_TAG_PREFIX}${key}=${v}`;
	return tag.length <= MEMANTO_MAX_TAG_CHARS ? tag : null;
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

	if (input.projectTagValue) push(projectTag(input.projectTagValue));
	if (input.sessionId) push(sessionTag(input.sessionId));

	const metadata = input.metadata ?? {};
	const dropped: string[] = [];
	const metaKeys = Object.keys(metadata).filter((k) => !FIELD_META_KEYS.has(k));
	const priority = PRIORITY_META_KEYS.filter((k) => metaKeys.includes(k));
	const rest = metaKeys.filter((k) => !PRIORITY_META_KEYS.includes(k));

	for (const key of priority) {
		if (!push(encodeMetaTag(key, metadata[key]))) dropped.push(key);
	}
	for (const tag of normalizeUserTags(input.userTags)) push(tag);
	for (const key of rest) {
		if (!push(encodeMetaTag(key, metadata[key]))) dropped.push(key);
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
	let sessionId: string | undefined;
	let projectTagValue: string | undefined;
	for (const tag of raw ?? []) {
		if (tag.startsWith(META_TAG_PREFIX)) {
			const body = tag.slice(META_TAG_PREFIX.length);
			const eq = body.indexOf('=');
			if (eq > 0) metadata[body.slice(0, eq)] = body.slice(eq + 1);
		} else if (tag.startsWith(SESSION_TAG_PREFIX)) {
			sessionId = tag.slice(SESSION_TAG_PREFIX.length);
		} else if (tag.startsWith(PROJECT_TAG_PREFIX)) {
			projectTagValue = tag.slice(PROJECT_TAG_PREFIX.length);
		} else if (!isReservedTag(tag)) {
			tags.push(tag);
		}
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
