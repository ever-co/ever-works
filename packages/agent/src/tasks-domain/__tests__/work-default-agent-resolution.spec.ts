import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ownershipScopeMatches, type OwnershipScope } from '../../database/ownership-scope';
import { AgentStatus, type Agent } from '../../entities/agent.entity';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';
import { RUN_AGENT_AMBIGUOUS, TasksService } from '../tasks.service';

/**
 * The Work's default Agent (`works.defaultAgentId`) in every `TasksService` path that resolves
 * "the Work's Agent" for a Task nobody named an Agent for:
 *
 *   - `resolveRunAgentForNewTask` — what a Mission's Task output checks before it plans;
 *   - `runTask` — the Run button, and the Mission tick's start of a filed Task;
 *   - `listRunCandidates` — the agent picker.
 *
 * Order: explicit > the Task's own Agent > the Work's default > the Work's only Agent. A default
 * that no longer resolves (archived, deleted, another scope) is ignored, never obeyed.
 */

const SCOPE: OwnershipScope = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';

function agent(id: string, over: Partial<Agent> = {}): Agent {
    return {
        id,
        userId: 'u1',
        name: `Agent ${id}`,
        status: AgentStatus.ACTIVE,
        ...SCOPE,
        ...over,
    } as Agent;
}

/** Owner- and scope-bound, exactly like `AgentRepository.findByIdAndUser` / `findByUserIdScoped`. */
function agentRepo(rows: Agent[]) {
    const visible = (row: Agent, userId: string, scope?: OwnershipScope) =>
        row.userId === userId && ownershipScopeMatches(row, scope);
    return {
        findByIdAndUser: jest.fn(async (id: string, userId: string, scope?: OwnershipScope) => {
            return rows.find((row) => row.id === id && visible(row, userId, scope)) ?? null;
        }),
        findByUserIdScoped: jest.fn(
            async (userId: string, filter: { workId?: string }, scope?: OwnershipScope) => {
                const found = rows.filter(
                    (row) =>
                        visible(row, userId, scope) &&
                        row.status !== AgentStatus.ARCHIVED &&
                        (!filter.workId || row.workId === filter.workId),
                );
                return { rows: found, total: found.length };
            },
        ),
    };
}

function workRepo(defaultAgentId: string | null | 'throws') {
    return {
        findById: jest.fn(async (id: string) => {
            if (defaultAgentId === 'throws') throw new Error('connection reset');
            return { id, userId: 'u1', ...SCOPE, defaultAgentId };
        }),
    };
}

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Refresh the install guide',
        status: TaskStatus.TODO,
        priority: TaskPriority.P3,
        workId: 'w-docs',
        agentId: null,
        labels: null,
        ...SCOPE,
        ...over,
    } as Task;
}

function build(opts: {
    agents: ReturnType<typeof agentRepo>;
    works?: ReturnType<typeof workRepo>;
    task?: Task;
    assigneeIds?: string[];
}) {
    const tasks = { findByIdAndUser: jest.fn().mockResolvedValue(opts.task ?? makeTask()) };
    const assignees = {
        findAgentAssignees: jest
            .fn()
            .mockResolvedValue((opts.assigneeIds ?? []).map((assigneeId) => ({ assigneeId }))),
    };
    const transitions = {
        dispatchAgentRun: jest
            .fn()
            .mockResolvedValue({ runId: 'r1', dispatched: true, parked: false }),
    };
    const agentRuns = { findInFlightForTaskAgent: jest.fn().mockResolvedValue(null) };
    const svc = new TasksService(
        tasks as never,
        assignees as never,
        {} as never, // reviewers
        {} as never, // approvers
        {} as never, // blocks
        {} as never, // relations
        {} as never, // counter
        transitions as never,
        undefined, // activityLog
        undefined, // attachments
        opts.agents as never,
        undefined, // notifications
        undefined, // workUploads
        opts.works as never,
        undefined, // missions
        undefined, // ideas
        undefined, // teams
        undefined, // goals
        agentRuns as never,
    );
    return { svc, transitions };
}

// A tenant/organization-scope Agent serving several Works: pinned to none of them.
const shared = agent('agent-shared');
// The one Agent pinned to the docs Work — what the older "only Agent" rule finds.
const pinned = agent('agent-pinned', { workId: 'w-docs' });

describe('TasksService.resolveRunAgentForNewTask — with a Work default Agent', () => {
    it('explicit > Work default > the Work’s only Agent', async () => {
        const explicit = agent('agent-explicit');
        const agents = agentRepo([explicit, shared, pinned]);
        const { svc } = build({ agents, works: workRepo(shared.id) });

        await expect(
            svc.resolveRunAgentForNewTask('u1', { workId: 'w-docs', agentId: explicit.id }, SCOPE),
        ).resolves.toBe(explicit);
        await expect(
            svc.resolveRunAgentForNewTask('u1', { workId: 'w-docs' }, SCOPE),
        ).resolves.toBe(shared);

        const { svc: noDefault } = build({ agents, works: workRepo(null) });
        await expect(
            noDefault.resolveRunAgentForNewTask('u1', { workId: 'w-docs' }, SCOPE),
        ).resolves.toBe(pinned);
    });

    it('finds the shared Agent the older rule never could (it is pinned to no Work)', async () => {
        const agents = agentRepo([shared]);
        const { svc: before } = build({ agents, works: workRepo(null) });
        await expect(
            before.resolveRunAgentForNewTask('u1', { workId: 'w-docs' }, SCOPE),
        ).resolves.toBeNull();
        const { svc: after } = build({ agents, works: workRepo(shared.id) });
        await expect(
            after.resolveRunAgentForNewTask('u1', { workId: 'w-docs' }, SCOPE),
        ).resolves.toBe(shared);
    });

    it('ignores a stale default — archived or deleted — and falls back to the only Agent', async () => {
        const archived = agent('agent-archived', { status: AgentStatus.ARCHIVED });
        for (const defaultAgentId of [archived.id, 'agent-deleted']) {
            const { svc } = build({
                agents: agentRepo([archived, pinned]),
                works: workRepo(defaultAgentId),
            });
            await expect(
                svc.resolveRunAgentForNewTask('u1', { workId: 'w-docs' }, SCOPE),
            ).resolves.toBe(pinned);
        }
    });

    it('ignores a default from another organization even when a read hands it back', async () => {
        const foreign = agent('agent-foreign', { organizationId: OTHER_ORG });
        // A repository that forgot the scope predicate must still not let it through.
        const leaky = agentRepo([foreign, pinned]);
        leaky.findByIdAndUser.mockImplementation(async (id: string) =>
            id === foreign.id ? foreign : null,
        );
        const { svc } = build({ agents: leaky, works: workRepo(foreign.id) });
        await expect(
            svc.resolveRunAgentForNewTask('u1', { workId: 'w-docs' }, SCOPE),
        ).resolves.toBe(pinned);
    });

    it('a Work that cannot be read throws, so the Mission skips it this tick', async () => {
        const { svc } = build({ agents: agentRepo([pinned]), works: workRepo('throws') });
        await expect(
            svc.resolveRunAgentForNewTask('u1', { workId: 'w-docs' }, SCOPE),
        ).rejects.toThrow('connection reset');
    });
});

describe('TasksService.runTask — with a Work default Agent', () => {
    it('a Task that names no Agent runs the Work default, even beside a Work-scoped Agent', async () => {
        const { svc, transitions } = build({
            agents: agentRepo([shared, pinned]),
            works: workRepo(shared.id),
        });
        const result = await svc.runTask('u1', 't1', {}, SCOPE);
        expect(result.agentId).toBe(shared.id);
        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: 't1' }),
            shared.id,
            expect.anything(),
        );
    });

    it('the explicit Agent and the Task’s own Agent still win over the default', async () => {
        const own = agent('agent-own');
        const agents = agentRepo([own, shared]);
        const { svc } = build({ agents, works: workRepo(shared.id) });
        await expect(svc.runTask('u1', 't1', { agentId: own.id }, SCOPE)).resolves.toMatchObject({
            agentId: own.id,
        });

        const { svc: assigned } = build({
            agents,
            works: workRepo(shared.id),
            assigneeIds: [own.id],
        });
        await expect(assigned.runTask('u1', 't1', {}, SCOPE)).resolves.toMatchObject({
            agentId: own.id,
        });

        const { svc: taskAgent } = build({
            agents,
            works: workRepo(shared.id),
            task: makeTask({ agentId: own.id }),
        });
        await expect(taskAgent.runTask('u1', 't1', {}, SCOPE)).resolves.toMatchObject({
            agentId: own.id,
        });
    });

    it('naming a default never makes a Task that named its own Agent ambiguous', async () => {
        const own = agent('agent-own');
        const { svc } = build({
            agents: agentRepo([own, shared]),
            works: workRepo(shared.id),
            assigneeIds: [own.id],
        });
        await expect(svc.runTask('u1', 't1', {}, SCOPE)).resolves.toMatchObject({
            agentId: own.id,
        });
        // ...while the older ambiguity stays exactly as it was.
        const { svc: ambiguous } = build({
            agents: agentRepo([own, shared, pinned]),
            works: workRepo(shared.id),
            assigneeIds: [own.id],
        });
        const error = await ambiguous.runTask('u1', 't1', {}, SCOPE).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
            code: RUN_AGENT_AMBIGUOUS,
        });
    });

    it('a stale or cross-scope default falls back to the Work’s only Agent', async () => {
        const archived = agent('agent-archived', { status: AgentStatus.ARCHIVED });
        const foreign = agent('agent-foreign', { organizationId: OTHER_ORG });
        for (const defaultAgentId of [archived.id, foreign.id, 'agent-deleted']) {
            const { svc } = build({
                agents: agentRepo([archived, foreign, pinned]),
                works: workRepo(defaultAgentId),
            });
            await expect(svc.runTask('u1', 't1', {}, SCOPE)).resolves.toMatchObject({
                agentId: pinned.id,
            });
        }
    });

    it('a default that cannot be read refuses the run instead of starting another Agent', async () => {
        const { svc, transitions } = build({
            agents: agentRepo([pinned]),
            works: workRepo('throws'),
        });
        // The Task itself is read without a scope here, so only the default lookup fails.
        await expect(svc.runTask('u1', 't1', {})).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
    });
});

describe('TasksService.listRunCandidates — with a Work default Agent', () => {
    it('offers the default as a Work default, ahead of the Work-scoped Agents, deduped', async () => {
        const { svc } = build({
            agents: agentRepo([shared, pinned]),
            works: workRepo(shared.id),
        });
        await expect(svc.listRunCandidates('u1', 't1', SCOPE)).resolves.toEqual([
            expect.objectContaining({ id: shared.id, source: 'work-default' }),
            expect.objectContaining({ id: pinned.id, source: 'work-default' }),
        ]);

        const { svc: pinnedDefault } = build({
            agents: agentRepo([pinned]),
            works: workRepo(pinned.id),
        });
        await expect(pinnedDefault.listRunCandidates('u1', 't1', SCOPE)).resolves.toEqual([
            expect.objectContaining({ id: pinned.id, source: 'work-default' }),
        ]);
    });

    it('never offers a default from another organization, and never throws on a failed read', async () => {
        const foreign = agent('agent-foreign', { organizationId: OTHER_ORG });
        const { svc } = build({ agents: agentRepo([foreign]), works: workRepo(foreign.id) });
        await expect(svc.listRunCandidates('u1', 't1', SCOPE)).resolves.toEqual([]);

        const { svc: unreadable } = build({
            agents: agentRepo([pinned]),
            works: workRepo('throws'),
        });
        await expect(unreadable.listRunCandidates('u1', 't1')).resolves.toEqual([
            expect.objectContaining({ id: pinned.id, source: 'work-default' }),
        ]);
    });
});
