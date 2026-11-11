import { TaskRecurrenceDispatcherService } from '../task-recurrence-dispatcher.service';
import { computeNextTemplateOccurrence } from '../recurrence';
import { TaskPriority, TaskStatus } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * Missed slots COALESCE (review of #3166, finding 2; the owner's decision):
 * after the dispatcher was down, a template fires at most ONE catch-up run and
 * then resumes its schedule from now. It used to replay every missed slot, one
 * per per-minute tick: a daily rule three days late fired four times, an
 * hourly one 75 hours late fired 76 times — each a Task and a paid agent run.
 */

const NOW = new Date('2026-11-12T12:00:00Z');

describe('computeNextTemplateOccurrence with "now" — the next slot after the outage', () => {
    it.each([
        // 12:00Z is past 09:00 in UTC and in Berlin (13:00 CET): tomorrow's 09:00.
        ['UTC', '2026-11-13T09:00:00.000Z'],
        ['Europe/Berlin', '2026-11-13T08:00:00.000Z'],
        // …and 07:00 EST in New York: today's 09:00 is still ahead.
        ['America/New_York', '2026-11-12T14:00:00.000Z'],
    ])(
        'a daily rule last due three days ago (%s): the first 09:00 after now, not the day after the missed one',
        (timezone, expected) => {
            expect(
                computeNextTemplateOccurrence({
                    rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
                    from: new Date('2026-11-09T09:00:00Z'),
                    now: NOW,
                    timezone,
                })?.toISOString(),
            ).toBe(expected);
        },
    );

    it('an hourly rule 75 hours late: the next run is the next hour after now', () => {
        expect(
            computeNextTemplateOccurrence({
                rule: 'FREQ=HOURLY;BYMINUTE=0',
                from: new Date('2026-11-09T09:00:00Z'),
                now: NOW,
                timezone: 'UTC',
            })?.toISOString(),
        ).toBe('2026-11-12T13:00:00.000Z');
    });

    it('cron cadences coalesce the same way', () => {
        expect(
            computeNextTemplateOccurrence({
                cron: '0 * * * *',
                from: new Date('2026-11-09T09:00:00Z'),
                now: NOW,
                timezone: 'Europe/Berlin',
            })?.toISOString(),
        ).toBe('2026-11-12T13:00:00.000Z');
    });

    it('a rule without a time keeps the time of day of the slot that fired, not of "now"', () => {
        // FREQ=DAILY takes its time from the series anchor (the missed 06:30 slot).
        expect(
            computeNextTemplateOccurrence({
                rule: 'FREQ=DAILY',
                from: new Date('2026-11-09T06:30:00Z'),
                now: NOW,
                timezone: 'UTC',
            })?.toISOString(),
        ).toBe('2026-11-13T06:30:00.000Z');
    });

    it('on time (now just after the slot) the next run is the ordinary next slot', () => {
        expect(
            computeNextTemplateOccurrence({
                rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
                from: new Date('2026-11-12T09:00:00Z'),
                now: new Date('2026-11-12T09:00:40Z'),
                timezone: 'UTC',
            })?.toISOString(),
        ).toBe('2026-11-13T09:00:00.000Z');
    });
});

function makeTemplate(over: Partial<Task>): Task {
    return {
        id: 'tmpl-1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Quality loop',
        description: null,
        status: TaskStatus.BACKLOG,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: false,
        startedAt: null,
        completedAt: null,
        isRecurring: true,
        recurrenceRule: null,
        recurrenceCron: null,
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: null,
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        recurrenceMaxOpenInstances: null,
        recurrenceSkippedAt: null,
        parentRecurringTaskId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...over,
    } as Task;
}

/**
 * One template in a fake repository with the real CAS semantics: due while
 * `nextOccurrenceAt <= now`, and a claim moves `nextOccurrenceAt` only from the
 * value it expects. The dispatcher then runs once per minute, as the cron does.
 */
function harness(template: Task, openInstances = 0) {
    let row = { ...template } as Task;
    const tasks = {
        findDueRecurringTemplates: jest.fn(async (_limit: number, now: Date) =>
            row.nextOccurrenceAt && row.nextOccurrenceAt.getTime() <= now.getTime()
                ? [{ ...row } as Task]
                : [],
        ),
        casClaimRecurrence: jest.fn(async (_id: string, expected: Date, next: Date | null) => {
            if (row.nextOccurrenceAt?.getTime() !== expected.getTime()) return false;
            row = {
                ...row,
                nextOccurrenceAt: next,
                recurrenceOccurredCount: (row.recurrenceOccurredCount ?? 0) + 1,
            } as Task;
            return true;
        }),
        casSkipRecurrence: jest.fn(
            async (_id: string, expected: Date, next: Date | null, skippedAt: Date) => {
                if (row.nextOccurrenceAt?.getTime() !== expected.getTime()) return false;
                row = { ...row, nextOccurrenceAt: next, recurrenceSkippedAt: skippedAt } as Task;
                return true;
            },
        ),
        countOpenRecurrenceInstances: jest.fn(async () => ({
            count: openInstances,
            instances: [],
        })),
        create: jest.fn(async (data: Partial<Task>) => ({ ...data, id: 'instance' }) as Task),
    };
    const counter = { nextSlug: jest.fn().mockResolvedValue(42) };
    const service = new TaskRecurrenceDispatcherService(tasks as never, counter as never);
    return {
        tasks,
        current: () => row,
        /** Run the per-minute tick `minutes` times from `start`. */
        async tick(start: Date, minutes: number) {
            let spawned = 0;
            let skipped = 0;
            for (let minute = 0; minute < minutes; minute += 1) {
                const summary = await service.dispatchDue(
                    50,
                    new Date(start.getTime() + minute * 60_000),
                );
                spawned += summary.spawned;
                skipped += summary.skipped;
            }
            return { spawned, skipped };
        },
    };
}

describe('TaskRecurrenceDispatcherService — one catch-up run per outage', () => {
    it('a daily template three days late fires once, then waits for the next slot after now', async () => {
        const h = harness(
            makeTemplate({
                recurrenceRule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
                nextOccurrenceAt: new Date('2026-11-09T09:00:00Z'),
            }),
        );

        const { spawned } = await h.tick(NOW, 30);

        expect(spawned).toBe(1);
        expect(h.tasks.create).toHaveBeenCalledTimes(1);
        expect(h.current().nextOccurrenceAt?.toISOString()).toBe('2026-11-13T09:00:00.000Z');
        expect(h.current().recurrenceOccurredCount).toBe(1);
    });

    it('an hourly template 75 hours late fires once, then on the next hour', async () => {
        const h = harness(
            makeTemplate({
                recurrenceCron: '0 * * * *',
                recurrenceTimezone: 'Europe/Berlin',
                nextOccurrenceAt: new Date('2026-11-09T09:00:00Z'),
            }),
        );

        const { spawned } = await h.tick(NOW, 30);

        expect(spawned).toBe(1);
        expect(h.current().nextOccurrenceAt?.toISOString()).toBe('2026-11-12T13:00:00.000Z');
        // And the schedule carries on normally from there.
        const after = await h.tick(new Date('2026-11-12T13:00:00Z'), 61);
        expect(after.spawned).toBe(2); // 13:00 and 14:00
        expect(h.current().nextOccurrenceAt?.toISOString()).toBe('2026-11-12T15:00:00.000Z');
    });

    it('a template at its overlap limit skips the whole backlog in one skip, not one per tick', async () => {
        const h = harness(
            makeTemplate({
                recurrenceRule: 'FREQ=HOURLY;BYMINUTE=0',
                recurrenceMaxOpenInstances: 1,
                nextOccurrenceAt: new Date('2026-11-09T09:00:00Z'),
            }),
            1,
        );

        const { spawned, skipped } = await h.tick(NOW, 30);

        expect(spawned).toBe(0);
        expect(skipped).toBe(1);
        expect(h.tasks.casSkipRecurrence).toHaveBeenCalledTimes(1);
        expect(h.current().nextOccurrenceAt?.toISOString()).toBe('2026-11-12T13:00:00.000Z');
    });

    it('a template on time fires once per slot, exactly as before', async () => {
        const h = harness(
            makeTemplate({
                recurrenceRule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
                nextOccurrenceAt: new Date('2026-11-12T09:00:00Z'),
            }),
        );

        const { spawned } = await h.tick(new Date('2026-11-12T09:00:00Z'), 5);

        expect(spawned).toBe(1);
        expect(h.current().nextOccurrenceAt?.toISOString()).toBe('2026-11-13T09:00:00.000Z');
    });
});
