import { DataSource } from 'typeorm';
import { AddEverConnectMembershipSync1798210000000 } from '../1798210000000-AddEverConnectMembershipSync';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs. What
 * matters: the table exists with its columns; one row per (Organization,
 * account), which is what makes a change handled twice handled once; the row
 * goes with the account or the Organization; `up()` re-runs as a no-op;
 * `down()` removes the table.
 */
describe('AddEverConnectMembershipSync1798210000000', () => {
    let dataSource: DataSource;
    const migration = new AddEverConnectMembershipSync1798210000000();
    const ORG = '6f0a1c2e-0000-4000-8000-000000000001';
    const USER = '6f0a1c2e-0000-4000-8000-000000000002';
    const OTHER_USER = '6f0a1c2e-0000-4000-8000-000000000003';

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    const insert = (id: string, userId: string) =>
        dataSource.query(
            `INSERT INTO "ever_connect_membership_sync" ("id", "organizationId", "userId", "lastEventId", "lastChange", "lastRole", "outcome") VALUES (?, ?, ?, '01J7V7WCBMJZ18WNPB5W1T7AHZ', 'created', 'admin', 'added')`,
            [id, ORG, userId],
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = ON');
        // The two tables the rows point at, as far as this migration needs them.
        await dataSource.query(`CREATE TABLE "organizations" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "organizations" ("id") VALUES (?)`, [ORG]);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES (?), (?)`, [USER, OTHER_USER]);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the table with its columns', async () => {
        await run('up');
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('ever_connect_membership_sync');
        expect(table?.columns.map((column) => column.name).sort()).toEqual(
            [
                'createdAt',
                'id',
                'lastChange',
                'lastEventId',
                'lastOccurredAt',
                'lastRole',
                'organizationId',
                'outcome',
                'updatedAt',
                'userId',
            ].sort(),
        );
        await runner.release();
    });

    it('keeps one row per Organization and account', async () => {
        await run('up');
        await insert('r1', USER);
        await expect(insert('r2', USER)).rejects.toThrow();
        await insert('r3', OTHER_USER);
        const rows = await dataSource.query(`SELECT "id" FROM "ever_connect_membership_sync"`);
        expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(['r1', 'r3']);
    });

    it('a row goes with its account and with its Organization', async () => {
        await run('up');
        await insert('r1', USER);
        await insert('r2', OTHER_USER);
        await dataSource.query(`DELETE FROM "users" WHERE "id" = ?`, [USER]);
        expect(await dataSource.query(`SELECT "id" FROM "ever_connect_membership_sync"`)).toEqual([
            { id: 'r2' },
        ]);
        await dataSource.query(`DELETE FROM "organizations" WHERE "id" = ?`, [ORG]);
        expect(await dataSource.query(`SELECT "id" FROM "ever_connect_membership_sync"`)).toEqual(
            [],
        );
    });

    it('re-runs as a no-op and keeps the rows', async () => {
        await run('up');
        await insert('r1', USER);
        await run('up');
        expect(await dataSource.query(`SELECT "id" FROM "ever_connect_membership_sync"`)).toEqual([
            { id: 'r1' },
        ]);
    });

    it('down() removes the table', async () => {
        await run('up');
        await run('down');
        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('ever_connect_membership_sync')).toBe(false);
        await runner.release();
    });
});
