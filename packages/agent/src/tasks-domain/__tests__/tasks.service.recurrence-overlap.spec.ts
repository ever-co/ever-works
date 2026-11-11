import { BadRequestException, ConflictException } from '@nestjs/common';
import { TasksService } from '../tasks.service';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';
import { AgentStatus } from '../../entities/agent.entity';
import { ActivityActionType } from '../../entities/activity-log.types';
import type { OpenRecurrenceInstances } from '../recurrence-overlap';

/**
 * Recurring Tasks overlap limit on the service side: run-now honours
 * `recurrenceMaxOpenInstances` (409 `SCHEDULE_TOO_MANY_OPEN` naming the open
 * instances, unless forced), `setRecurring` writes it (alone, or beside a
 * cadence, never by omission) and `clearRecurring` clears it.
 */

function template(overrides: Partial<Task> = {}): Task {
    return {
        id: 'tpl-1',
        userId: 'user-1',
        slug: 'T-1',
        title: 'Quality loop',
        description: null,
        status: TaskStatus.TODO,
        priority: TaskPriority.P3,
        labels: null,
        agentId: 'agent-1',
        isRecurring: true,
        recurrenceRule: null,
        recurrenceCron: '0 7 * * *',
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 7,
        recurrenceMaxOpenInstances: 3,
        recurrenceSkippedAt: null,
        parentRecurringTaskId: null,
        recurrencePausedAt: null,
        createdByType: 'user',
        createdById: 'user-1',
        requireAllApprovers: true,
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    } as Task;
}

function openInstances(count: number): OpenRecurrenceInstances {
    return {
        count,
        instances: Array.from({ length: Math.min(count, 10) }, (_, index) => ({
            id: `inst-${index + 1}`,
            slug: `T-${10 + index}`,
            title: 'Quality loop',
            status: TaskStatus.IN_REVIEW,
            prNumber: 100 + index,
            prUrl: `https://github.com/acme/app/pull/${100 + index}`,
            prState: 'open',
            createdAt: new Date('2026-11-01T00:00:00Z'),
        })),
    };
}

function build(task: Task, open: OpenRecurrenceInstances = openInstances(0)) {
    let current = task;
    const repos = {
        tasks: {
            findByIdAndUser: jest.fn(async () => current),
            updateById: jest.fn(async (_id: string, patch: Partial<Task>) => {
                current = { ...current, ...patch } as Task;
            }),
            create: jest.fn(async (data: Partial<Task>) => ({ ...data, id: 'instance-1' }) as Task),
            findLatestRecurrenceInstance: jest.fn().mockResolvedValue(null),
            countOpenRecurrenceInstances: jest.fn().mockResolvedValue(open),
            clearRecurrenceSkip: jest.fn().mockResolvedValue(true),
        },
        assignees: {
            findAgentAssignees: jest.fn().mockResolvedValue([]),
            findByTaskId: jest.fn().mockResolvedValue([]),
            add: jest.fn().mockResolvedValue(undefined),
        },
        counter: { nextSlug: jest.fn().mockResolvedValue(42) },
        transitions: {
            dispatchAgentRun: jest
                .fn()
                .mockResolvedValue({ runId: 'run-1', dispatched: true, parked: false }),
        },
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
        agents: {
            findByIdAndUser: jest
                .fn()
                .mockResolvedValue({ id: 'agent-1', status: AgentStatus.ACTIVE }),
        },
        agentRuns: { findLatestForTask: jest.fn().mockResolvedValue(null) },
    };
    const service = new TasksService(
        repos.tasks as never,
        repos.assignees as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        repos.counter as never,
        repos.transitions as never,
        repos.activityLog as never,
        undefined,
        repos.agents as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        repos.agentRuns as never,
    );
    return { service, repos, current: () => current };
}

describe('TasksService — recurring overlap limit', () => {
    describe('runRecurringNow', () => {
        it('refuses at the limit with 409 SCHEDULE_TOO_MANY_OPEN naming the open instances', async () => {
            const { service, repos } = build(template(), openInstances(3));
            const error = await service.runRecurringNow('user-1', 'tpl-1').catch((err) => err);

            expect(error).toBeInstanceOf(ConflictException);
            const body = error.getResponse();
            expect(body).toMatchObject({
                code: 'SCHEDULE_TOO_MANY_OPEN',
                maxOpenInstances: 3,
                openInstances: 3,
            });
            expect(body.message).toBe(
                'At most 3 instances of this schedule may be open at a time, and 3 instances are ' +
                    'still open (T-10, T-11, T-12). Review or close them, or run it anyway with force.',
            );
            expect(body.instances).toEqual([
                expect.objectContaining({ id: 'inst-1', slug: 'T-10', prNumber: 100 }),
                expect.objectContaining({ id: 'inst-2', slug: 'T-11' }),
                expect.objectContaining({ id: 'inst-3', slug: 'T-12' }),
            ]);
            // The rule reads the template row (its id and its Work), not just an id.
            expect(repos.tasks.countOpenRecurrenceInstances).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'tpl-1' }),
                expect.any(Date),
            );
            expect(repos.tasks.create).not.toHaveBeenCalled();
            expect(repos.transitions.dispatchAgentRun).not.toHaveBeenCalled();
        });

        it('with force it runs anyway and the activity row says it was forced', async () => {
            const { service, repos } = build(template(), openInstances(4));
            const result = await service.runRecurringNow('user-1', 'tpl-1', undefined, {
                force: true,
            });
            expect(result.instanceId).toBe('instance-1');
            expect(repos.transitions.dispatchAgentRun).toHaveBeenCalledTimes(1);
            expect(repos.activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.SCHEDULE_EXECUTED,
                    details: expect.objectContaining({
                        source: 'run-now',
                        maxOpenInstances: 3,
                        openInstances: 4,
                        forced: true,
                    }),
                }),
            );
        });

        it('below the limit it runs, and the row records the count without "forced"', async () => {
            const { service, repos } = build(template(), openInstances(2));
            await service.runRecurringNow('user-1', 'tpl-1');
            expect(repos.tasks.create).toHaveBeenCalledTimes(1);
            const details = repos.activityLog.log.mock.calls[0][0].details;
            expect(details).toMatchObject({ openInstances: 2, maxOpenInstances: 3, forced: false });
        });

        it('with no limit it never counts, and the activity row is what it always was', async () => {
            const { service, repos } = build(template({ recurrenceMaxOpenInstances: null }));
            await service.runRecurringNow('user-1', 'tpl-1');
            expect(repos.tasks.countOpenRecurrenceInstances).not.toHaveBeenCalled();
            const details = repos.activityLog.log.mock.calls[0][0].details;
            expect(details).not.toHaveProperty('maxOpenInstances');
            expect(details).not.toHaveProperty('forced');
        });

        it('force never bypasses the in-flight refusal', async () => {
            const { service, repos } = build(template(), openInstances(9));
            repos.tasks.findLatestRecurrenceInstance.mockResolvedValue({ id: 'inst-9' });
            repos.agentRuns.findLatestForTask.mockResolvedValue({ id: 'run-9', status: 'queued' });
            const error = await service
                .runRecurringNow('user-1', 'tpl-1', undefined, { force: true })
                .catch((err) => err);
            expect(error.getResponse()).toMatchObject({ code: 'SCHEDULE_ALREADY_RUNNING' });
            expect(repos.tasks.create).not.toHaveBeenCalled();
        });

        it('counts under the shared per-template claim (the key a scheduled fire holds)', async () => {
            const held = new Set<string>();
            const lock = {
                runExclusive: jest.fn(async (key: string, fn: () => Promise<unknown>) => {
                    held.add(key);
                    try {
                        return { acquired: true, result: await fn() };
                    } finally {
                        held.delete(key);
                    }
                }),
            };
            const { repos } = build(template(), openInstances(0));
            repos.tasks.countOpenRecurrenceInstances.mockImplementation(async () => {
                expect([...held]).toEqual(['schedule-run-now:tpl-1']);
                return openInstances(0);
            });
            const service = new TasksService(
                repos.tasks as never,
                repos.assignees as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                repos.counter as never,
                repos.transitions as never,
                repos.activityLog as never,
                undefined,
                repos.agents as never,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                repos.agentRuns as never,
                undefined,
                undefined,
                undefined,
                undefined,
                lock as never,
            );
            await service.runRecurringNow('user-1', 'tpl-1');
            expect(lock.runExclusive).toHaveBeenCalledWith(
                'schedule-run-now:tpl-1',
                expect.any(Function),
                expect.any(Object),
            );
            expect(repos.tasks.countOpenRecurrenceInstances).toHaveBeenCalledTimes(1);
        });

        it('an instance spawned out of band clears a skip marker, forced or not', async () => {
            const skippedAt = new Date('2026-11-10T09:00:00Z');
            const normal = build(template({ recurrenceSkippedAt: skippedAt }), openInstances(1));
            await normal.service.runRecurringNow('user-1', 'tpl-1');
            expect(normal.repos.tasks.clearRecurrenceSkip).toHaveBeenCalledWith('tpl-1');

            const forced = build(template({ recurrenceSkippedAt: skippedAt }), openInstances(3));
            await forced.service.runRecurringNow('user-1', 'tpl-1', undefined, { force: true });
            expect(forced.repos.tasks.clearRecurrenceSkip).toHaveBeenCalledWith('tpl-1');
            // A quiet write: the template row itself is never updated by run-now.
            expect(forced.repos.tasks.updateById).not.toHaveBeenCalled();
        });

        it('no skip marker, no clear; a refused run-now clears nothing', async () => {
            const plain = build(template({ recurrenceSkippedAt: null }), openInstances(0));
            await plain.service.runRecurringNow('user-1', 'tpl-1');
            expect(plain.repos.tasks.clearRecurrenceSkip).not.toHaveBeenCalled();

            const refused = build(
                template({ recurrenceSkippedAt: new Date('2026-11-10T09:00:00Z') }),
                openInstances(3),
            );
            await expect(refused.service.runRecurringNow('user-1', 'tpl-1')).rejects.toBeInstanceOf(
                ConflictException,
            );
            expect(refused.repos.tasks.clearRecurrenceSkip).not.toHaveBeenCalled();
        });
    });

    describe('setRecurring', () => {
        it('a limit alone updates only the limit of a recurring template', async () => {
            const { service, repos, current } = build(
                template({ recurrenceMaxOpenInstances: null }),
            );
            const before = current();
            await service.setRecurring('user-1', 'tpl-1', { recurrenceMaxOpenInstances: 2 });
            expect(repos.tasks.updateById).toHaveBeenCalledTimes(1);
            expect(repos.tasks.updateById.mock.calls[0][1]).toEqual({
                recurrenceMaxOpenInstances: 2,
            });
            expect(current().nextOccurrenceAt).toEqual(before.nextOccurrenceAt);
            expect(current().recurrenceCron).toBe(before.recurrenceCron);
        });

        it('null clears it; the same value again writes nothing', async () => {
            const { service, repos } = build(template({ recurrenceMaxOpenInstances: 3 }));
            await service.setRecurring('user-1', 'tpl-1', { recurrenceMaxOpenInstances: 3 });
            expect(repos.tasks.updateById).not.toHaveBeenCalled();
            await service.setRecurring('user-1', 'tpl-1', { recurrenceMaxOpenInstances: null });
            expect(repos.tasks.updateById.mock.calls[0][1]).toEqual({
                recurrenceMaxOpenInstances: null,
            });
        });

        it('clearing the limit (null) also clears the skip marker; changing it does not', async () => {
            const skippedAt = new Date('2026-11-10T09:00:00Z');
            const cleared = build(
                template({ recurrenceMaxOpenInstances: 3, recurrenceSkippedAt: skippedAt }),
            );
            await cleared.service.setRecurring('user-1', 'tpl-1', {
                recurrenceMaxOpenInstances: null,
            });
            expect(cleared.repos.tasks.updateById.mock.calls[0][1]).toEqual({
                recurrenceMaxOpenInstances: null,
                recurrenceSkippedAt: null,
            });

            const viaCadence = build(
                template({ recurrenceMaxOpenInstances: 3, recurrenceSkippedAt: skippedAt }),
            );
            await viaCadence.service.setRecurring('user-1', 'tpl-1', {
                recurrenceCron: '0 9 * * *',
                recurrenceMaxOpenInstances: null,
            });
            expect(viaCadence.repos.tasks.updateById.mock.calls[0][1]).toMatchObject({
                recurrenceMaxOpenInstances: null,
                recurrenceSkippedAt: null,
            });

            const raised = build(
                template({ recurrenceMaxOpenInstances: 3, recurrenceSkippedAt: skippedAt }),
            );
            await raised.service.setRecurring('user-1', 'tpl-1', { recurrenceMaxOpenInstances: 5 });
            expect(raised.repos.tasks.updateById.mock.calls[0][1]).toEqual({
                recurrenceMaxOpenInstances: 5,
            });
        });

        it.each([
            { recurrenceMaxOccurrences: 5 },
            { recurrenceTimezone: 'UTC' },
            { recurrenceEndsAt: null },
        ])(
            'the limit with another recurrence field and no cadence stays a 400 (%p)',
            async (extra) => {
                const { service, repos } = build(template());
                await expect(
                    service.setRecurring('user-1', 'tpl-1', {
                        recurrenceMaxOpenInstances: 2,
                        ...extra,
                    }),
                ).rejects.toBeInstanceOf(BadRequestException);
                expect(repos.tasks.updateById).not.toHaveBeenCalled();
            },
        );

        it('a limit alone on a Task that is not a recurring template is a 400', async () => {
            const plain = build(template({ isRecurring: false }));
            await expect(
                plain.service.setRecurring('user-1', 'tpl-1', { recurrenceMaxOpenInstances: 2 }),
            ).rejects.toBeInstanceOf(BadRequestException);
            const instance = build(template({ parentRecurringTaskId: 'tpl-0' }));
            await expect(
                instance.service.setRecurring('user-1', 'tpl-1', { recurrenceMaxOpenInstances: 2 }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it.each([0, -1, 1.5, 101])('refuses %p', async (value) => {
            const { service, repos } = build(template());
            await expect(
                service.setRecurring('user-1', 'tpl-1', { recurrenceMaxOpenInstances: value }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repos.tasks.updateById).not.toHaveBeenCalled();
        });

        it('a cadence with a limit writes both; a cadence without one keeps the limit', async () => {
            const withLimit = build(template({ recurrenceMaxOpenInstances: null }));
            await withLimit.service.setRecurring('user-1', 'tpl-1', {
                recurrenceCron: '0 9 * * *',
                recurrenceMaxOpenInstances: 1,
            });
            expect(withLimit.repos.tasks.updateById.mock.calls[0][1]).toMatchObject({
                recurrenceCron: '0 9 * * *',
                recurrenceMaxOpenInstances: 1,
            });

            const keep = build(template({ recurrenceMaxOpenInstances: 3 }));
            await keep.service.setRecurring('user-1', 'tpl-1', { recurrenceCron: '0 9 * * *' });
            expect(keep.repos.tasks.updateById.mock.calls[0][1]).not.toHaveProperty(
                'recurrenceMaxOpenInstances',
            );
            expect(keep.current().recurrenceMaxOpenInstances).toBe(3);
        });
    });

    describe('clearRecurring', () => {
        it('clears the limit and the skip marker with the recurrence; leaves other clears unchanged', async () => {
            const limited = build(
                template({ recurrenceMaxOpenInstances: 2, recurrenceSkippedAt: new Date() }),
            );
            await limited.service.clearRecurring('user-1', 'tpl-1');
            expect(limited.repos.tasks.updateById.mock.calls[0][1]).toMatchObject({
                isRecurring: false,
                recurrenceMaxOpenInstances: null,
                recurrenceSkippedAt: null,
            });

            const plain = build(template({ recurrenceMaxOpenInstances: null }));
            await plain.service.clearRecurring('user-1', 'tpl-1');
            const patch = plain.repos.tasks.updateById.mock.calls[0][1];
            expect(patch).not.toHaveProperty('recurrenceMaxOpenInstances');
            expect(patch).not.toHaveProperty('recurrenceSkippedAt');
        });
    });
});
