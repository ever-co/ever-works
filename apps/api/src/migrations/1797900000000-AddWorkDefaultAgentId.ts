import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const TABLE = 'works';
const COLUMN = 'defaultAgentId';

/**
 * A Work's default Agent — `works.defaultAgentId`.
 *
 * Entity: `packages/agent/src/entities/work.entity.ts`. Rule:
 * `packages/agent/src/tasks-domain/work-default-agent.ts`.
 *
 * ## Why
 *
 * The Agent a new Task runs with, when nobody names one, was "the Work's ONLY Agent": the one
 * Agent pinned to the Work. A tenant- or organization-scope Agent serving several Works is
 * pinned to none of them, so it was never found, and a Mission with Task output refused every
 * Repository Work such an Agent serves. The Work can now name its default Agent, which Run, a
 * Mission's Task output, a Goal's first iteration and an App Work change try first.
 *
 * ## One nullable `uuid` column, no foreign key, no index, no backfill
 *
 * `NULL` on every existing row means "no default", which is precisely today's behaviour:
 * nothing resolves differently on deploy. No foreign key on purpose: every read re-checks the
 * Agent (owner, archived, scope), so an Agent archived or deleted later is skipped rather than
 * obeyed, and a workspace restore never has to order Works after Agents. No index: the column
 * is only ever read off a Work already loaded by id.
 *
 * Slot `1797900000000`: the next after `1797800000000-AddRecurrenceMaxOpenInstances`, the newest
 * migration on `develop` when this was written. Forward-only with a guard so a partially applied
 * database converges; portable `TableColumn` DDL (better-sqlite3 in e2e/CI, the production
 * database). `down()` drops exactly what `up()` added.
 */
export class AddWorkDefaultAgentId1797900000000 implements MigrationInterface {
    name = 'AddWorkDefaultAgentId1797900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Ordering safety: a database that has not created `works` yet has nothing to extend.
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'uuid', isNullable: true }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        const existing = table?.findColumnByName(COLUMN);
        if (existing) {
            await queryRunner.dropColumn(TABLE, existing);
        }
    }
}
