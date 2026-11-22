import { describe, it, expect } from 'vitest';
import {
	buildWriteTags,
	composeRecordId,
	decodeTags,
	deriveAgentId,
	normalizeUserTag,
	normalizeUserTags,
	packContext,
	parseRecordId,
	projectTag,
	sessionTag,
	toAgentMemoryRecord,
	toMemantoType
} from '../memanto-mapping.js';
import { MEMANTO_MAX_TAGS } from '../types.js';

describe('memanto mapping', () => {
	describe('user tags', () => {
		it('normalises to the recall-filter charset so a saved tag can always be filtered on', () => {
			expect(normalizeUserTag('Bug Fix')).toBe('Bug-Fix');
			expect(normalizeUserTag('#auth')).toBe('auth');
			expect(normalizeUserTag('a,b')).toBe('a-b');
			expect(normalizeUserTag('  ')).toBe('');
			expect(normalizeUserTag(42)).toBe('');
		});

		it('drops reserved prefixes and Memanto-injection-shaped tags', () => {
			expect(normalizeUserTag('ew:ownerUserId=x')).toBe('');
			expect(normalizeUserTag('ew.session.abc')).toBe('');
			expect(normalizeUserTag('exfiltrate')).toBe('');
		});

		it('de-duplicates after normalisation', () => {
			expect(normalizeUserTags(['deploy', ' deploy ', '#deploy', 'auth'])).toEqual(['deploy', 'auth']);
		});
	});

	describe('metadata codec', () => {
		it('round-trips the ownerUserId IDOR stamp and other scalar metadata through tags', () => {
			const { tags } = buildWriteTags({
				userTags: ['deploy'],
				metadata: { ownerUserId: '7f1c9a2e-1111-4222-8333-944455556666', runId: 'run-9', attempt: 2 },
				sessionId: 'ews_abc'
			});
			const decoded = decodeTags(tags);
			expect(decoded.tags).toEqual(['deploy']);
			expect(decoded.sessionId).toBe('ews_abc');
			expect(decoded.metadata).toEqual({
				ownerUserId: '7f1c9a2e-1111-4222-8333-944455556666',
				runId: 'run-9',
				attempt: '2'
			});
		});

		it('keeps the owner stamp even when user tags would exhaust the 20-tag budget', () => {
			const userTags = Array.from({ length: 40 }, (_, i) => `tag${i}`);
			const { tags } = buildWriteTags({ userTags, metadata: { ownerUserId: 'u-1' }, sessionId: 's1' });
			expect(tags).toHaveLength(MEMANTO_MAX_TAGS);
			expect(decodeTags(tags).metadata.ownerUserId).toBe('u-1');
		});

		it('skips metadata that cannot be a tag at all and reports it', () => {
			const { tags, droppedMetadataKeys } = buildWriteTags({
				metadata: { nested: { a: 1 }, 'bad key': 'x', empty: '', leak: 'exfiltrate', ok: 'fine' }
			});
			expect(decodeTags(tags).metadata).toEqual({ ok: 'fine' });
			expect(droppedMetadataKeys.sort()).toEqual(['bad key', 'empty', 'leak', 'nested']);
		});

		it('stores a value with unsafe characters as base64url and restores it exactly', () => {
			const note = 'has spaces, a comma\nand ünïcode';
			const { tags, droppedMetadataKeys } = buildWriteTags({ metadata: { note } });
			expect(droppedMetadataKeys).toEqual([]);
			for (const t of tags) expect(t).toMatch(/^[^,\x00-\x1f]{1,64}$/);
			expect(decodeTags(tags).metadata).toEqual({ note });
		});

		it('splits ingest provenance longer than one tag across parts and joins it back (prod 2026-11-22)', () => {
			const metadata = {
				ingestedEventId: 'a3f2c1d0-1111-4222-8333-944455556666',
				source: 'github',
				sourceEventId:
					'push:ever-co/ever-works@0259e030dae28c7dde839d03c9bef3b09fbaa9e0:release/round-6-directory-hub',
				kind: 'git.push',
				occurredAt: '2026-11-22T01:25:45.123Z',
				sourceUrl: 'https://github.com/ever-co/ever-works/pull/3301#issuecomment-7072113907',
				actorName: 'evereq',
				subjectType: 'pull_request',
				subjectExternalId: 'ever-co/ever-works#3301',
				organizationId: 'org_01HZY3'
			};
			const { tags, droppedMetadataKeys } = buildWriteTags({
				userTags: ['ingested-event', 'source:github', 'kind:git.push', 'work:w1'],
				metadata,
				projectTagValue: 'w1'
			});
			expect(tags.length).toBeLessThanOrEqual(MEMANTO_MAX_TAGS);
			for (const t of tags) expect(t.length).toBeLessThanOrEqual(64);
			expect(droppedMetadataKeys).not.toContain('sourceUrl');
			expect(droppedMetadataKeys).not.toContain('sourceEventId');
			const decoded = decodeTags(tags).metadata;
			expect(decoded.sourceUrl).toBe(metadata.sourceUrl);
			expect(decoded.sourceEventId).toBe(metadata.sourceEventId);
			for (const key of Object.keys(metadata) as (keyof typeof metadata)[]) {
				if (!droppedMetadataKeys.includes(key)) expect(decoded[key]).toBe(metadata[key]);
			}
		});

		it('keeps a short safe value as one plain tag (unchanged format)', () => {
			const { tags } = buildWriteTags({ metadata: { runId: 'run-9' } });
			expect(tags).toEqual(['ew:runId=run-9']);
		});

		it('writes all parts of a value or none when the tag budget runs out', () => {
			const userTags = Array.from({ length: 18 }, (_, i) => `tag${i}`);
			const sourceUrl = `https://example.com/${'p'.repeat(80)}`;
			const { tags, droppedMetadataKeys } = buildWriteTags({ userTags, metadata: { sourceUrl } });
			expect(droppedMetadataKeys).toEqual(['sourceUrl']);
			expect(tags.some((t) => t.startsWith('ew:sourceUrl'))).toBe(false);
			expect(decodeTags(tags).metadata).toEqual({});
		});

		it('drops a value that would need more than six parts', () => {
			const { droppedMetadataKeys } = buildWriteTags({ metadata: { sourceUrl: `https://x/${'a'.repeat(400)}` } });
			expect(droppedMetadataKeys).toEqual(['sourceUrl']);
		});

		it('never restores a value from an incomplete or inconsistent set of parts', () => {
			const { tags } = buildWriteTags({ metadata: { sourceUrl: `https://example.com/${'q'.repeat(80)}` } });
			expect(tags.length).toBeGreaterThan(1);
			expect(decodeTags(tags.slice(1)).metadata).toEqual({});
			const forged = [...tags, 'ew:sourceUrl.x0.2=AAAA'];
			expect(decodeTags(forged).metadata).toEqual({});
		});

		it('does not let a part cut produce an injection-shaped tag Memanto would reject', () => {
			const value = `${'a'.repeat(40)}/exfiltrated/${'b'.repeat(40)}`;
			const { tags } = buildWriteTags({ metadata: { sourceUrl: value } });
			for (const t of tags) expect(t).not.toMatch(/\bexfiltrate\b/i);
		});

		it('round-trips a value that is both unsafe and long (base64url split across parts)', () => {
			const title = `Ünïcode, commas & spaces: ${'déjà vu / '.repeat(8)}#end`;
			const { tags, droppedMetadataKeys } = buildWriteTags({ metadata: { note: title } });
			expect(droppedMetadataKeys).toEqual([]);
			const parts = tags.filter((t) => t.startsWith('ew:note.x'));
			expect(parts.length).toBeGreaterThan(1);
			expect(parts.length).toBe(tags.length);
			for (const t of tags) expect(t.length).toBeLessThanOrEqual(64);
			expect(decodeTags(tags).metadata).toEqual({ note: title });
		});

		it('drops a damaged base64url value instead of decoding garbage', () => {
			const { tags } = buildWriteTags({ metadata: { note: 'has spaces and ünïcode' } });
			const damaged = tags.map((t) => t.replace(/=(.)/, '=*'));
			expect(decodeTags(damaged).metadata).toEqual({});
			// Canonical alphabet but not valid UTF-8 (a lone continuation byte).
			expect(decodeTags(['ew:note.x0.1=gA']).metadata).toEqual({});
		});

		it('never splits a key outside the key charset, so it cannot decode as a different key', () => {
			const { tags, droppedMetadataKeys } = buildWriteTags({
				metadata: { 'source-url': `https://example.com/${'r'.repeat(80)}`, 'a.b': 'x' }
			});
			expect(tags).toEqual([]);
			expect(droppedMetadataKeys.sort()).toEqual(['a.b', 'source-url']);
		});

		it('still rejects the whole value when an injection word sits where a part boundary would fall', () => {
			for (let pad = 30; pad < 60; pad++) {
				const value = `https://example.com/${'c'.repeat(pad)}/exfiltrate/${'d'.repeat(40)}`;
				const { tags, droppedMetadataKeys } = buildWriteTags({ metadata: { sourceUrl: value } });
				expect(droppedMetadataKeys).toEqual(['sourceUrl']);
				expect(tags).toEqual([]);
			}
		});

		it('never assigns prototype keys from stored tags, plain or parted', () => {
			const decoded = decodeTags([
				'ew:__proto__=x',
				'ew:constructor=y',
				'ew:prototype.0.1=z',
				'ew:bad-key=w',
				'ew:ok=1'
			]).metadata;
			expect(decoded).toEqual({ ok: '1' });
			expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
			expect(buildWriteTags({ metadata: { constructor: 'c', ok: '1' } }).droppedMetadataKeys).toEqual([
				'constructor'
			]);
		});

		it('prefers a single plain tag over parts with the same key on read', () => {
			expect(decodeTags(['ew:runId=a', 'ew:runId.0.1=b']).metadata).toEqual({ runId: 'a' });
		});

		it('does not encode the fields Memanto stores natively', () => {
			const { tags } = buildWriteTags({ metadata: { memoryType: 'decision', title: 't', confidence: 0.9 } });
			expect(tags).toEqual([]);
		});

		it('adds the filter-safe project tag when agents are shared', () => {
			const { tags } = buildWriteTags({ projectTagValue: 'work-1' });
			expect(tags).toEqual([projectTag('work-1')]);
			expect(projectTag('work-1')).toMatch(/^[A-Za-z0-9_.-]+$/);
			expect(sessionTag('ews_1')).toMatch(/^[A-Za-z0-9_.-]+$/);
		});
	});

	describe('agent ids', () => {
		it('derives <prefix>-<project> within Memanto agent_id rules', () => {
			expect(deriveAgentId(undefined, 'b1c2-uuid')).toBe('ever-works-b1c2-uuid');
			expect(deriveAgentId('acme', undefined)).toBe('acme');
			expect(deriveAgentId('ac me!', 'x/y')).toBe('ac-me-x-y');
		});

		it('hashes over-long ids stably and without collisions', () => {
			const a = deriveAgentId('ever-works', 'p'.repeat(200));
			const b = deriveAgentId('ever-works', 'q'.repeat(200));
			expect(a.length).toBeLessThanOrEqual(64);
			expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(a).not.toBe(b);
			expect(deriveAgentId('ever-works', 'p'.repeat(200))).toBe(a);
		});

		it('composes and parses record ids', () => {
			const id = composeRecordId('ever-works-w1', 'd4ed0fa2-8bd0-44c1-a34d-49443370bb57');
			expect(parseRecordId(id)).toEqual({
				agentId: 'ever-works-w1',
				memoryId: 'd4ed0fa2-8bd0-44c1-a34d-49443370bb57'
			});
			expect(parseRecordId('bare-id')).toEqual({ memoryId: 'bare-id' });
		});
	});

	describe('records', () => {
		it('maps a Memanto MemoryItem, hiding reserved tags and surfacing typed fields as metadata', () => {
			const record = toAgentMemoryRecord(
				{
					id: 'm1',
					title: 'Staging deploys',
					content: 'Staging deploys go through ArgoCD.',
					type: 'instruction',
					confidence: 0.8,
					status: 'active',
					tags: ['deploy', 'ew.session.ews_1', 'ew:ownerUserId=u-1'],
					created_at: '2026-11-21T03:17:24+00:00',
					score: 0.4
				},
				'ever-works-w1',
				'w1'
			);
			expect(record).toEqual({
				id: 'ever-works-w1:m1',
				content: 'Staging deploys go through ArgoCD.',
				tags: ['deploy'],
				metadata: {
					ownerUserId: 'u-1',
					memoryType: 'instruction',
					title: 'Staging deploys',
					confidence: 0.8,
					status: 'active'
				},
				sessionId: 'ews_1',
				projectId: 'w1',
				createdAt: '2026-11-21T03:17:24+00:00',
				score: 0.4
			});
		});

		it('accepts only real Memanto memory types', () => {
			expect(toMemantoType('decision')).toBe('decision');
			expect(toMemantoType('nonsense')).toBeUndefined();
		});
	});

	describe('packContext', () => {
		const item = (content: string, type = 'fact') => ({ id: content, content, type });

		it('packs whole lines best-first within the budget', () => {
			const { content, used } = packContext(
				[item('a'.repeat(30)), item('b'.repeat(30)), item('c'.repeat(30))],
				85
			);
			expect(used).toHaveLength(2);
			expect(content.split('\n')).toHaveLength(2);
			expect(content.startsWith('- [fact] aaa')).toBe(true);
		});

		it('still returns the head of one oversized memory', () => {
			const { content, used } = packContext([item('x'.repeat(500))], 100);
			expect(used).toHaveLength(1);
			expect(content.length).toBe(100);
		});

		it('returns empty content for no memories', () => {
			expect(packContext([], 100)).toEqual({ content: '', used: [] });
		});
	});
});
