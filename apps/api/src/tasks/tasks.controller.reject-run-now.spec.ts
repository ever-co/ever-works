jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskBoardService: class {},
    TaskStatus: {
        BACKLOG: 'backlog',
        TODO: 'todo',
        IN_PROGRESS: 'in_progress',
        IN_REVIEW: 'in_review',
        DONE: 'done',
    },
    TaskPriority: { P3: 'p3' },
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
    ownershipScopeOf: () => ({ tenantId: null, organizationId: null }),
    ownershipRelationScopeOf: () => undefined,
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { TasksController } from './tasks.controller';

/**
 * `POST /api/tasks/:id/reject` with `runNow` (2026-11-11).
 *
 * Production incident: findings were recorded with `POST /:id/reject` and a
 * run started separately with `POST /:id/run`; nothing tied the two together
 * and the run never saw the findings. The run side is fixed in the planner
 * and the worker (a fresh run now carries unaddressed findings); `runNow`
 * makes "reject and have the agent fix it" one request.
 *
 * What these pin:
 *
 *  - without `runNow` the contract is unchanged: record, answer the row,
 *    start nothing;
 *  - with `runNow` the run is started AFTER the rejection is recorded,
 *    through the batch path (`runTasksBatch` → `runTask`, the same Agent
 *    resolution and refusals as `POST /:id/run`), in the request's scope;
 *  - a run that cannot start is DATA (`run.ok: false`), never an error
 *    status: the rejection IS recorded, and a client must not retry it;
 *  - a fleet-run credential is refused before anything is recorded.
 */
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
const session = { userId: USER_ID, authMethod: 'session' } as never;
const runToken = {
    fleetRunCredential: { jobId: 'job-1', organizationId: null, agentId: 'agent-1' },
};
const createdAt = new Date('2026-11-11T09:00:00Z');

function build() {
    const order: string[] = [];
    const service = {
        getOne: jest.fn().mockResolvedValue({ id: TASK_ID, userId: USER_ID }),
        runTask: jest.fn(),
        runTasksBatch: jest.fn(async () => {
            order.push('run');
            return {
                results: [
                    {
                        taskId: TASK_ID,
                        ok: true,
                        run: {
                            taskId: TASK_ID,
                            agentId: 'agent-1',
                            runId: 'run-2',
                            dispatched: true,
                            parked: false,
                        },
                    },
                ],
            };
        }),
    };
    const rejections = {
        rejectTask: jest.fn(async () => {
            order.push('reject');
            return { id: 'rej-1', taskId: TASK_ID, source: 'task-review', createdAt };
        }),
    };
    const controller = new TasksController(
        service as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        rejections as never,
        {} as never,
        {} as never,
        { getScope: () => scope } as never,
    );
    return { controller, service, rejections, order };
}

describe('TasksController.rejectTask — runNow', () => {
    it('without runNow: records and starts nothing (the contract is unchanged)', async () => {
        const { controller, service, rejections } = build();
        const result = await controller.rejectTask(session, TASK_ID, {
            feedback: 'The retry path drops the auth header.',
            runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        } as never);

        expect(result).toEqual({
            id: 'rej-1',
            taskId: TASK_ID,
            source: 'task-review',
            createdAt,
        });
        expect(rejections.rejectTask).toHaveBeenCalledWith(
            USER_ID,
            TASK_ID,
            'The retry path drops the auth header.',
            { runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        );
        expect(service.runTasksBatch).not.toHaveBeenCalled();
        expect(service.runTask).not.toHaveBeenCalled();
    });

    it('runNow: false is the same as leaving it out', async () => {
        const { controller, service } = build();
        await controller.rejectTask(session, TASK_ID, {
            feedback: 'x',
            runNow: false,
        } as never);
        expect(service.runTasksBatch).not.toHaveBeenCalled();
    });

    it('runNow: records FIRST, then starts the fix run through the run path, in the request scope', async () => {
        const { controller, service, order } = build();
        const result = await controller.rejectTask(session, TASK_ID, {
            feedback: 'The retry path drops the auth header.',
            runNow: true,
        } as never);

        expect(order).toEqual(['reject', 'run']);
        expect(service.getOne).toHaveBeenCalledWith(USER_ID, TASK_ID, scope);
        expect(service.runTasksBatch).toHaveBeenCalledWith(
            USER_ID,
            [{ taskId: TASK_ID, agentId: null }],
            scope,
        );
        expect(result).toEqual({
            id: 'rej-1',
            taskId: TASK_ID,
            source: 'task-review',
            createdAt,
            run: {
                taskId: TASK_ID,
                ok: true,
                run: {
                    taskId: TASK_ID,
                    agentId: 'agent-1',
                    runId: 'run-2',
                    dispatched: true,
                    parked: false,
                },
            },
        });
    });

    it('runNow: a run that cannot start is reported, not thrown — the rejection stands', async () => {
        const { controller, service } = build();
        service.runTasksBatch.mockResolvedValueOnce({
            results: [
                {
                    taskId: TASK_ID,
                    ok: false,
                    error: {
                        code: 'RUN_ALREADY_IN_FLIGHT',
                        message: 'This Task already has a run in flight for that Agent.',
                    },
                } as never,
            ],
        });
        const result = await controller.rejectTask(session, TASK_ID, {
            feedback: 'x',
            runNow: true,
        } as never);
        expect(result).toMatchObject({
            id: 'rej-1',
            run: { ok: false, error: { code: 'RUN_ALREADY_IN_FLIGHT' } },
        });
    });

    it('a fleet-run credential is refused before anything is recorded or started', async () => {
        const { controller, service, rejections } = build();
        await expect(
            controller.rejectTask(
                session,
                TASK_ID,
                { feedback: 'redo', runNow: true } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(rejections.rejectTask).not.toHaveBeenCalled();
        expect(service.runTasksBatch).not.toHaveBeenCalled();
    });

    it('a Task the caller cannot see is refused before anything is recorded', async () => {
        const { controller, service, rejections } = build();
        service.getOne.mockRejectedValueOnce(new Error('Task not found'));
        await expect(
            controller.rejectTask(session, TASK_ID, { feedback: 'x', runNow: true } as never),
        ).rejects.toThrow('Task not found');
        expect(rejections.rejectTask).not.toHaveBeenCalled();
        expect(service.runTasksBatch).not.toHaveBeenCalled();
    });
});
