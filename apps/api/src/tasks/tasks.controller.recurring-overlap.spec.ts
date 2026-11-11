// Same module-scope barrel stubs as `tasks.controller.recurring-controls.spec.ts`: the
// controller's DI types come from `@ever-works/agent` barrels whose runtime graphs do not load
// under this app's jest module mapping. The overlap bound carries its real value (pinned on the
// agent side by `recurrence-overlap.spec.ts`).
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskStatus: { TODO: 'todo', IN_PROGRESS: 'in_progress' },
    TaskPriority: { P3: 'p3' },
    RUN_BATCH_MAX_TASKS: 20,
    RECURRENCE_MAX_OPEN_INSTANCES_LIMIT: 100,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
    ownershipScopeOf: (row: { tenantId?: string | null; organizationId?: string | null }) => ({
        tenantId: row.tenantId ?? null,
        organizationId: row.organizationId ?? null,
    }),
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import { BadRequestException, ConflictException, ValidationPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
    TaskChatService,
    TaskPrStatusService,
    TaskReviewRejectionService,
    TasksService,
    TaskWorkspaceService,
} from '@ever-works/agent/tasks-domain';
import { AgentRepository, PluginUsageRepository } from '@ever-works/agent/database';
import { DecisionConflictService } from '@ever-works/agent/services';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { AgentEscalationService } from '@ever-works/agent/agents';
import { ScopeContextService } from '../scope/scope-context.service';
import { TasksController } from './tasks.controller';
import { RunRecurringNowDto, SetTaskRecurringDto } from './tasks.dto';

/**
 * Recurring Tasks overlap limit at the API boundary: `POST /api/tasks/:id/recurring` takes an
 * optional `recurrenceMaxOpenInstances` (validated; alone it updates only the limit), and
 * `POST /api/tasks/:id/recurring/run-now` takes an optional `force`.
 */
describe('TasksController — recurring overlap limit', () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const auth = { userId } as never;
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    async function build() {
        const service = {
            setRecurring: jest
                .fn()
                .mockResolvedValue({ id: taskId, recurrenceMaxOpenInstances: 3 }),
            runRecurringNow: jest.fn().mockResolvedValue({ templateId: taskId, runs: [] }),
        };
        const moduleRef = await Test.createTestingModule({
            controllers: [TasksController],
            providers: [
                { provide: TasksService, useValue: service },
                { provide: TaskChatService, useValue: {} },
                { provide: PluginUsageRepository, useValue: {} },
                { provide: AgentRepository, useValue: {} },
                { provide: TaskWorkspaceService, useValue: {} },
                { provide: DecisionConflictService, useValue: {} },
                { provide: TaskReviewRejectionService, useValue: {} },
                { provide: AgentEscalationService, useValue: {} },
                { provide: TaskPrStatusService, useValue: {} },
                { provide: ScopeContextService, useValue: { getScope: () => scope } },
                { provide: ActivityLogService, useValue: {} },
            ],
        }).compile();
        return { controller: moduleRef.get(TasksController), service };
    }

    async function errorsOf<T extends object>(cls: new () => T, body: unknown): Promise<string[]> {
        const errors = await validate(plainToInstance(cls, body) as object);
        return errors.map((error) => error.property);
    }

    describe('SetTaskRecurringDto.recurrenceMaxOpenInstances', () => {
        it.each([1, 3, 100, null])('accepts %p', async (value) => {
            expect(
                await errorsOf(SetTaskRecurringDto, {
                    recurrenceCron: '0 9 * * *',
                    recurrenceMaxOpenInstances: value,
                }),
            ).toEqual([]);
        });

        it('accepts a body without it (the field is optional)', async () => {
            expect(await errorsOf(SetTaskRecurringDto, { recurrenceCron: '0 9 * * *' })).toEqual(
                [],
            );
        });

        it.each([0, -1, 101, 2.5, '3', true])('refuses %p', async (value) => {
            expect(
                await errorsOf(SetTaskRecurringDto, {
                    recurrenceCron: '0 9 * * *',
                    recurrenceMaxOpenInstances: value,
                }),
            ).toEqual(['recurrenceMaxOpenInstances']);
        });
    });

    describe('RunRecurringNowDto.force', () => {
        it('accepts true, false and no body field; refuses a non-boolean', async () => {
            expect(await errorsOf(RunRecurringNowDto, { force: true })).toEqual([]);
            expect(await errorsOf(RunRecurringNowDto, { force: false })).toEqual([]);
            expect(await errorsOf(RunRecurringNowDto, {})).toEqual([]);
            expect(await errorsOf(RunRecurringNowDto, { force: 'yes' })).toEqual(['force']);
        });
    });

    describe('POST :id/recurring', () => {
        it('a body with only the limit updates just the limit', async () => {
            const { controller, service } = await build();
            await controller.setRecurring(auth, taskId, { recurrenceMaxOpenInstances: 2 } as never);
            expect(service.setRecurring).toHaveBeenCalledWith(
                userId,
                taskId,
                { recurrenceMaxOpenInstances: 2 },
                scope,
            );
            await controller.setRecurring(auth, taskId, {
                recurrenceMaxOpenInstances: null,
            } as never);
            expect(service.setRecurring).toHaveBeenLastCalledWith(
                userId,
                taskId,
                { recurrenceMaxOpenInstances: null },
                scope,
            );
        });

        it('a cadence with the limit passes both; a cadence without it leaves the limit out', async () => {
            const { controller, service } = await build();
            await controller.setRecurring(auth, taskId, {
                recurrenceCron: '0 9 * * *',
                recurrenceMaxOpenInstances: 3,
            } as never);
            expect(service.setRecurring.mock.calls[0][2]).toMatchObject({
                recurrenceCron: '0 9 * * *',
                recurrenceMaxOpenInstances: 3,
            });
            await controller.setRecurring(auth, taskId, { recurrenceCron: '0 9 * * *' } as never);
            expect(service.setRecurring.mock.calls[1][2]).not.toHaveProperty(
                'recurrenceMaxOpenInstances',
            );
        });

        it('an empty body is still a 400', async () => {
            const { controller, service } = await build();
            await expect(controller.setRecurring(auth, taskId, {} as never)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(service.setRecurring).not.toHaveBeenCalled();
        });

        it.each([
            { recurrenceMaxOccurrences: 5 },
            { recurrenceTimezone: 'UTC' },
            { recurrenceEndsAt: '2027-01-01T00:00:00.000Z' },
            { recurrenceEndsAt: null },
        ])(
            'the limit with any other recurrence field and no cadence is still a 400 (%p)',
            async (extra) => {
                const { controller, service } = await build();
                await expect(
                    controller.setRecurring(auth, taskId, {
                        recurrenceMaxOpenInstances: 2,
                        ...extra,
                    } as never),
                ).rejects.toBeInstanceOf(BadRequestException);
                expect(service.setRecurring).not.toHaveBeenCalled();
            },
        );
    });

    describe('POST :id/recurring/run-now', () => {
        it('passes force only when it is a literal true', async () => {
            const { controller, service } = await build();
            await controller.runRecurringNow(auth, taskId, undefined, true);
            expect(service.runRecurringNow).toHaveBeenCalledWith(userId, taskId, scope, {
                force: true,
            });
            for (const force of [false, 'true', 1, undefined]) {
                await controller.runRecurringNow(auth, taskId, undefined, force);
                expect(service.runRecurringNow).toHaveBeenLastCalledWith(userId, taskId, scope);
            }
            await controller.runRecurringNow(auth, taskId);
            expect(service.runRecurringNow).toHaveBeenLastCalledWith(userId, taskId, scope);
        });

        /**
         * Run-now took no body before #3146, so callers may send anything. The route's body
         * parameter goes through the GLOBAL pipe of `main.ts` (`whitelist` +
         * `forbidNonWhitelisted` + `transform`): this replays exactly what Nest does with the
         * handler's real parameter metadata, so a whole-body DTO here would fail it.
         */
        it('still accepts any body under the global pipe (unknown fields are ignored)', async () => {
            const args = Reflect.getMetadata(
                ROUTE_ARGS_METADATA,
                TasksController,
                'runRecurringNow',
            ) as Record<string, { index: number; data?: string }>;
            const bodyArgs = Object.entries(args).filter(([key]) =>
                key.startsWith(`${RouteParamtypes.BODY}:`),
            );
            expect(bodyArgs).toHaveLength(1);
            const [, { index, data }] = bodyArgs[0];
            expect(data).toBe('force');
            const metatype = (
                Reflect.getMetadata(
                    'design:paramtypes',
                    TasksController.prototype,
                    'runRecurringNow',
                ) as unknown[]
            )[index] as never;
            const pipe = new ValidationPipe({
                whitelist: true,
                transform: true,
                forbidNonWhitelisted: true,
            });
            const run = (body: Record<string, unknown>) =>
                pipe.transform(data ? body[data] : body, { type: 'body', metatype, data });

            await expect(run({ force: true, confirm: true, note: 'from a script' })).resolves.toBe(
                true,
            );
            await expect(run({ somethingElse: 1 })).resolves.toBeUndefined();
            await expect(run({})).resolves.toBeUndefined();
            // What a whole-body DTO would have done to the first body: refuse it.
            await expect(
                pipe.transform(
                    { force: true, note: 'from a script' },
                    { type: 'body', metatype: RunRecurringNowDto, data: undefined },
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('surfaces the 409 SCHEDULE_TOO_MANY_OPEN body unchanged', async () => {
            const { controller, service } = await build();
            const body = {
                code: 'SCHEDULE_TOO_MANY_OPEN',
                maxOpenInstances: 3,
                openInstances: 3,
                instances: [{ id: 'i-1', slug: 'T-10' }],
            };
            service.runRecurringNow.mockRejectedValueOnce(new ConflictException(body));
            const error = await controller.runRecurringNow(auth, taskId).catch((err) => err);
            expect(error.getResponse()).toMatchObject(body);
        });
    });
});
