import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { Task, TaskStatus } from '../../entities/task.entity';
import {
    RECURRENCE_MAX_OPEN_INSTANCES_LIMIT,
    RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
    describeRecurrenceRefusal,
    describeRecurrenceSkip,
    normalizeMaxOpenInstances,
    recurrenceFireLockKey,
    recurrenceOpenInstancesWhere,
    shouldRecordRecurrenceSkip,
    type OpenRecurrenceInstances,
} from '../recurrence-overlap';
import { TASK_CLOSED_PR_SLOT_HOLD_MS } from '../task-open-work';

/** The pure half of the recurring Tasks overlap limit (`recurrence-overlap.ts`). */

const NOW = new Date('2026-11-11T09:00:00.000Z');

function open(count: number, slugs: string[] = []): OpenRecurrenceInstances {
    return {
        count,
        instances: slugs.map((slug, index) => ({
            id: `i-${index}`,
            slug,
            title: 'Loop',
            status: TaskStatus.IN_REVIEW,
            prNumber: null,
            prUrl: null,
            prState: null,
            createdAt: NOW,
        })),
    };
}

describe('recurrence overlap rules', () => {
    it('normalizeMaxOpenInstances: whole numbers 1..100; anything else reads as no limit', () => {
        expect(normalizeMaxOpenInstances(1)).toBe(1);
        expect(normalizeMaxOpenInstances(3)).toBe(3);
        expect(normalizeMaxOpenInstances(RECURRENCE_MAX_OPEN_INSTANCES_LIMIT)).toBe(100);
        expect(normalizeMaxOpenInstances(250)).toBe(100);
        for (const raw of [null, undefined, 0, -2, 1.5, Number.NaN, '3', {}]) {
            expect(normalizeMaxOpenInstances(raw)).toBeNull();
        }
    });

    it('one claim key for a scheduled fire and a run-now', () => {
        expect(recurrenceFireLockKey('tpl-1')).toBe('schedule-run-now:tpl-1');
    });

    it('shouldRecordRecurrenceSkip: the first skip of a stall, then the first of each UTC day', () => {
        expect(shouldRecordRecurrenceSkip(null, NOW)).toBe(true);
        expect(shouldRecordRecurrenceSkip(undefined, NOW)).toBe(true);
        // Same UTC day, however long ago that day's previous skip was.
        expect(shouldRecordRecurrenceSkip(new Date('2026-11-11T00:00:00.000Z'), NOW)).toBe(false);
        expect(shouldRecordRecurrenceSkip(new Date(NOW.getTime() - 60_000), NOW)).toBe(false);
        // A new UTC day: recorded, so a long stall shows up every day.
        expect(
            shouldRecordRecurrenceSkip(
                new Date('2026-11-10T23:59:00.000Z'),
                new Date('2026-11-11T00:00:30.000Z'),
            ),
        ).toBe(true);
        expect(shouldRecordRecurrenceSkip(new Date(NOW.getTime() - 86_400_000), NOW)).toBe(true);
    });

    it('refuses to build the rule without a template id (an undefined key would match every Task)', () => {
        expect(() =>
            recurrenceOpenInstancesWhere({ id: undefined as never }, { now: NOW }),
        ).toThrow(/template/);
        expect(() => recurrenceOpenInstancesWhere(undefined as never, { now: NOW })).toThrow();
    });

    it('describes a skip and a refusal, naming at most five instances', () => {
        expect(describeRecurrenceSkip(open(1, ['T-9']), 1)).toBe(
            'Skipped: 1 instance still open (T-9); at most 1 at a time.',
        );
        expect(
            describeRecurrenceSkip(open(12, ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7']), 3),
        ).toBe(
            'Skipped: 12 instances still open (T-1, T-2, T-3, T-4, T-5 and 7 more); at most 3 at a time.',
        );
        expect(describeRecurrenceRefusal(open(1, ['T-9']), 1)).toBe(
            'At most 1 instance of this schedule may be open at a time, and 1 instance is still open (T-9). ' +
                'Review or close them, or run it anyway with force.',
        );
    });

    // The rule against the REAL Task entity: what the count asks Postgres.
    async function compile(template: { id: string; workId?: string | null }) {
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: ENTITIES,
        });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        const query = dataSource
            .getRepository(Task)
            .createQueryBuilder('task')
            .setFindOptions({
                where: recurrenceOpenInstancesWhere(template, {
                    now: NOW,
                    escape: (name) => dataSource.driver.escape(name),
                }),
            });
        const sql = query.getQuery().replace(/\s+/g, ' ');
        const where = sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
        return { branches: where.split(' OR '), parameters: Object.values(query.getParameters()) };
    }

    const ages = (parameters: unknown[]) =>
        parameters
            .filter((value): value is Date => value instanceof Date)
            .map((date) => NOW.getTime() - date.getTime())
            .sort((a, b) => a - b);

    it('compiles to six OR-ed branches on Postgres for a template on a Work, every one bounded', async () => {
        const { branches, parameters } = await compile({ id: 'tpl-1', workId: 'work-1' });
        expect(branches).toHaveLength(6);
        for (const branch of branches) {
            expect(branch).toContain('"task"."parentRecurringTaskId" = ');
        }
        // 1: a run in flight that started (or was queued) in the window — any status.
        expect(branches[0]).not.toContain('"task"."status"');
        expect(branches[0]).toContain(
            'EXISTS (SELECT 1 FROM "agent_runs" "overlap_run" WHERE "overlap_run"."taskId" = "task"."id" ' +
                `AND "overlap_run"."status" IN ('queued', 'running') ` +
                'AND COALESCE("overlap_run"."startedAt", "overlap_run"."createdAt") >= :overlap_run_since)',
        );
        // 2-6: not Done or Cancelled.
        for (const branch of branches.slice(1)) {
            expect(branch).toContain('NOT("task"."status" IN (');
        }
        // 2: an open or draft PR still on the template's Work, read by the sweep in the window.
        expect(branches[1]).toContain('"task"."prState" IN (');
        expect(branches[1]).toContain('"task"."workId" = ');
        expect(branches[1]).toContain('"task"."ciCheckedAt" >= ');
        // 3: the same PR otherwise, for a week after the instance last changed.
        expect(branches[2]).toContain('"task"."prState" IN (');
        expect(branches[2]).not.toContain('"task"."workId"');
        expect(branches[2]).toContain('"task"."updatedAt" >= ');
        // 4: no pull-request outcome yet, spawned in the window.
        expect(branches[3]).toContain('"task"."prState" IS NULL');
        expect(branches[3]).toContain('"task"."createdAt" >= ');
        // 5: closed unmerged or "not found", changed in the last day (`updatedAt`).
        expect(branches[4]).toContain('"task"."prState" IN (');
        expect(branches[4]).toContain('"task"."updatedAt" >= ');
        // 6: closed unmerged only, read closed in the last day. Never "not found": the sweep
        // re-reads that one every 6 hours, so its read stamp would hold the slot for good.
        expect(branches[5]).toContain('"task"."prState" = ');
        expect(branches[5]).not.toContain('"task"."prState" IN (');
        expect(branches[5]).toContain('"task"."ciCheckedAt" >= ');

        expect(parameters).toEqual(
            expect.arrayContaining([
                'tpl-1',
                'work-1',
                'done',
                'cancelled',
                'open',
                'draft',
                'closed',
                'not_found',
            ]),
        );
        // Four week-long bounds (run, sweep read, last change, spawn) and the two-sided day hold.
        expect(ages(parameters)).toEqual([
            TASK_CLOSED_PR_SLOT_HOLD_MS,
            TASK_CLOSED_PR_SLOT_HOLD_MS,
            RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
            RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
            RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
            RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
        ]);
    });

    it('a template with no Work drops the sweep-confirmed branch instead of matching any Work', async () => {
        for (const workId of [null, undefined]) {
            const { branches, parameters } = await compile({ id: 'tpl-1', workId });
            expect(branches).toHaveLength(5);
            for (const branch of branches) {
                expect(branch).not.toContain('"task"."workId"');
            }
            expect(ages(parameters)).toHaveLength(5);
        }
    });
});
