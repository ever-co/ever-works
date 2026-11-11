import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recurring Tasks run in their time zone (#3166) — a ONE-TIME data step on
 * deploy, so existing templates keep firing exactly when they fire today. No
 * schema change; no row is deleted.
 *
 * ## Why
 *
 * Until #3166 the dispatcher evaluated every cadence in UTC: `recurrenceTimezone`
 * was stored but never read by the math. The RRULE form always sent the
 * browser's zone, and a Fleet Agent-session schedule files its cron with the
 * computer's zone, so most templates carry a zone that never applied: "daily
 * 09:00, Europe/Berlin" has been firing at 09:00 UTC. From #3166 on that row
 * would fire once more at its stored, UTC-computed `nextOccurrenceAt` and then
 * move by the zone's offset (10:00 → 09:00 Berlin time), and someone who set
 * 08:00 to get 09:00 would suddenly get 08:00.
 *
 * ## What it does
 *
 * Every recurring template that exists when this runs and names a zone other
 * than UTC is set to `UTC`, the zone its cadence has always actually run in.
 * Its next fire and every fire after it stay where they were, and the Task
 * page now shows the zone the template really uses. Saving the cadence again
 * (the form sends the browser's zone, a Fleet schedule the computer's) opts it
 * into the zone. Templates saved after deploy are untouched: this runs before
 * the new code serves a request (`migrationsRun` on boot).
 *
 * Instances (`isRecurring = false`, zone NULL) and Tasks that stopped
 * recurring are left alone: neither fires, and making one recurring again
 * writes a fresh zone. `nextOccurrenceAt` is not touched.
 *
 * Idempotent: a second run finds no row to change. Portable SQL (Postgres in
 * production, better-sqlite3 in CI and e2e).
 *
 * `down` changes nothing. The zones replaced are not kept, and none is needed
 * to roll back: the code before #3166 evaluated every cadence in UTC, so a
 * `UTC` row fires there exactly as the original row did.
 *
 * Slot `1798031660000`: after `1798000000000-AddTaskPrReadRetry`, the newest
 * migration on `develop` when this was written.
 */
export class PinLegacyRecurringTemplateZonesToUtc1798031660000 implements MigrationInterface {
    name = 'PinLegacyRecurringTemplateZonesToUtc1798031660000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tasks'))) return;
        await queryRunner.query(
            `UPDATE "tasks"
                SET "recurrenceTimezone" = 'UTC'
              WHERE "isRecurring" = true
                AND "recurrenceTimezone" IS NOT NULL
                AND "recurrenceTimezone" NOT IN ('UTC', 'Etc/UTC')`,
        );
    }

    public async down(): Promise<void> {
        // Nothing to undo: see the class comment.
    }
}
