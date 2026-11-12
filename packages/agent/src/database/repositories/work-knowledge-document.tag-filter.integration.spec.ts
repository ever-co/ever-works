import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentClass, KbDocumentStatus } from '../../entities/kb-types';
import { WorkKnowledgeDocumentRepository } from './work-knowledge-document.repository';

/**
 * `WorkKnowledgeDocumentRepository.list({ tag })` — the Tag chip.
 *
 * `tag` was part of the list options (the KB tree, search and the command
 * palette all pass it) but the query never applied it, so every document
 * came back whatever tag was selected. Executed on better-sqlite3; the
 * predicate is a plain `LIKE … ESCAPE` on the `simple-json` text, the same
 * on PostgreSQL.
 */
describe('WorkKnowledgeDocumentRepository.list — tag filter (integration)', () => {
    let dataSource: DataSource;
    let kbDocs: Repository<WorkKnowledgeDocument>;
    let repository: WorkKnowledgeDocumentRepository;
    let workId: string;
    let otherWorkId: string;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();

        kbDocs = dataSource.getRepository(WorkKnowledgeDocument);
        repository = new WorkKnowledgeDocumentRepository(kbDocs);

        const users = dataSource.getRepository(User);
        const user = await users.save(
            users.create({
                username: 'tagger',
                email: 'tagger@example.com',
                password: 'x',
            } as Partial<User>),
        );
        const works = dataSource.getRepository(Work);
        const makeWork = async (slug: string) =>
            (
                await works.save(
                    works.create({
                        userId: user.id,
                        name: slug,
                        slug,
                        description: slug,
                    } as Partial<Work>),
                )
            ).id;
        workId = await makeWork('tag-work');
        otherWorkId = await makeWork('other-tag-work');

        const seed = (path: string, tags: string[] | null, owner: string = workId) =>
            kbDocs.save(
                kbDocs.create({
                    workId: owner,
                    path,
                    slug: path.replace(/\W+/g, '-'),
                    title: path,
                    kbDocumentClass: KbDocumentClass.FREEFORM,
                    status: KbDocumentStatus.ACTIVE,
                    tags,
                } as Partial<WorkKnowledgeDocument>),
            );

        await seed('gdpr.md', ['gdpr', 'legal']);
        await seed('gdpr-eu.md', ['gdpr-eu']);
        await seed('untagged.md', null);
        await seed('empty.md', []);
        await seed('wild.md', ['50%_off']);
        await seed('wild-lookalike.md', ['50xxoff']);
        await seed('quoted.md', ['say "hi"']);
        await seed('quote-inside.md', ['x"b']);
        await seed('upper.md', ['GDPR']);
        await seed('other-work-gdpr.md', ['gdpr'], otherWorkId);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const paths = async (tag?: string) =>
        (await repository.list({ workId, tag })).items.map((d) => d.path).sort();

    it('returns only the documents carrying the tag (before: every document)', async () => {
        expect(await paths('gdpr')).toEqual(['gdpr.md']);
        expect(await paths('legal')).toEqual(['gdpr.md']);
    });

    it('matches the whole tag, not a prefix or a substring', async () => {
        expect(await paths('gdpr-eu')).toEqual(['gdpr-eu.md']);
        expect(await paths('gdp')).toEqual([]);
    });

    it('treats LIKE wildcards and quotes in a tag literally', async () => {
        expect(await paths('50%_off')).toEqual(['wild.md']);
        expect(await paths('say "hi"')).toEqual(['quoted.md']);
        expect(await paths('x"b')).toEqual(['quote-inside.md']);
    });

    it('never matches the tail of another tag that holds a quote', async () => {
        // `x"b` is stored as "x\"b" and `say "hi"` as "say \"hi\"": the
        // JSON of `b` / `hi"` appears inside them, but not at an element start.
        expect(await paths('b')).toEqual([]);
        expect(await paths('hi"')).toEqual([]);
    });

    it('matches case-exactly, as PostgreSQL and the in-memory re-filter do (SQLite LIKE would not)', async () => {
        expect(await paths('gdpr')).toEqual(['gdpr.md']);
        expect(await paths('GDPR')).toEqual(['upper.md']);
    });

    it('no tag → every document of the Work, as before', async () => {
        expect(await paths(undefined)).toHaveLength(9);
    });

    it('keeps the Work scope', async () => {
        const items = (await repository.list({ workId: otherWorkId, tag: 'gdpr' })).items;
        expect(items.map((d) => d.path)).toEqual(['other-work-gdpr.md']);
    });
});

describe('WorkKnowledgeDocumentRepository.list — tag filter on postgres', () => {
    it('uses a case-exact strpos at an element start (no LIKE, so no ILIKE-style folding)', async () => {
        const clauses: Array<{ clause: string; params?: Record<string, unknown> }> = [];
        const qb: Record<string, jest.Mock> = new Proxy({} as Record<string, jest.Mock>, {
            get(target, prop: string) {
                if (!target[prop]) {
                    target[prop] =
                        prop === 'andWhere'
                            ? jest.fn((clause: string, params?: Record<string, unknown>) => {
                                  clauses.push({ clause, params });
                                  return qb;
                              })
                            : prop === 'getManyAndCount'
                              ? jest.fn(async () => [[], 0])
                              : prop === 'getMany'
                                ? jest.fn(async () => [])
                                : prop === 'getCount'
                                  ? jest.fn(async () => 0)
                                  : jest.fn(() => qb);
                }
                return target[prop];
            },
        });
        const fake = {
            createQueryBuilder: jest.fn(() => qb),
            manager: { connection: { options: { type: 'postgres' } } },
        } as unknown as Repository<WorkKnowledgeDocument>;

        await new WorkKnowledgeDocumentRepository(fake).list({
            workId: '44444444-4444-4444-8444-444444444444',
            tag: 'gdpr',
        });

        const tagClause = clauses.find((c) => c.clause.includes(':tagFirst'));
        expect(tagClause?.clause).toContain('strpos(doc.tags, :tagFirst) > 0');
        expect(tagClause?.clause).not.toMatch(/LIKE/i);
        expect(tagClause?.params).toEqual({ tagFirst: '["gdpr"', tagNext: ',"gdpr"' });
    });
});
