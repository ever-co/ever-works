import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { KnowledgeBaseService } from './knowledge-base.service';
import { hashNormalizedBody } from './kb-content-hash';
import { KB_MIRROR_RETIRED_PATHS_KEY } from './kb-document-move';
import { ActivityActionType } from '../entities/activity-log.types';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import {
    KbCitationConsumerType,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
    KbReviewState,
} from '../entities/kb-types';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID = '00000000-0000-0000-0000-0000000000aa';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const DOC_ID = '00000000-0000-0000-0000-000000000010';
const LINKING_ID = '00000000-0000-0000-0000-000000000011';
const MD_LINKING_ID = '00000000-0000-0000-0000-000000000012';
const UNRELATED_ID = '00000000-0000-0000-0000-000000000013';

let seq = 0;
function buildDocument(overrides: Partial<WorkKnowledgeDocument> = {}): WorkKnowledgeDocument {
    const body = ((overrides.metadata ?? {}) as { body?: string }).body ?? '# Voice';
    seq += 1;
    return {
        id: DOC_ID,
        workId: WORK_ID,
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Voice',
        description: null,
        kbDocumentClass: KbDocumentClass.BRAND,
        tags: null,
        categories: null,
        status: KbDocumentStatus.ACTIVE,
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: 2,
        tokenCount: 2,
        source: KbDocumentSource.USER,
        metadata: { body },
        revision: 3,
        revisionAt: new Date('2026-09-01T00:00:00Z'),
        normalizedContentHash: hashNormalizedBody(body),
        reviewState: KbReviewState.ACCEPTED,
        decision: null,
        folderId: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)),
        ...overrides,
    } as WorkKnowledgeDocument;
}

/**
 * An in-memory `WorkKnowledgeDocumentRepository`: enough of it for the move
 * to run against rows that behave like rows — `update` is a real
 * compare-and-set on `revision`, `list` pages, `pathExists` excludes an id.
 */
class FakeDocuments {
    readonly rows = new Map<string, WorkKnowledgeDocument>();
    readonly orgRows: WorkKnowledgeDocument[] = [];
    readonly updates: Array<{
        id: string;
        patch: Partial<WorkKnowledgeDocument>;
        expectedRevision?: number;
    }> = [];

    add(...docs: WorkKnowledgeDocument[]): void {
        for (const doc of docs) this.rows.set(doc.id, { ...doc });
    }

    findById = jest.fn(async (workId: string, id: string) => {
        const row = this.rows.get(id);
        return row && row.workId === workId ? { ...row } : null;
    });

    findByWorkOrPath = jest.fn(async (workId: string, idOrPath: string) => {
        const row = [...this.rows.values()].find(
            (doc) => doc.workId === workId && (doc.id === idOrPath || doc.path === idOrPath),
        );
        return row ? { ...row } : null;
    });

    findOrgByPath = jest.fn(async (organizationId: string, path: string) => {
        return (
            this.orgRows.find((d) => d.organizationId === organizationId && d.path === path) ?? null
        );
    });

    pathExists = jest.fn(async (workId: string, path: string, excludeId?: string) =>
        [...this.rows.values()].some(
            (doc) => doc.workId === workId && doc.path === path && doc.id !== excludeId,
        ),
    );

    list = jest.fn(async (opts: { workId: string; limit?: number; offset?: number }) => {
        const all = [...this.rows.values()]
            .filter((doc) => doc.workId === opts.workId)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        const offset = opts.offset ?? 0;
        const items = all.slice(offset, opts.limit === undefined ? undefined : offset + opts.limit);
        return { items: items.map((doc) => ({ ...doc })), total: all.length };
    });

    update = jest.fn(
        async (
            id: string,
            patch: Partial<WorkKnowledgeDocument>,
            opts: { expectedRevision?: number } = {},
        ) => {
            this.updates.push({ id, patch, expectedRevision: opts.expectedRevision });
            const row = this.rows.get(id);
            if (!row) return null;
            if (opts.expectedRevision !== undefined && row.revision !== opts.expectedRevision) {
                return null;
            }
            const next = { ...row, ...patch, updatedAt: new Date() } as WorkKnowledgeDocument;
            this.rows.set(id, next);
            return { ...next };
        },
    );
}

describe('KnowledgeBaseService.moveDocument — rename a Work document', () => {
    let docs: FakeDocuments;
    let ownership: { ensureCanEdit: jest.Mock; ensureCanView: jest.Mock };
    let activityLog: { log: jest.Mock };
    let mirrorDispatcher: { dispatchKbMirrorDocument: jest.Mock };
    let embedDispatcher: { dispatchKbEmbedDocument: jest.Mock };
    let workRepository: { findById: jest.Mock; findIdsByOrganization: jest.Mock };
    let citations: { listForDocument: jest.Mock };
    let domainEvents: { transaction: jest.Mock; changed: jest.Mock; created: jest.Mock };

    function build(overrides: { mirror?: unknown } = {}): KnowledgeBaseService {
        const args: unknown[] = new Array(22).fill(undefined);
        args[0] = docs;
        args[1] = {};
        args[2] = { upsertBySlug: jest.fn() };
        args[3] = citations;
        args[4] = ownership;
        args[5] = 'mirror' in overrides ? overrides.mirror : mirrorDispatcher;
        args[8] = activityLog;
        args[10] = embedDispatcher;
        args[16] = workRepository;
        args[21] = domainEvents;
        return new (KnowledgeBaseService as unknown as new (
            ...a: unknown[]
        ) => KnowledgeBaseService)(...args);
    }

    const events = () =>
        domainEvents.changed.mock.calls.map(([, , id, type, change]) => ({ id, type, change }));
    const mirrored = () =>
        mirrorDispatcher.dispatchKbMirrorDocument.mock.calls.map(([payload]) => ({
            documentId: payload.documentId,
            operation: payload.operation,
            path: payload.path,
        }));

    beforeEach(() => {
        docs = new FakeDocuments();
        docs.add(
            buildDocument(),
            buildDocument({
                id: LINKING_ID,
                path: 'brand/guide.md',
                slug: 'guide',
                title: 'Guide',
                metadata: { body: 'Write like [[brand/voice.md]], see [[Voice|brand/voice.md]].' },
            }),
            buildDocument({
                id: MD_LINKING_ID,
                path: 'output/post.md',
                slug: 'post',
                title: 'Post',
                kbDocumentClass: KbDocumentClass.OUTPUT,
                status: KbDocumentStatus.DRAFT,
                metadata: { body: `Per [Voice](/works/${WORK_ID}/kb/brand/voice.md).` },
            }),
            buildDocument({
                id: UNRELATED_ID,
                path: 'brand/colors.md',
                slug: 'colors',
                title: 'Colors',
                metadata: { body: 'Blue. Not [[brand/voice.md.bak]].' },
            }),
        );
        ownership = {
            ensureCanEdit: jest.fn(async () => ({ role: 'owner' })),
            ensureCanView: jest.fn(async () => ({ role: 'owner' })),
        };
        activityLog = { log: jest.fn(async () => undefined) };
        mirrorDispatcher = { dispatchKbMirrorDocument: jest.fn(async () => 'run-1') };
        embedDispatcher = { dispatchKbEmbedDocument: jest.fn(async () => 'run-2') };
        workRepository = {
            findById: jest.fn(async () => ({ id: WORK_ID, organizationId: null })),
            findIdsByOrganization: jest.fn(async () => []),
        };
        citations = {
            listForDocument: jest.fn(async (documentId: string) =>
                documentId === DOC_ID
                    ? [
                          {
                              id: 'cit-1',
                              documentId: DOC_ID,
                              consumerType: KbCitationConsumerType.AGENT_RUN,
                              consumerId: 'run-1',
                              chunkRange: null,
                              relevanceScore: 0.9,
                              createdAt: new Date('2026-09-02T00:00:00Z'),
                          },
                      ]
                    : [],
            ),
        };
        domainEvents = {
            transaction: jest.fn(async (fn: (m: unknown) => Promise<unknown>) => fn({})),
            changed: jest.fn(async () => undefined),
            created: jest.fn(async () => undefined),
        };
    });

    it('moves the document: new path and slug, the next revision, the retired path marked — in ONE compare-and-set write', async () => {
        const result = await build().moveDocument(WORK_ID, DOC_ID, USER_ID, {
            path: 'brand/tone.md',
        });

        expect(result).toMatchObject({
            id: DOC_ID,
            path: 'brand/tone.md',
            slug: 'tone',
            body: '# Voice',
        });
        const write = docs.updates.find((u) => u.id === DOC_ID)!;
        expect(write.expectedRevision).toBe(3);
        expect(write.patch).toMatchObject({
            path: 'brand/tone.md',
            slug: 'tone',
            updatedById: USER_ID,
            revision: 4,
        });
        expect(write.patch.metadata).toEqual({
            body: '# Voice',
            [KB_MIRROR_RETIRED_PATHS_KEY]: ['brand/voice.md'],
        });
        expect(docs.updates.filter((u) => u.id === DOC_ID)).toHaveLength(1);
        // Same gate as an edit.
        expect(ownership.ensureCanEdit).toHaveBeenCalledWith(WORK_ID, USER_ID);
    });

    it('rewrites the links other documents carry to the old path, each as a revisioned edit by the mover', async () => {
        await build().moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' });

        expect((docs.rows.get(LINKING_ID)!.metadata as { body: string }).body).toBe(
            'Write like [[brand/tone.md]], see [[Voice|brand/tone.md]].',
        );
        // A draft's links are links too.
        expect((docs.rows.get(MD_LINKING_ID)!.metadata as { body: string }).body).toBe(
            `Per [Voice](/works/${WORK_ID}/kb/brand/tone.md).`,
        );
        const guide = docs.rows.get(LINKING_ID)!;
        expect(guide.revision).toBe(4);
        expect(guide.updatedById).toBe(USER_ID);
        expect(guide.normalizedContentHash).toBe(
            hashNormalizedBody('Write like [[brand/tone.md]], see [[Voice|brand/tone.md]].'),
        );
        // No link, no write.
        expect(docs.updates.some((u) => u.id === UNRELATED_ID)).toBe(false);
        expect((docs.rows.get(UNRELATED_ID)!.metadata as { body: string }).body).toBe(
            'Blue. Not [[brand/voice.md.bak]].',
        );
    });

    it('records kb.document.moved for the document and kb.document.updated for each rewritten one, plus the history rows', async () => {
        await build().moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' });

        expect(events()).toEqual(
            expect.arrayContaining([
                {
                    id: DOC_ID,
                    type: 'kb.document.moved',
                    change: {
                        changedFields: ['path', 'slug'],
                        previous: { path: 'brand/voice.md', slug: 'voice' },
                    },
                },
                {
                    id: LINKING_ID,
                    type: 'kb.document.updated',
                    change: { changedFields: ['body'], previous: {} },
                },
                {
                    id: MD_LINKING_ID,
                    type: 'kb.document.updated',
                    change: { changedFields: ['body'], previous: {} },
                },
            ]),
        );
        expect(events()).toHaveLength(3);

        const [moved, links] = activityLog.log.mock.calls.map(([entry]) => entry);
        expect(moved).toMatchObject({
            actionType: ActivityActionType.KB_DOCUMENT_UPDATED,
            workId: WORK_ID,
            details: {
                documentId: DOC_ID,
                changedFields: ['path', 'slug'],
                previousPath: 'brand/voice.md',
                path: 'brand/tone.md',
                revision: 4,
                skippedLinkingDocuments: [],
            },
        });
        expect(moved.details.linkingDocumentIds.sort()).toEqual([LINKING_ID, MD_LINKING_ID].sort());
        expect(links).toMatchObject({
            actionType: ActivityActionType.KB_WIKILINK_REWRITTEN,
            details: { oldPath: 'brand/voice.md', newPath: 'brand/tone.md', documentsTouched: 2 },
        });
    });

    it('enqueues ONE mirror run for the moved document, then one per rewritten document (and its re-embed)', async () => {
        await build().moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' });

        const runs = mirrored();
        expect(runs[0]).toEqual({ documentId: DOC_ID, operation: 'upsert', path: 'brand/tone.md' });
        expect(runs.filter((r) => r.documentId === DOC_ID)).toHaveLength(1);
        expect(runs.map((r) => r.documentId).sort()).toEqual(
            [DOC_ID, LINKING_ID, MD_LINKING_ID].sort(),
        );
        // The moved document's body did not change: no re-embed for it.
        const embedded = embedDispatcher.dispatchKbEmbedDocument.mock.calls.map(
            ([payload]) => payload.documentId,
        );
        expect(embedded.sort()).toEqual([LINKING_ID, MD_LINKING_ID].sort());
    });

    it('citations, the id and the new path all resolve the moved document; the old path does not', async () => {
        const service = build();
        await service.moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' });

        const cited = await service.listCitationsForDocument(WORK_ID, DOC_ID, USER_ID);
        expect(cited).toEqual([expect.objectContaining({ id: 'cit-1', documentId: DOC_ID })]);
        expect((await service.getDocument(WORK_ID, DOC_ID, USER_ID)).path).toBe('brand/tone.md');
        expect((await service.getDocument(WORK_ID, 'brand/tone.md', USER_ID)).id).toBe(DOC_ID);
        await expect(
            service.getDocument(WORK_ID, 'brand/voice.md', USER_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a path another document holds (409 KbPathTaken) and writes nothing', async () => {
        const error = await build()
            .moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/colors.md' })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({ code: 'KbPathTaken' });
        expect(docs.updates).toHaveLength(0);
        expect(mirrorDispatcher.dispatchKbMirrorDocument).not.toHaveBeenCalled();
        expect(domainEvents.changed).not.toHaveBeenCalled();
    });

    it('refuses a fully locked document (403, as PATCH does) but moves an additions-only one', async () => {
        docs.add(buildDocument({ locked: true, lockMode: KbLockMode.FULL }));
        await expect(
            build().moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(docs.updates).toHaveLength(0);

        docs.add(buildDocument({ locked: true, lockMode: KbLockMode.ADDITIONS_ONLY }));
        const moved = await build().moveDocument(WORK_ID, DOC_ID, USER_ID, {
            path: 'brand/tone.md',
        });
        expect(moved.path).toBe('brand/tone.md');
    });

    it('refuses the move when a FULLY locked document links to the old path (409) — its links could not follow', async () => {
        docs.add(
            buildDocument({
                ...docs.rows.get(LINKING_ID)!,
                locked: true,
                lockMode: KbLockMode.FULL,
            }),
        );
        const error = await build()
            .moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'KbLinkedFromLockedDocument',
            documentIds: [LINKING_ID],
        });
        expect(String((error as ConflictException).message)).toContain('brand/guide.md');
        expect(docs.updates).toHaveLength(0);
    });

    it.each([
        ['no .md', 'brand/tone'],
        ['an unknown class folder', 'notes/tone.md'],
        ['a traversal', 'brand/../../.git/config.md'],
        ['a space', 'brand/brand tone.md'],
        ['an empty path', '   '],
    ])('refuses %s (400 KbPathInvalid) before anything is written', async (_label, path) => {
        const error = await build()
            .moveDocument(WORK_ID, DOC_ID, USER_ID, { path })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
            code: 'KbPathInvalid',
        });
        expect(docs.updates).toHaveLength(0);
    });

    it('moving to the path it already has is a no-op', async () => {
        const result = await build().moveDocument(WORK_ID, DOC_ID, USER_ID, {
            path: ' brand/voice.md ',
        });
        expect(result.path).toBe('brand/voice.md');
        expect(docs.updates).toHaveLength(0);
        expect(domainEvents.changed).not.toHaveBeenCalled();
        expect(mirrorDispatcher.dispatchKbMirrorDocument).not.toHaveBeenCalled();
    });

    it('answers 404 for a document of another Work (an inherited organization document included)', async () => {
        await expect(
            build().moveDocument(WORK_ID, '00000000-0000-0000-0000-0000000000ff', USER_ID, {
                path: 'brand/tone.md',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets a refused edit permission through untouched', async () => {
        ownership.ensureCanEdit.mockRejectedValue(new ForbiddenException('viewer'));
        await expect(
            build().moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(docs.findById).not.toHaveBeenCalled();
        expect(docs.updates).toHaveLength(0);
    });

    describe('organization documents the Work inherits', () => {
        beforeEach(() => {
            workRepository.findById.mockResolvedValue({ id: WORK_ID, organizationId: ORG_ID });
        });

        it('refuses a move ONTO the path of an inherited organization document (it would start overriding it)', async () => {
            docs.orgRows.push(
                buildDocument({
                    id: 'org-1',
                    workId: null,
                    organizationId: ORG_ID,
                    path: 'legal/terms.md',
                    kbDocumentClass: KbDocumentClass.LEGAL,
                }),
            );
            const error = await build()
                .moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'legal/terms.md' })
                .catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: 'KbOrgDocumentPath',
            });
            expect(docs.updates).toHaveLength(0);
        });

        it('refuses a move OFF the path of an inherited organization document (it would stop overriding it)', async () => {
            docs.add(
                buildDocument({ path: 'legal/terms.md', kbDocumentClass: KbDocumentClass.LEGAL }),
            );
            docs.orgRows.push(
                buildDocument({
                    id: 'org-1',
                    workId: null,
                    organizationId: ORG_ID,
                    path: 'legal/terms.md',
                    kbDocumentClass: KbDocumentClass.LEGAL,
                }),
            );
            await expect(
                build().moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'legal/terms-acme.md' }),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(docs.updates).toHaveLength(0);
        });

        it('lets a move through when the organization document at that path is not one a Work inherits', async () => {
            docs.orgRows.push(
                buildDocument({
                    id: 'org-2',
                    workId: null,
                    organizationId: ORG_ID,
                    path: 'brand/tone.md',
                    kbDocumentClass: KbDocumentClass.BRAND,
                }),
            );
            const moved = await build().moveDocument(WORK_ID, DOC_ID, USER_ID, {
                path: 'brand/tone.md',
            });
            expect(moved.path).toBe('brand/tone.md');
        });
    });

    describe('when the mirror cannot run', () => {
        it('a Work with no mirror (no dispatcher) still moves, the marker on the row for a later mirror', async () => {
            const moved = await build({ mirror: undefined }).moveDocument(
                WORK_ID,
                DOC_ID,
                USER_ID,
                {
                    path: 'brand/tone.md',
                },
            );
            expect(moved.path).toBe('brand/tone.md');
            expect(
                (docs.rows.get(DOC_ID)!.metadata as Record<string, unknown>)[
                    KB_MIRROR_RETIRED_PATHS_KEY
                ],
            ).toEqual(['brand/voice.md']);
        });

        it('a queue outage does not undo the move (the row is the source of truth)', async () => {
            mirrorDispatcher.dispatchKbMirrorDocument.mockRejectedValue(new Error('queue down'));
            const moved = await build().moveDocument(WORK_ID, DOC_ID, USER_ID, {
                path: 'brand/tone.md',
            });
            expect(moved.path).toBe('brand/tone.md');
            expect(docs.rows.get(DOC_ID)!.path).toBe('brand/tone.md');
        });
    });

    it('a linking document that cannot be written meanwhile is skipped and named; the move stands', async () => {
        const realUpdate = docs.update.getMockImplementation()!;
        docs.update.mockImplementation(async (id, patch, opts) => {
            // The guide is deleted between the scan and its rewrite.
            if (id === LINKING_ID) {
                docs.rows.delete(LINKING_ID);
                return null;
            }
            return realUpdate(id, patch, opts);
        });

        const moved = await build().moveDocument(WORK_ID, DOC_ID, USER_ID, {
            path: 'brand/tone.md',
        });

        expect(moved.path).toBe('brand/tone.md');
        expect((docs.rows.get(MD_LINKING_ID)!.metadata as { body: string }).body).toContain(
            'brand/tone.md',
        );
        const [entry] = activityLog.log.mock.calls.map(([e]) => e);
        expect(entry.details.skippedLinkingDocuments).toEqual([
            expect.objectContaining({ documentId: LINKING_ID }),
        ]);
        expect(events().some((e) => e.id === LINKING_ID)).toBe(false);
    });

    it('moving back to an old path takes it off the retired list (the mirror must not delete the new files)', async () => {
        const service = build();
        await service.moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/tone.md' });
        await service.moveDocument(WORK_ID, DOC_ID, USER_ID, { path: 'brand/voice.md' });
        expect(
            (docs.rows.get(DOC_ID)!.metadata as Record<string, unknown>)[
                KB_MIRROR_RETIRED_PATHS_KEY
            ],
        ).toEqual(['brand/tone.md']);
        // The links followed both moves.
        expect((docs.rows.get(LINKING_ID)!.metadata as { body: string }).body).toBe(
            'Write like [[brand/voice.md]], see [[Voice|brand/voice.md]].',
        );
    });
});
