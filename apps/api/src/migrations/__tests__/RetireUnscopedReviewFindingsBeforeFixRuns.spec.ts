import { DataSource } from 'typeorm';
import { RetireUnscopedReviewFindingsBeforeFixRuns1797915000000 } from '../1797915000000-RetireUnscopedReviewFindingsBeforeFixRuns';

/**
 * #3150 on deploy — open findings that name NO pull request (a `POST /reject`
 * Task review, the cloud quality gate) piled up while nothing but a resume
 * read them; from #3150 on, each would be given to the next fresh run of its
 * Task. This one-time step retires them: `consumedAt` set, `consumedByRunId`
 * left NULL ("consumed by no run"), no row deleted. Findings on a pull request,
 * and rows a run carries or consumed, are untouched. Asserted on the PHYSICAL
 * table (better-sqlite3), the way the other `task_review_rejections`
 * migration specs are.
 */
describe('RetireUnscopedReviewFindingsBeforeFixRuns1797915000000', () => {
    let dataSource: DataSource;
    const migration = new RetireUnscopedReviewFindingsBeforeFixRuns1797915000000();
    const CONSUMED_AT = '2026-11-10 08:00:00';

    const insert = (
        id: string,
        over: {
            prNumber?: number | null;
            consumedByRunId?: string | null;
            consumedAt?: string | null;
        } = {},
    ) =>
        dataSource.query(
            `INSERT INTO "task_review_rejections" ("id", "taskId", "source", "feedback", "prNumber", "consumedByRunId", "consumedAt") VALUES (?, 't1', 'task-review', 'fix it', ?, ?, ?)`,
            [id, over.prNumber ?? null, over.consumedByRunId ?? null, over.consumedAt ?? null],
        );

    const state = async () =>
        Object.fromEntries(
            (
                (await dataSource.query(
                    `SELECT "id", "consumedByRunId", "consumedAt" FROM "task_review_rejections" ORDER BY "id"`,
                )) as Array<{
                    id: string;
                    consumedByRunId: string | null;
                    consumedAt: string | null;
                }>
            ).map((row) => [row.id, { run: row.consumedByRunId, at: row.consumedAt }]),
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "task_review_rejections" (
                "id" varchar PRIMARY KEY NOT NULL,
                "taskId" varchar NOT NULL,
                "source" varchar(16) NOT NULL,
                "feedback" text NOT NULL,
                "prNumber" integer,
                "consumedByRunId" varchar,
                "consumedAt" datetime,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
            )
        `);
        // The backlog: open, no pull request (a Task review, a gate row).
        await insert('backlog-review');
        await insert('backlog-gate');
        // A finding on a pull request (e.g. one still under review): stays open.
        await insert('on-pr', { prNumber: 5038 });
        // Already consumed by a resume: untouched (its timestamp included).
        await insert('consumed', { consumedByRunId: 'run-1', consumedAt: CONSUMED_AT });
        // Carried by a fresh run (only after #3150 — modelled for safety): untouched.
        await insert('carried', { consumedByRunId: 'run-2' });
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('retires exactly the open rows with no pull request and no run — nothing deleted', async () => {
        await migration.up(dataSource.createQueryRunner());
        const rows = await state();

        expect(Object.keys(rows)).toHaveLength(5);
        for (const id of ['backlog-review', 'backlog-gate']) {
            expect(rows[id].run).toBeNull();
            expect(rows[id].at).not.toBeNull();
        }
        expect(rows['on-pr']).toEqual({ run: null, at: null });
        expect(rows.consumed).toEqual({ run: 'run-1', at: CONSUMED_AT });
        expect(rows.carried).toEqual({ run: 'run-2', at: null });
    });

    it('is idempotent: a second run changes nothing the first retired, and never fails', async () => {
        await migration.up(dataSource.createQueryRunner());
        const first = await state();
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        expect(await state()).toEqual(first);
    });

    it('down re-opens exactly the retired rows', async () => {
        const before = await state();
        await migration.up(dataSource.createQueryRunner());
        await migration.down(dataSource.createQueryRunner());
        expect(await state()).toEqual(before);
    });

    it('is a no-op on a database without the table', async () => {
        await dataSource.query(`DROP TABLE "task_review_rejections"`);
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();
    });
});
