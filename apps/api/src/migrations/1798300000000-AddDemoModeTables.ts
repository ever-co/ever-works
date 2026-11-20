import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Demo mode (`DEMO=true`) — two small tables:
 *   - `demo_usage_counters`: one fixed-window counter per key, backing the DB-held AI request quotas
 *     (per sandbox, per day, per minute).
 *   - `demo_github_repos`: ledger of the GitHub repositories a demo sandbox created, so the sweeper deletes
 *     exactly those. `sandboxUserId` has NO foreign key on purpose: the ledger outlives the user delete.
 *
 * Postgres only. The demo instance itself runs on SQLite and gets both tables from TypeORM auto-sync
 * (`DATABASE_AUTOMIGRATE`); every other install gets them here, unused until `DEMO` is set. Each step is
 * guarded so a partially applied database converges.
 */
export class AddDemoModeTables1798300000000 implements MigrationInterface {
    name = 'AddDemoModeTables1798300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') return;

        if (!(await queryRunner.hasTable('demo_usage_counters'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'demo_usage_counters',
                    columns: [
                        { name: 'key', type: 'varchar', length: '160', isPrimary: true },
                        { name: 'count', type: 'int', default: 0, isNullable: false },
                        { name: 'windowEndsAt', type: 'timestamp', isNullable: false },
                        {
                            name: 'updatedAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                }),
            );
        }

        if (!(await queryRunner.hasTable('demo_github_repos'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'demo_github_repos',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'sandboxUserId', type: 'uuid', isNullable: false },
                        { name: 'owner', type: 'varchar', length: '255', isNullable: false },
                        { name: 'name', type: 'varchar', length: '255', isNullable: false },
                        { name: 'githubId', type: 'bigint', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                        { name: 'deletedAt', type: 'timestamp', isNullable: true },
                        { name: 'lastError', type: 'text', isNullable: true },
                        { name: 'attempts', type: 'int', default: 0, isNullable: false },
                    ],
                }),
            );
            await queryRunner.createIndex(
                'demo_github_repos',
                new TableIndex({
                    name: 'idx_demo_github_repos_sandbox_user',
                    columnNames: ['sandboxUserId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') return;

        if (await queryRunner.hasTable('demo_github_repos')) {
            await queryRunner.dropIndex('demo_github_repos', 'idx_demo_github_repos_sandbox_user');
            await queryRunner.dropTable('demo_github_repos');
        }
        if (await queryRunner.hasTable('demo_usage_counters')) {
            await queryRunner.dropTable('demo_usage_counters');
        }
    }
}
