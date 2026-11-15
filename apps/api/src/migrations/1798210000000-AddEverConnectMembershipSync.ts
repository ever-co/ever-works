import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Ever Connect membership sync — `ever_connect_membership_sync`.
 *
 * One row per (Organization, account): the last membership change Ever
 * Platform sent for that person in that linked Organization and what it did
 * here, so a change delivered again does nothing and an older one is skipped.
 * Written only with `EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED=true`; the table is
 * empty otherwise.
 *
 * Local ids and machine codes only. The row goes with the account or the
 * Organization (`ON DELETE CASCADE`). Portable `Table` DDL (CI and e2e run
 * better-sqlite3, production Postgres); each step guarded so a partially
 * applied database converges. `down` drops the table.
 */
export class AddEverConnectMembershipSync1798210000000 implements MigrationInterface {
    name = 'AddEverConnectMembershipSync1798210000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        if (!(await queryRunner.hasTable('ever_connect_membership_sync'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'ever_connect_membership_sync',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'organizationId', type: 'uuid' },
                        { name: 'userId', type: 'uuid' },
                        { name: 'lastEventId', type: 'varchar', length: '64' },
                        { name: 'lastOccurredAt', type: 'timestamp', isNullable: true },
                        { name: 'lastChange', type: 'varchar', length: '16' },
                        { name: 'lastRole', type: 'varchar', length: '16' },
                        { name: 'outcome', type: 'varchar', length: '48' },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                    foreignKeys: [
                        {
                            columnNames: ['organizationId'],
                            referencedTableName: 'organizations',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                        {
                            columnNames: ['userId'],
                            referencedTableName: 'users',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                    ],
                }),
                true,
            );
        }
        // Re-read: an index an earlier, interrupted run created must be seen first.
        const table = await queryRunner.getTable('ever_connect_membership_sync');
        if (
            table &&
            !table.indices.some(
                (index) => index.name === 'uq_ever_connect_membership_sync_org_user',
            )
        ) {
            await queryRunner.createIndex(
                'ever_connect_membership_sync',
                new TableIndex({
                    name: 'uq_ever_connect_membership_sync_org_user',
                    columnNames: ['organizationId', 'userId'],
                    isUnique: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ever_connect_membership_sync')) {
            await queryRunner.dropTable('ever_connect_membership_sync', true);
        }
    }
}
