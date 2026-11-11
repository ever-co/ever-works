import { DataSource } from 'typeorm';
import { AddWorkDefaultAgentId1797900000000 } from '../1797900000000-AddWorkDefaultAgentId';

/**
 * A Work's default Agent — the nullable `works.defaultAgentId` column, on in-memory
 * better-sqlite3 (the PHYSICAL schema through `PRAGMA`): added, idempotent, every existing row
 * reads as "no default", dropped by `down`, and a no-op without the table.
 */
describe('AddWorkDefaultAgentId1797900000000', () => {
    let dataSource: DataSource;
    const migration = new AddWorkDefaultAgentId1797900000000();

    const columns = async (): Promise<Array<{ name: string; type: string; notnull: number }>> =>
        (await dataSource.query(`PRAGMA table_info("works")`)) as Array<{
            name: string;
            type: string;
            notnull: number;
        }>;
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY, "name" varchar NOT NULL, "taskBranchCleanup" varchar(16) NOT NULL DEFAULT ('on-merge'))`,
        );
        await dataSource.query(
            `INSERT INTO "works" ("id", "name") VALUES ('w-1', 'Docs'), ('w-2', 'Site')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the nullable column, idempotently, without touching rows', async () => {
        await run('up');
        await run('up');
        const matches = (await columns()).filter((column) => column.name === 'defaultAgentId');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({ notnull: 0 });
        // No backfill: every existing Work reads as "no default", i.e. today's rule.
        expect(
            await dataSource.query(`SELECT id, name, defaultAgentId FROM works ORDER BY id`),
        ).toEqual([
            { id: 'w-1', name: 'Docs', defaultAgentId: null },
            { id: 'w-2', name: 'Site', defaultAgentId: null },
        ]);
    });

    it('down() drops exactly what up() added and keeps the rows', async () => {
        await run('up');
        await run('down');
        const names = (await columns()).map((column) => column.name);
        expect(names).not.toContain('defaultAgentId');
        expect(names).toEqual(expect.arrayContaining(['id', 'name', 'taskBranchCleanup']));
        expect(await dataSource.query(`SELECT id FROM works ORDER BY id`)).toEqual([
            { id: 'w-1' },
            { id: 'w-2' },
        ]);
        await expect(run('down')).resolves.toBeUndefined();
    });

    it('is a no-op without the works table', async () => {
        await dataSource.query(`DROP TABLE works`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
