import { DataSource } from 'typeorm';
import { AddKbDocumentWorkPathUnique1798060000000 } from '../1798060000000-AddKbDocumentWorkPathUnique';

/**
 * One KB document per path in a Work — the partial unique index on in-memory better-sqlite3:
 * a second Work document at a taken path is refused, another Work and organization documents
 * are not, `up` is idempotent, `down` drops it, and it is a no-op without the table.
 */
describe('AddKbDocumentWorkPathUnique1798060000000', () => {
    let dataSource: DataSource;
    const migration = new AddKbDocumentWorkPathUnique1798060000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };
    const insert = (
        id: string,
        workId: string | null,
        organizationId: string | null,
        path: string,
    ) =>
        dataSource.query(
            `INSERT INTO "work_knowledge_documents" ("id", "workId", "organizationId", "path") VALUES (?, ?, ?, ?)`,
            [id, workId, organizationId, path],
        );
    const indexSql = async (): Promise<string[]> =>
        (
            (await dataSource.query(
                `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_wkd_work_path'`,
            )) as Array<{ sql: string }>
        ).map((row) => row.sql);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "work_knowledge_documents" ("id" varchar PRIMARY KEY, "workId" varchar, "organizationId" varchar, "path" varchar NOT NULL)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('refuses a second document at one path of a Work, idempotently created', async () => {
        await insert('d-1', 'w-1', null, 'brand/voice.md');
        await run('up');
        await run('up');
        expect(await indexSql()).toEqual([expect.stringContaining('WHERE "workId" IS NOT NULL')]);

        await expect(insert('d-2', 'w-1', null, 'brand/voice.md')).rejects.toThrow(/UNIQUE/i);
        // Another Work, another path, and organization documents are not constrained.
        await insert('d-3', 'w-2', null, 'brand/voice.md');
        await insert('d-4', 'w-1', null, 'brand/tone.md');
        await insert('d-5', null, 'org-1', 'brand/voice.md');
        await insert('d-6', null, 'org-1', 'brand/voice.md');
    });

    it('fails, and creates nothing, when a Work already holds two documents at one path', async () => {
        await insert('d-1', 'w-1', null, 'brand/voice.md');
        await insert('d-2', 'w-1', null, 'brand/voice.md');
        await expect(run('up')).rejects.toThrow(/UNIQUE/i);
        expect(await indexSql()).toEqual([]);
    });

    it('down drops the index; both are no-ops without the table', async () => {
        await run('up');
        await run('down');
        expect(await indexSql()).toEqual([]);
        await dataSource.query(`DROP TABLE "work_knowledge_documents"`);
        await run('up');
        await run('down');
    });
});
