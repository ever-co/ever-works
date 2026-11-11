import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Fleet agent readiness — the agent CLIs a node last reported.
 *
 * A node that read `online` with an agent CLI installed said nothing about
 * whether any agent could actually work: an organization that switched
 * subscription access off, or an expired OAuth session, failed every run
 * while the runner popup stayed green. Every heartbeat now carries the
 * node's per-CLI report (`agents`); this column stores the last one:
 *
 *  - `agentReadiness` (text) — the entity's `simple-json` `{ at, checkedAt,
 *    agents: [{ provider, installed, version, signedIn, authMethod, account,
 *    status, reason, checkedAt, usage?, lastSuccessAt?, … }] }`. NULL = never
 *    reported (a daemon older than the field), shown as "unknown — update
 *    the node". No backfill.
 *
 * Its own column, not a key of `health`: that snapshot is shared whole with
 * Organization viewers on the promise that it holds no text the node wrote,
 * and this report carries the account label and the CLI's own sentence.
 *
 * Slot `1797600000000`: the next after `1797500000000-AddEverConnectInstallRequests`,
 * the newest migration on `develop` when this was written. Forward-only with
 * a per-step guard so a partially applied database converges; portable
 * `TableColumn` DDL (better-sqlite3 in e2e/CI, Postgres in production).
 */
export class AddFleetNodeAgentReadiness1797600000000 implements MigrationInterface {
    name = 'AddFleetNodeAgentReadiness1797600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('agentReadiness')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({ name: 'agentReadiness', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('agentReadiness')) {
            await queryRunner.dropColumn('fleet_nodes', 'agentReadiness');
        }
    }
}
