import {
    MigrationInterface,
    QueryRunner,
    TableColumn,
    TableIndex,
    type TableColumnOptions,
} from 'typeorm';

const TABLE = 'tasks';
const INDEX = 'idx_tasks_parent_recurring';
const INDEX_COLUMNS = ['parentRecurringTaskId', 'createdAt'];

/**
 * Recurring Tasks — the per-template overlap limit.
 *
 * Entity: `packages/agent/src/entities/task.entity.ts`. Rule:
 * `packages/agent/src/tasks-domain/recurrence-overlap.ts`.
 *
 * ## Why
 *
 * Every fire of a recurring template spawns a NEW Task instance with its own run, branch and
 * pull request, and nothing stopped a fire while earlier instances were still running or their
 * pull requests unreviewed: a daily loop opened a pull request every day whatever the backlog.
 *
 * ## Two nullable columns on `tasks`
 *
 *  1. `recurrenceMaxOpenInstances` (int) — at most this many instances of the template may be
 *     unfinished; a scheduled fire at the limit is skipped, run-now answers 409 unless forced.
 *  2. `recurrenceSkippedAt` (timestamp) — when the latest scheduled fire was skipped by that
 *     limit; cleared by the next fire that spawns.
 *
 * **No backfill.** `NULL` on every existing row means "no limit" and "nothing skipped", which is
 * precisely today's behaviour: nothing fires differently on deploy.
 *
 * ## One composite index
 *
 * `idx_tasks_parent_recurring (parentRecurringTaskId, createdAt)`. The open-instance count (every
 * OR-ed branch is `parentRecurringTaskId = ?`) and run-now's latest-instance read had no index on
 * `parentRecurringTaskId` at all, so each one scanned the whole `tasks` table. `createdAt` second
 * serves the two ordered reads: the oldest open instances a skip record names, and run-now's
 * newest instance as a backward index scan. `status` second (the convention of the other owner
 * indexes) was measured and bought nothing: the count only filters it with `NOT IN`.
 *
 * Measured on 298k tasks / 298k runs (70 templates x 400 instances, warm): the count went from a
 * full scan to an index seek, Postgres 17 ~400 ms -> ~5 ms and SQLite ~110 ms -> ~1 ms; run-now's
 * latest-instance read from ~50 ms to 0.03 ms (Postgres, backward index scan).
 *
 * Slot `1797800000000`: the next after `1797700000000-AddAgentRunLatestEndedIndex`, the newest
 * migration on `develop` when this was written. Forward-only with per-step guards so a partially
 * applied database converges; portable `TableColumn` / `TableIndex` DDL (better-sqlite3 in
 * e2e/CI, Postgres in production). `down()` drops exactly what `up()` added, in reverse,
 * re-reading the table between steps because sqlite rebuilds the table on every column change.
 */
export class AddRecurrenceMaxOpenInstances1797800000000 implements MigrationInterface {
    name = 'AddRecurrenceMaxOpenInstances1797800000000';

    private static readonly COLUMNS: readonly TableColumnOptions[] = [
        { name: 'recurrenceMaxOpenInstances', type: 'int', isNullable: true },
        { name: 'recurrenceSkippedAt', type: 'timestamp', isNullable: true },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Ordering safety: a database that has not created `tasks` yet has nothing to limit.
        if (!(await queryRunner.getTable(TABLE))) return;
        for (const column of AddRecurrenceMaxOpenInstances1797800000000.COLUMNS) {
            // Re-read each time: on sqlite every addColumn rebuilds the table.
            const table = await queryRunner.getTable(TABLE);
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn(TABLE, new TableColumn(column));
            }
        }
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (!INDEX_COLUMNS.every((name) => table.findColumnByName(name))) return;
        if (table.indices.some((index) => index.name === INDEX)) return;
        await queryRunner.createIndex(
            TABLE,
            new TableIndex({ name: INDEX, columnNames: INDEX_COLUMNS }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (table.indices.some((index) => index.name === INDEX)) {
            await queryRunner.dropIndex(TABLE, INDEX);
        }
        for (const column of [...AddRecurrenceMaxOpenInstances1797800000000.COLUMNS].reverse()) {
            const current = await queryRunner.getTable(TABLE);
            const existing = current?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn(TABLE, existing);
            }
        }
    }
}
