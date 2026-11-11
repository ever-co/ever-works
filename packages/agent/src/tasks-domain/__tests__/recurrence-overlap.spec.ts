import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { Task, TaskStatus } from '../../entities/task.entity';
import {
    RECURRENCE_MAX_OPEN_INSTANCES_LIMIT,
    RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
    RECURRENCE_SKIP_RECORD_GAP_MS,
    describeRecurrenceRefusal,
    describeRecurrenceSkip,
    normalizeMaxOpenInstances,
    recurrenceActiveRunExists,
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

    it('shouldRecordRecurrenceSkip: the first of a run of skips, then one per gap', () => {
        expect(shouldRecordRecurrenceSkip(null, NOW)).toBe(true);
        expect(shouldRecordRecurrenceSkip(undefined, NOW)).toBe(true);
        const justBefore = new Date(NOW.getTime() - RECURRENCE_SKIP_RECORD_GAP_MS + 1);
        expect(shouldRecordRecurrenceSkip(justBefore, NOW)).toBe(false);
        const gapAgo = new Date(NOW.getTime() - RECURRENCE_SKIP_RECORD_GAP_MS);
        expect(shouldRecordRecurrenceSkip(gapAgo, NOW)).toBe(true);
        // A daily schedule's previous skip is a day old: every skip is recorded.
        expect(shouldRecordRecurrenceSkip(new Date(NOW.getTime() - 86_400_000), NOW)).toBe(true);
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
    it('compiles to five OR-ed branches on Postgres, each scoped to the template', async () => {
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
                where: recurrenceOpenInstancesWhere('tpl-1', {
                    now: NOW,
                    activeRunExists: recurrenceActiveRunExists((name) =>
                        dataSource.driver.escape(name),
                    ),
                }),
            });
        const sql = query.getQuery().replace(/\s+/g, ' ');
        const where = sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
        const branches = where.split(' OR ');
        expect(branches).toHaveLength(5);
        for (const branch of branches) {
            expect(branch).toContain('"task"."parentRecurringTaskId" = ');
        }
        // 1: a run in flight — any status, any pull-request state.
        expect(branches[0]).not.toContain('"task"."status"');
        expect(branches[0]).toContain(
            'EXISTS (SELECT 1 FROM "agent_runs" "overlap_run" WHERE "overlap_run"."taskId" = "task"."id" AND "overlap_run"."status" IN (\'queued\', \'running\'))',
        );
        // 2-5: not Done or Cancelled.
        for (const branch of branches.slice(1)) {
            expect(branch).toContain('NOT("task"."status" IN (');
        }
        // 2: an open or draft pull request — no age bound.
        expect(branches[1]).toContain('"task"."prState" IN (');
        expect(branches[1]).not.toContain('"task"."createdAt"');
        // 3: no pull-request outcome yet, spawned in the window.
        expect(branches[2]).toContain('"task"."prState" IS NULL');
        expect(branches[2]).toContain('"task"."createdAt" >= ');
        // 4-5: closed unmerged, changed in the last day by either timestamp.
        expect(branches[3]).toContain('"task"."updatedAt" >= ');
        expect(branches[4]).toContain('"task"."ciCheckedAt" >= ');

        const parameters = Object.values(query.getParameters());
        expect(parameters).toEqual(
            expect.arrayContaining(['tpl-1', 'done', 'cancelled', 'open', 'draft', 'closed']),
        );
        const dates = parameters.filter((value): value is Date => value instanceof Date);
        expect(dates.map((date) => NOW.getTime() - date.getTime()).sort((a, b) => a - b)).toEqual([
            TASK_CLOSED_PR_SLOT_HOLD_MS,
            TASK_CLOSED_PR_SLOT_HOLD_MS,
            RECURRENCE_OPEN_INSTANCE_WINDOW_MS,
        ]);
    });
});
