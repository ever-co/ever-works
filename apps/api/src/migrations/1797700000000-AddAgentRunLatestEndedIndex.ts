import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

const TABLE = 'agent_runs';
const INDEX = 'idx_agent_runs_agent_finished';
const COLUMNS = ['agentId', 'finishedAt'];

/**
 * The Agents list's "Last run" — an index on `agent_runs (agentId, finishedAt)`.
 *
 * `findLatestEndedRunsByAgent` (`packages/agent/src/database/repositories/latest-agent-run.query.ts`)
 * reads, for the Agents on one page, each Agent's most recent ENDED run: a grouped
 * `MAX(finishedAt)` per Agent, joined back to its row on `(agentId, finishedAt)`. The only
 * Agent-keyed index was `idx_agent_runs_agent_started (agentId, startedAt)`, which cannot seek
 * on `finishedAt`: the grouped half read every run of every Agent on the page, and Postgres
 * answered the join back by hashing a sequential scan of the WHOLE table, so the list got
 * slower with everyone's run history. With this index the join back is one index seek per
 * Agent, and the grouped half reads only the page's Agents' ended runs.
 *
 * A plain composite index, not a partial one (`WHERE finishedAt IS NOT NULL`): nearly every
 * run ends, so the predicate would leave out only the few runs in flight, and the join back
 * would then depend on the planner proving the predicate from a join condition.
 *
 * Entity: `packages/agent/src/entities/agent-run.entity.ts`.
 *
 * Additive and idempotent (created only when the table and its columns exist and the index
 * does not); portable `TableIndex` DDL for Postgres and better-sqlite3. `down` drops it.
 */
export class AddAgentRunLatestEndedIndex1797700000000 implements MigrationInterface {
    name = 'AddAgentRunLatestEndedIndex1797700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;
        const present = new Set(table.columns.map((column) => column.name));
        if (!COLUMNS.every((column) => present.has(column))) return;
        if (table.indices.some((index) => index.name === INDEX)) return;
        await queryRunner.createIndex(TABLE, new TableIndex({ name: INDEX, columnNames: COLUMNS }));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (table?.indices.some((index) => index.name === INDEX)) {
            await queryRunner.dropIndex(TABLE, INDEX);
        }
    }
}
