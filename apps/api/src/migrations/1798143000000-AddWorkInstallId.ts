import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const TABLE = 'works';
const COLUMN = 'installId';

/**
 * The marketplace install a Work was created for — `works.installId`.
 *
 * Entity: `packages/agent/src/entities/work.entity.ts`. Written once, at creation, from
 * `CreateWorkDto.installId`.
 *
 * ## Why
 *
 * A person who installs a listing on Ever Platform's marketplace is sent here to create the
 * Work, and the address that brings them names the install (Ever Platform's id of it, a ULID).
 * Nothing kept that id, so the Work and the install it was made for could not be told to be the
 * same thing. The Work now keeps it, and the apps mirror repeats it for a linked Organization.
 *
 * ## One nullable `varchar(26)` column, no index, no backfill
 *
 * `NULL` on every existing row means "not created for an install", which is what each of them
 * is: nothing reads differently on deploy. No index: the column is only ever read off a Work
 * already loaded by id. An identifier of another system, so no foreign key either.
 *
 * Forward-only with a guard so a partially applied database converges; portable `TableColumn`
 * DDL (better-sqlite3 in e2e/CI, the production database). `down()` drops exactly what `up()`
 * added.
 */
export class AddWorkInstallId1798143000000 implements MigrationInterface {
    name = 'AddWorkInstallId1798143000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Ordering safety: a database that has not created `works` yet has nothing to extend.
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'varchar', length: '26', isNullable: true }),
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
