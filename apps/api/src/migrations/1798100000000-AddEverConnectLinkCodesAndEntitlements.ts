import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    type TableColumnOptions,
} from 'typeorm';

/**
 * Ever Connect — link codes, the heartbeat, entitlement documents and the apps
 * mirror. Additive only:
 *
 * - `ever_connect_links.productOrgRef` (nullable): what Ever Platform was given
 *   as the Organization's id when the link was made. Existing rows keep `NULL`
 *   (the Organization's slug is used for them).
 * - `ever_connect_connection.lastHeartbeatAt` and `.appSyncReconciledAt`
 *   (nullable): when Ever Platform last recorded a heartbeat, and when the apps
 *   mirror last sent its full set again.
 * - `ever_connect_entitlements` (new, empty): the entitlement documents read
 *   from Ever Platform (the installation's and each linked Organization's) and
 *   its key set, one row per subject.
 *
 * Portable DDL (CI and e2e run better-sqlite3, production Postgres); each step
 * guarded so a partially applied database converges. `down` drops the table and
 * the three columns.
 */
export class AddEverConnectLinkCodesAndEntitlements1798100000000 implements MigrationInterface {
    name = 'AddEverConnectLinkCodesAndEntitlements1798100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.addColumn(queryRunner, 'ever_connect_links', {
            name: 'productOrgRef',
            type: 'varchar',
            length: '128',
            isNullable: true,
        });
        for (const name of ['lastHeartbeatAt', 'appSyncReconciledAt']) {
            await this.addColumn(queryRunner, 'ever_connect_connection', {
                name,
                type: 'timestamp',
                isNullable: true,
            });
        }

        if (!(await queryRunner.hasTable('ever_connect_entitlements'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'ever_connect_entitlements',
                    columns: [
                        { name: 'subject', type: 'varchar', length: '64', isPrimary: true },
                        { name: 'document', type: 'text', isNullable: true },
                        { name: 'seq', type: 'bigint', isNullable: true },
                        { name: 'issuedAt', type: 'bigint', isNullable: true },
                        { name: 'expiresAt', type: 'bigint', isNullable: true },
                        { name: 'fetchedAt', type: 'timestamp', isNullable: true },
                        { name: 'lastError', type: 'varchar', length: '64', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ever_connect_entitlements')) {
            await queryRunner.dropTable('ever_connect_entitlements', true);
        }
        for (const [table, column] of [
            ['ever_connect_connection', 'appSyncReconciledAt'],
            ['ever_connect_connection', 'lastHeartbeatAt'],
            ['ever_connect_links', 'productOrgRef'],
        ] as const) {
            if (
                (await queryRunner.hasTable(table)) &&
                (await queryRunner.hasColumn(table, column))
            ) {
                await queryRunner.dropColumn(table, column);
            }
        }
    }

    /** Add a column to a table that exists and does not have it yet. */
    private async addColumn(
        queryRunner: QueryRunner,
        table: string,
        column: TableColumnOptions,
    ): Promise<void> {
        if (!(await queryRunner.hasTable(table))) return;
        if (await queryRunner.hasColumn(table, column.name)) return;
        await queryRunner.addColumn(table, new TableColumn(column));
    }
}
