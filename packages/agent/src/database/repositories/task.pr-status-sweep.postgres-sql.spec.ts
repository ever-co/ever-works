import { DataSource, SelectQueryBuilder, UpdateQueryBuilder } from 'typeorm';
import { Task } from '../../entities/task.entity';
import { ENTITIES } from '../_entities-inventory';
import { TaskRepository } from './task.repository';

/**
 * The PR-status sweep's SQL as Postgres receives it (the specs next to this one run it on
 * SQLite). No database: the repository runs over an unconnected Postgres DataSource with metadata
 * built, and the terminal `getMany` / `execute` calls are intercepted to capture `getQuery()`.
 *
 * Pinned because the predicates mix camelCase columns (which Postgres folds to lower case unless
 * quoted), a sub-select on `works`, and `AND` / `OR` precedence that decides which rows are due.
 * A full-entity select list is collapsed to `<all columns>`.
 */
describe('TaskRepository — Postgres SQL of the PR-status sweep', () => {
    const STALE = new Date('2026-11-11T10:00:00.000Z');
    const NOT_FOUND = new Date('2026-11-11T04:00:00.000Z');
    const NOW = new Date('2026-11-11T10:02:00.000Z');
    const OWNER = '11111111-1111-4111-8111-111111111111';

    let tasks: TaskRepository;
    let allColumns: string;

    beforeAll(async () => {
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: ENTITIES,
        });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        allColumns = dataSource
            .getMetadata(Task)
            .columns.map(
                (column) => `"task"."${column.databaseName}" AS "task_${column.databaseName}"`,
            )
            .join(', ');
        tasks = new TaskRepository(dataSource.getRepository(Task));
    });

    afterEach(() => jest.restoreAllMocks());

    const flat = (sql: string) => sql.replace(/\s+/g, ' ').replace(allColumns, '<all columns>');

    async function captureSelects(call: () => Promise<unknown>): Promise<string[]> {
        const captured: string[] = [];
        jest.spyOn(SelectQueryBuilder.prototype, 'getMany').mockImplementation(function (
            this: SelectQueryBuilder<Task>,
        ) {
            captured.push(flat(this.getQuery()));
            return Promise.resolve([]);
        });
        await call();
        return captured;
    }

    async function captureUpdates(call: () => Promise<unknown>): Promise<string[]> {
        const captured: string[] = [];
        jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockImplementation(function (
            this: UpdateQueryBuilder<Task>,
        ) {
            captured.push(flat(this.getQuery()));
            return Promise.resolve({ affected: 0, raw: [], generatedMaps: [] });
        });
        await call();
        return captured;
    }

    it('findDuePrStatusSync: the usual cadence without backoff, then the rows whose retry instant has passed', async () => {
        const [regular, retrying, ...rest] = await captureSelects(() =>
            tasks.findDuePrStatusSync(STALE, 25, NOT_FOUND, NOW),
        );
        expect(rest).toEqual([]);
        expect(regular).toBe(
            'SELECT <all columns> FROM "tasks" "task"' +
                ' WHERE "task"."prNumber" IS NOT NULL AND "task"."workId" IS NOT NULL' +
                ' AND ("task"."prReadRetryAt" IS NULL OR "task"."prReadRetryAt" > :retryCeiling)' +
                ` AND (("task"."prState" IS NULL OR "task"."prState" IN ('open', 'draft'))` +
                ' AND ("task"."ciCheckedAt" IS NULL OR "task"."ciCheckedAt" < :staleBefore)' +
                ' OR "task"."prState" = :prNotFound' +
                ' AND ("task"."ciCheckedAt" IS NULL OR "task"."ciCheckedAt" < :notFoundBefore))' +
                ' ORDER BY "task"."ciCheckedAt" ASC NULLS FIRST LIMIT 25',
        );
        expect(retrying).toBe(
            'SELECT <all columns> FROM "tasks" "task"' +
                ' WHERE "task"."prReadRetryAt" <= :retryBefore' +
                ' AND "task"."prNumber" IS NOT NULL AND "task"."workId" IS NOT NULL' +
                ` AND ("task"."prState" IS NULL OR "task"."prState" IN ('open', 'draft', :prNotFound))` +
                ' ORDER BY "task"."prReadRetryAt" ASC LIMIT 25',
        );
    });

    it('findOpenPrReadsOfOwner: the owner’s pull requests the sweep still reads, with what a deferral decides on', async () => {
        const [sql, ...rest] = await captureSelects(() => tasks.findOpenPrReadsOfOwner(OWNER));
        expect(rest).toEqual([]);
        expect(sql).toBe(
            'SELECT "task"."id" AS "task_id", "task"."workId" AS "task_workId",' +
                ' "task"."prState" AS "task_prState", "task"."ciCheckedAt" AS "task_ciCheckedAt",' +
                ' "task"."prReadRetryAt" AS "task_prReadRetryAt" FROM "tasks" "task"' +
                ' WHERE "task"."userId" = :userId AND "task"."prNumber" IS NOT NULL' +
                ' AND "task"."workId" IS NOT NULL' +
                ` AND ("task"."prState" IS NULL OR "task"."prState" IN ('open', 'draft', :prNotFound))`,
        );
    });

    it('deferPrReads: exactly the rows the caller chose, keeping updatedAt', async () => {
        const [sql, ...rest] = await captureUpdates(() => tasks.deferPrReads(['t-1', 't-2'], NOW));
        expect(rest).toEqual([]);
        expect(sql).toBe(
            'UPDATE "tasks" SET "prReadRetryAt" = :orm_param_0, "updatedAt" = "updatedAt"' +
                ' WHERE "id" IN (:...taskIds)',
        );
        // Nothing chosen, nothing written.
        expect(await captureUpdates(() => tasks.deferPrReads([], NOW))).toEqual([]);
    });

    it('updatePrStatusCache: the backoff columns, keeping updatedAt', async () => {
        const [sql] = await captureUpdates(() =>
            tasks.updatePrStatusCache('t-1', { prReadRetryAt: NOW, prNotFoundSince: null }),
        );
        expect(sql).toBe(
            'UPDATE "tasks" SET "prReadRetryAt" = :orm_param_0, "prNotFoundSince" = :orm_param_1,' +
                ' "updatedAt" = "updatedAt"' +
                ' WHERE "id" = :taskId',
        );
    });
});
