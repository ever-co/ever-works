import { DataSource } from 'typeorm';
import { AddWorkInstallId1798143000000 } from '../1798143000000-AddWorkInstallId';

/**
 * The marketplace install a Work was created for — the nullable `works.installId` column, on
 * in-memory better-sqlite3 (the PHYSICAL schema through `PRAGMA`): added, idempotent, every
 * existing row reads as "not created for an install", dropped by `down`, and a no-op without
 * the table.
 */
describe('AddWorkInstallId1798143000000', () => {
    let dataSource: DataSource;
    const migration = new AddWorkInstallId1798143000000();

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
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY, "name" varchar NOT NULL, "kind" varchar(32) NOT NULL DEFAULT ('default'))`,
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
        const matches = (await columns()).filter((column) => column.name === 'installId');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({ notnull: 0, type: 'varchar(26)' });
        // No backfill: no existing Work was created for an install.
        expect(await dataSource.query(`SELECT id, name, installId FROM works ORDER BY id`)).toEqual(
            [
                { id: 'w-1', name: 'Docs', installId: null },
                { id: 'w-2', name: 'Site', installId: null },
            ],
        );
    });

    it('keeps an install id written after it', async () => {
        await run('up');
        await dataSource.query(
            `UPDATE works SET installId = '01JC5R7Y6K1M9E0V3Q2A8XW4TB' WHERE id = 'w-1'`,
        );
        expect(await dataSource.query(`SELECT id, installId FROM works ORDER BY id`)).toEqual([
            { id: 'w-1', installId: '01JC5R7Y6K1M9E0V3Q2A8XW4TB' },
            { id: 'w-2', installId: null },
        ]);
    });

    it('down() drops exactly what up() added and keeps the rows', async () => {
        await run('up');
        await run('down');
        const names = (await columns()).map((column) => column.name);
        expect(names).not.toContain('installId');
        expect(names).toEqual(expect.arrayContaining(['id', 'name', 'kind']));
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
