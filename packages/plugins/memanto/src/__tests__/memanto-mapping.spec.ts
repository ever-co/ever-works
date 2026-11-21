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

		it('skips metadata that cannot be a safe tag and reports it', () => {
			const { tags, droppedMetadataKeys } = buildWriteTags({
				metadata: { note: 'has spaces', nested: { a: 1 }, ok: 'fine' }
			});
			expect(decodeTags(tags).metadata).toEqual({ ok: 'fine' });
			expect(droppedMetadataKeys.sort()).toEqual(['nested', 'note']);
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
