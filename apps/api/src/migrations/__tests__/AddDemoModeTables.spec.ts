import { DataSource } from 'typeorm';
import { AddDemoModeTables1798300000000 } from '../1798300000000-AddDemoModeTables';

/**
 * The migration is Postgres-only (the SQLite demo instance gets the tables from auto-sync), so on the
 * in-memory SQLite driver it must do nothing. The Postgres DDL is checked against a recording query runner.
 */
describe('AddDemoModeTables1798300000000', () => {
    const migration = new AddDemoModeTables1798300000000();

    it('is a no-op on SQLite', async () => {
        const dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        try {
            await migration.up(dataSource.createQueryRunner());
            const tables = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE name LIKE 'demo_%'`,
            );
            expect(tables).toEqual([]);
            await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();
        } finally {
            await dataSource.destroy();
        }
    });

    describe('on Postgres', () => {
        const runner = (existing: string[]) => {
            const created: Array<{ name: string; columns: string[] }> = [];
            const indexes: Array<{ table: string; name: string; columns: string[] }> = [];
            const dropped: string[] = [];
            const qr = {
                connection: { options: { type: 'postgres' } },
                hasTable: jest.fn(
                    async (name: string) =>
                        existing.includes(name) || created.some((t) => t.name === name),
                ),
                createTable: jest.fn(
                    async (table: { name: string; columns: Array<{ name: string }> }) => {
                        created.push({
                            name: table.name,
                            columns: table.columns.map((c) => c.name),
                        });
                    },
                ),
                createIndex: jest.fn(
                    async (table: string, index: { name: string; columnNames: string[] }) => {
                        indexes.push({ table, name: index.name, columns: index.columnNames });
                    },
                ),
                dropIndex: jest.fn(async () => undefined),
                dropTable: jest.fn(async (name: string) => {
                    dropped.push(name);
                }),
            };
            return { qr: qr as never, created, indexes, dropped };
        };

        it('creates both tables and the sandbox index, with no foreign key', async () => {
            const { qr, created, indexes } = runner([]);
            await migration.up(qr);
            expect(created.map((t) => t.name)).toEqual([
                'demo_usage_counters',
                'demo_github_repos',
            ]);
            expect(created[0].columns).toEqual(['key', 'count', 'windowEndsAt', 'updatedAt']);
            expect(created[1].columns).toEqual([
                'id',
                'sandboxUserId',
                'owner',
                'name',
                'githubId',
                'createdAt',
                'deletedAt',
                'lastError',
                'attempts',
            ]);
            expect(indexes).toEqual([
                {
                    table: 'demo_github_repos',
                    name: 'idx_demo_github_repos_sandbox_user',
                    columns: ['sandboxUserId'],
                },
            ]);
            expect((qr as { createForeignKey?: unknown }).createForeignKey).toBeUndefined();
        });

        it('is idempotent and down drops both tables', async () => {
            const { qr, created, dropped } = runner(['demo_usage_counters', 'demo_github_repos']);
            await migration.up(qr);
            expect(created).toEqual([]);
            await migration.down(qr);
            expect(dropped).toEqual(['demo_github_repos', 'demo_usage_counters']);
        });
    });
});
