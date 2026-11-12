import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'work_knowledge_documents';
const INDEX = 'uq_wkd_work_path';

/**
 * One Knowledge Base document per path in a Work.
 *
 * Entity: `packages/agent/src/entities/work-knowledge-document.entity.ts`. Writers:
 * `KnowledgeBaseService.createDocument` (suffixes a taken path) and `moveDocument` (refuses one).
 *
 * ## Why
 *
 * Both writers check the path and then write the row, with other work in between (a move scans
 * every document of the Work for links before it writes). Two moves to one path, or a create and
 * a move, could both pass the check and both write: every link then points at one path that two
 * documents hold, and the git mirror writes both documents to the same files. Only the database
 * can make check-and-write one step.
 *
 * ## The index
 *
 * `uq_wkd_work_path ("workId", "path") WHERE "workId" IS NOT NULL`. Organization documents
 * (`workId` NULL, see the scope check on the table) are not in it: their paths are the
 * organization's, and an organization document and a Work document at one path is the
 * inheritance override, never a duplicate.
 *
 * ## Existing data
 *
 * Checked read-only before this was written (2026-11-12, on a replica): no Work holds two
 * documents at one path in production, stage or dev. If a database somewhere does, creating the
 * index fails and the migration with it, and the API does not start: that is deliberate, the
 * duplicates are a defect to resolve by hand (rename one), not data to discard silently.
 *
 * Slot `1798060000000`: after `1798031660000-PinLegacyRecurringTemplateZonesToUtc`, the newest
 * migration on `develop` when this was written. Raw DDL: both Postgres and SQLite accept a partial
 * unique index in this form.
 */
export class AddKbDocumentWorkPathUnique1798060000000 implements MigrationInterface {
    name = 'AddKbDocumentWorkPathUnique1798060000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Ordering safety: a database that has not created the table yet has nothing to index.
        if (!(await queryRunner.getTable(TABLE))) return;
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX}" ON "${TABLE}" ("workId", "path") ` +
                `WHERE "workId" IS NOT NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "${INDEX}"`);
    }
}
