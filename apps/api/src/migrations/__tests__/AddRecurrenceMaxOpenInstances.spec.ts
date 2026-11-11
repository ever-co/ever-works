import { DataSource } from 'typeorm';
import { AddRecurrenceMaxOpenInstances1797800000000 } from '../1797800000000-AddRecurrenceMaxOpenInstances';

/**
 * Recurring Tasks overlap limit — the two `tasks` columns and the
 * `(parentRecurringTaskId, status)` index, on in-memory better-sqlite3 (the PHYSICAL schema
 * through `PRAGMA`): added, idempotent, every existing row reads as "no limit, nothing
 * skipped", dropped by `down`, and a no-op without the table.
 */
describe('AddRecurrenceMaxOpenInstances1797800000000', () => {
    let dataSource: DataSource;
    const migration = new AddRecurrenceMaxOpenInstances1797800000000();

    const columns = async (): Promise<Array<{ name: string; type: string; notnull: number }>> =>
        (await dataSource.query(`PRAGMA table_info("tasks")`)) as Array<{
            name: string;
            type: string;
            notnull: number;
        }>;
    const indexNames = async (): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_list("tasks")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const indexColumns = async (index: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_info("${index}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
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
            `CREATE TABLE "tasks" ("id" varchar PRIMARY KEY, "status" varchar(16) NOT NULL DEFAULT ('backlog'), "isRecurring" boolean NOT NULL DEFAULT (0), "parentRecurringTaskId" varchar, "recurrenceMaxOccurrences" integer, "recurrencePausedAt" datetime)`,
        );
        await dataSource.query(
            `CREATE INDEX "idx_tasks_recurrence_due_active" ON "tasks" ("isRecurring", "recurrencePausedAt")`,
        );
        await dataSource.query(
            `INSERT INTO "tasks" ("id", "status", "isRecurring", "parentRecurringTaskId") VALUES ('tpl-1', 'todo', 1, NULL), ('inst-1', 'in_review', 0, 'tpl-1')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the two nullable columns and the index, idempotently, without touching rows', async () => {
        await run('up');
        await run('up');
        const byName = new Map((await columns()).map((column) => [column.name, column]));
        expect(byName.get('recurrenceMaxOpenInstances')).toMatchObject({ notnull: 0 });
        expect(byName.get('recurrenceMaxOpenInstances')!.type.toLowerCase()).toContain('int');
        expect(byName.get('recurrenceSkippedAt')).toMatchObject({ notnull: 0 });
        expect(await indexColumns('idx_tasks_parent_recurring')).toEqual([
            'parentRecurringTaskId',
            'status',
        ]);
        expect(
            (await indexNames()).filter((name) => name === 'idx_tasks_parent_recurring'),
        ).toHaveLength(1);
        expect(await indexNames()).toContain('idx_tasks_recurrence_due_active');
        // No backfill: every existing row reads as "no limit" and "nothing skipped".
        expect(
            await dataSource.query(
                `SELECT id, recurrenceMaxOpenInstances, recurrenceSkippedAt FROM tasks ORDER BY id`,
            ),
        ).toEqual([
            { id: 'inst-1', recurrenceMaxOpenInstances: null, recurrenceSkippedAt: null },
            { id: 'tpl-1', recurrenceMaxOpenInstances: null, recurrenceSkippedAt: null },
        ]);
    });

    it('down() drops exactly what up() added and keeps the rows and the other indexes', async () => {
        await run('up');
        await run('down');
        const names = (await columns()).map((column) => column.name);
        expect(names).not.toContain('recurrenceMaxOpenInstances');
        expect(names).not.toContain('recurrenceSkippedAt');
        expect(names).toContain('parentRecurringTaskId');
        expect(await indexNames()).not.toContain('idx_tasks_parent_recurring');
        expect(await indexNames()).toContain('idx_tasks_recurrence_due_active');
        expect(await dataSource.query(`SELECT id FROM tasks ORDER BY id`)).toEqual([
            { id: 'inst-1' },
            { id: 'tpl-1' },
        ]);
        await expect(run('down')).resolves.toBeUndefined();
    });

    it('converges from a partially applied state (one column already there)', async () => {
        await dataSource.query(
            `ALTER TABLE "tasks" ADD COLUMN "recurrenceMaxOpenInstances" integer`,
        );
        await run('up');
        const names = (await columns()).map((column) => column.name);
        expect(names.filter((name) => name === 'recurrenceMaxOpenInstances')).toHaveLength(1);
        expect(names).toContain('recurrenceSkippedAt');
        expect(await indexNames()).toContain('idx_tasks_parent_recurring');
    });

    it('is a no-op without the tasks table', async () => {
        await dataSource.query(`DROP TABLE tasks`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
