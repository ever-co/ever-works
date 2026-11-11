import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Review feedback reaches the next run (#3150) — a ONE-TIME data step on
 * deploy. No schema change; no row is deleted.
 *
 * Before #3150, nothing outside the resume path ever read an open
 * `task_review_rejections` row, so rows that name NO pull request — Task
 * reviews recorded with `POST /api/tasks/:id/reject`, and the cloud quality
 * gate's own `recordGateRejection` — piled up wherever no resume came. From
 * #3150 on, an open row is given to the next FRESH run of its Task until a
 * run that was given it completes. Left as they are, every such backlog would
 * become due on the first run after deploy, turning the next scheduled run of
 * each recurring Task into a fix run for old, possibly long-merged work.
 *
 * So every open row with no pull-request number that exists when this runs is
 * RETIRED: `consumedAt` is set and `consumedByRunId` stays NULL. That pair
 * means "consumed by no run" — the one state no code path writes (a resume
 * writes both columns, a fresh run's completion stamps `consumedAt` on a row
 * it carries) — so a retired row stays distinguishable from a fixed one
 * without a marker column (the table has none). The row and its text stay on
 * the record. `findPendingForTask` (the resume path and the CI doorbell) reads
 * `consumedAt IS NULL` too, so a retired row is replayed by no path.
 *
 * Rows that name a pull request are NOT touched: the fresh-run reader gives
 * them only while that pull request is the Task's open one, so a finding on a
 * pull request still under review (ever-co/ever-teams#5038) is delivered, and
 * one about a merged, closed or replaced pull request already never is.
 * Neither is a row a run already carries or consumed.
 *
 * Idempotent: the UPDATE selects only rows still open with no run and no pull
 * request, so a second run touches nothing the first retired and never fails
 * (TypeORM applies it once). Portable SQL — `CURRENT_TIMESTAMP` is valid on
 * Postgres (prod) and better-sqlite3 (CI / e2e).
 *
 * `down` re-opens exactly the rows in the retired state; it cannot tell a row
 * this step retired from one retired the same way later, and there is no
 * other writer of that state.
 */
export class RetireUnscopedReviewFindingsBeforeFixRuns1797915000000 implements MigrationInterface {
    name = 'RetireUnscopedReviewFindingsBeforeFixRuns1797915000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('task_review_rejections'))) return;
        await queryRunner.query(
            `UPDATE "task_review_rejections"
                SET "consumedAt" = CURRENT_TIMESTAMP
              WHERE "consumedAt" IS NULL
                AND "consumedByRunId" IS NULL
                AND "prNumber" IS NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('task_review_rejections'))) return;
        await queryRunner.query(
            `UPDATE "task_review_rejections"
                SET "consumedAt" = NULL
              WHERE "consumedAt" IS NOT NULL
                AND "consumedByRunId" IS NULL
                AND "prNumber" IS NULL`,
        );
    }
}
