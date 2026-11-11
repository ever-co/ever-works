import { MigrationInterface, QueryRunner, TableColumn, type TableColumnOptions } from 'typeorm';

const TABLE = 'tasks';
const INDEX = 'idx_tasks_pr_read_retry';

/**
 * PR-status sweep — a failed read backs off, and "not found" is confirmed from the FIRST answer.
 *
 * Entity: `packages/agent/src/entities/task.entity.ts`. Rules:
 * `packages/agent/src/tasks-domain/task-pr-read-retry.ts` (the schedule) and
 * `TaskPrStatusService` / `TaskRepository.findDuePrStatusSync` (who writes and reads it).
 *
 * ## Why
 *
 *  1. A read that THROWS (credentials removed, a refusal, an outage, a rate limit) stamped
 *     nothing, and the sweep orders its 25-row batch by `ciCheckedAt` (the last successful read),
 *     so such a row sorted first on every tick forever. 25 of them, which one owner with a
 *     disconnected git account can have, took every slot of every tick: no other owner's pull
 *     request was read again.
 *  2. A "not found" answer was confirmed once the last SUCCESSFUL read was 30 minutes old, so after
 *     any gap in reads (the sweep down, or more open pull requests than it reads in 30 minutes) a
 *     single answer confirmed it at once.
 *
 * ## Two nullable columns on `tasks`
 *
 *  1. `prReadRetryAt` (timestamp) — the sweep does not read the pull request again before this
 *     instant. NULL is the normal cadence.
 *  2. `prNotFoundSince` (timestamp) — the first "not found" answer since the last successful read.
 *
 * No existing column could carry either without changing what it means to its readers:
 * `ciCheckedAt` is read as "the pull request was last seen" by the branch GC, the overlap and
 * Mission caps and App provisioning feedback, so stamping it on a failed read would keep a Task
 * whose credentials are gone alive forever.
 *
 * **No backfill.** NULL on every existing row is today's behaviour: due on the usual cadence, and
 * no "not found" seen yet.
 *
 * ## One partial index
 *
 * `idx_tasks_pr_read_retry ("prReadRetryAt") WHERE "prReadRetryAt" IS NOT NULL`: the sweep's
 * second read (rows whose retry instant has passed, soonest first) seeks it. It holds only the
 * rows in backoff, so it stays tiny. Raw DDL like `idx_tasks_pr_status_sync`
 * (`AddTaskPrStatusColumns`): both Postgres and SQLite accept a partial index in this form.
 *
 * Slot `1798000000000`: the next after `1797915000000-RetireUnscopedReviewFindingsBeforeFixRuns`,
 * the newest migration on `develop` when this was written. Forward-only with per-step guards so a
 * partially applied database converges; portable `TableColumn` DDL (better-sqlite3 in e2e/CI,
 * Postgres in production). `down()` drops exactly what `up()` added, in reverse, re-reading the
 * table between steps because sqlite rebuilds the table on every column change.
 */
export class AddTaskPrReadRetry1798000000000 implements MigrationInterface {
    name = 'AddTaskPrReadRetry1798000000000';

    private static readonly COLUMNS: readonly TableColumnOptions[] = [
        { name: 'prReadRetryAt', type: 'timestamp', isNullable: true },
        { name: 'prNotFoundSince', type: 'timestamp', isNullable: true },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Ordering safety: a database that has not created `tasks` yet has nothing to back off.
        if (!(await queryRunner.getTable(TABLE))) return;
        for (const column of AddTaskPrReadRetry1798000000000.COLUMNS) {
            // Re-read each time: on sqlite every addColumn rebuilds the table.
            const table = await queryRunner.getTable(TABLE);
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn(TABLE, new TableColumn(column));
            }
        }
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "${INDEX}" ON "${TABLE}" ("prReadRetryAt") ` +
                `WHERE "prReadRetryAt" IS NOT NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX}"`);
        for (const column of [...AddTaskPrReadRetry1798000000000.COLUMNS].reverse()) {
            const current = await queryRunner.getTable(TABLE);
            const existing = current?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn(TABLE, existing);
            }
        }
    }
}
