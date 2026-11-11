import { DataSource } from 'typeorm';
import { AddTaskPrReadRetry1798000000000 } from '../1798000000000-AddTaskPrReadRetry';

/**
 * PR-status sweep backoff — the nullable `tasks.prReadRetryAt` / `tasks.prNotFoundSince` columns
 * and the partial index on the first, on in-memory better-sqlite3 (the PHYSICAL schema through
 * `PRAGMA` and `sqlite_master`): added, idempotent, every existing row reads as "due on the usual
 * cadence, no 'not found' seen", dropped by `down`, and a no-op without the table.
 */
describe('AddTaskPrReadRetry1798000000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskPrReadRetry1798000000000();

    const columns = async (): Promise<Array<{ name: string; notnull: number }>> =>
        (await dataSource.query(`PRAGMA table_info("tasks")`)) as Array<{
            name: string;
            notnull: number;
        }>;
    const indexSql = async (): Promise<string[]> =>
        (
            (await dataSource.query(
                `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_pr_read_retry'`,
            )) as Array<{ sql: string }>
        ).map((row) => row.sql);
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
            `CREATE TABLE "tasks" ("id" varchar PRIMARY KEY, "prNumber" integer, "prState" varchar(16), "ciCheckedAt" datetime)`,
        );
        await dataSource.query(
            `INSERT INTO "tasks" ("id", "prNumber", "prState") VALUES ('t-1', 7, 'open'), ('t-2', NULL, NULL)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds both nullable columns and the partial index, idempotently, without touching rows', async () => {
        await run('up');
        await run('up');
        for (const name of ['prReadRetryAt', 'prNotFoundSince']) {
            const matches = (await columns()).filter((column) => column.name === name);
            expect(matches).toHaveLength(1);
            expect(matches[0]).toMatchObject({ notnull: 0 });
        }
        const [index, ...more] = await indexSql();
        expect(more).toEqual([]);
        expect(index.replace(/\s+/g, ' ')).toBe(
            'CREATE INDEX "idx_tasks_pr_read_retry" ON "tasks" ("prReadRetryAt") WHERE "prReadRetryAt" IS NOT NULL',
        );
        // No backfill: every existing row is due on the usual cadence, with no "not found" seen.
        expect(
            await dataSource.query(
                `SELECT id, prState, prReadRetryAt, prNotFoundSince FROM tasks ORDER BY id`,
            ),
        ).toEqual([
            { id: 't-1', prState: 'open', prReadRetryAt: null, prNotFoundSince: null },
            { id: 't-2', prState: null, prReadRetryAt: null, prNotFoundSince: null },
        ]);
    });

    it('down() drops exactly what up() added and keeps the rows', async () => {
        await run('up');
        await run('down');
        const names = (await columns()).map((column) => column.name);
        expect(names).not.toContain('prReadRetryAt');
        expect(names).not.toContain('prNotFoundSince');
        expect(names).toEqual(['id', 'prNumber', 'prState', 'ciCheckedAt']);
        expect(await indexSql()).toEqual([]);
        expect(await dataSource.query(`SELECT id FROM tasks ORDER BY id`)).toEqual([
            { id: 't-1' },
            { id: 't-2' },
        ]);
        await expect(run('down')).resolves.toBeUndefined();
    });

    it('is a no-op without the tasks table', async () => {
        await dataSource.query(`DROP TABLE tasks`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
