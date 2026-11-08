import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Ever Connect — plugin installs requested from apps.ever.co. One new, empty
 * table; no change to an existing one:
 *
 * - `ever_connect_install_requests`: one row per Ever Platform install id, with
 *   the package coordinates the request declared, the platform admin's answer,
 *   the plugin installed from it and the status owed to Ever Platform.
 *
 * Portable `Table` DDL (CI and e2e run better-sqlite3, production Postgres);
 * each step guarded so a partially applied database converges. `down` drops
 * the table.
 */
export class AddEverConnectInstallRequests1797500000000 implements MigrationInterface {
    name = 'AddEverConnectInstallRequests1797500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = 'ever_connect_install_requests';
        if (!(await queryRunner.hasTable(table))) {
            await queryRunner.createTable(
                new Table({
                    name: table,
                    columns: [
                        { name: 'installId', type: 'varchar', length: '26', isPrimary: true },
                        { name: 'listingSlug', type: 'varchar', length: '64' },
                        { name: 'sourceKind', type: 'varchar', length: '16' },
                        { name: 'registry', type: 'varchar', length: '16', isNullable: true },
                        { name: 'packageName', type: 'varchar', length: '214', isNullable: true },
                        { name: 'sourceRepo', type: 'varchar', length: '201', isNullable: true },
                        { name: 'sourceSha', type: 'varchar', length: '40', isNullable: true },
                        { name: 'version', type: 'varchar', length: '64', isNullable: true },
                        { name: 'versionIsExact', type: 'boolean', default: false },
                        { name: 'integrity', type: 'varchar', length: '200', isNullable: true },
                        { name: 'editionKey', type: 'varchar', length: '41', isNullable: true },
                        { name: 'everOrgId', type: 'varchar', length: '26', isNullable: true },
                        { name: 'linkId', type: 'varchar', length: '64', isNullable: true },
                        { name: 'state', type: 'varchar', length: '16', default: "'requested'" },
                        { name: 'detail', type: 'varchar', length: '32', isNullable: true },
                        { name: 'pluginId', type: 'varchar', length: '128', isNullable: true },
                        {
                            name: 'installedVersion',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        { name: 'decidedByUserId', type: 'uuid', isNullable: true },
                        { name: 'decidedAt', type: 'timestamp', isNullable: true },
                        { name: 'allowlistAdded', type: 'boolean', default: false },
                        { name: 'removalRequestedAt', type: 'timestamp', isNullable: true },
                        { name: 'reportState', type: 'varchar', length: '16', isNullable: true },
                        { name: 'reportedState', type: 'varchar', length: '16', isNullable: true },
                        { name: 'reportAttempts', type: 'int', default: 0 },
                        { name: 'nextReportAt', type: 'timestamp', isNullable: true },
                        { name: 'receivedAt', type: 'timestamp' },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
        for (const index of [
            new TableIndex({
                name: 'idx_ever_connect_install_requests_state',
                columnNames: ['state'],
            }),
            new TableIndex({
                name: 'idx_ever_connect_install_requests_report',
                columnNames: ['reportState', 'nextReportAt'],
            }),
        ]) {
            // Re-read: an index an earlier, interrupted run created must be seen first.
            const current = await queryRunner.getTable(table);
            if (current && !current.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(table, index);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ever_connect_install_requests')) {
            await queryRunner.dropTable('ever_connect_install_requests', true);
        }
    }
}
