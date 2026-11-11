import { AgentScope, AgentStatus } from '../../entities/agent.entity';
import { TaskStatus } from '../../entities/task.entity';
import { AppWorkAgentResolverService, isCommittingAgent } from '../app-work-agent-resolver';
import { APP_WORK_AGENT_RESOLVER as REEXPORTED } from '../app-upstream-state.service';
import { APP_WORK_AGENT_RESOLVER } from '../app-work-agent-resolver';

/** APW-08 T25 — the agent-resolution rule (plan §2.8, R-21). */

interface FakeAgent {
    id: string;
    name: string;
    status: AgentStatus;
    scope: AgentScope;
    workId?: string | null;
    assigned?: string[];
    permissions: { canCommitToRepo: boolean };
    tenantId?: string | null;
    organizationId?: string | null;
}

function agent(id: string, over: Partial<FakeAgent> = {}): FakeAgent {
    return {
        id,
        name: id,
        status: AgentStatus.ACTIVE,
        scope: AgentScope.TENANT,
        permissions: { canCommitToRepo: true },
        tenantId: null,
        organizationId: null,
        ...over,
    };
}

function build(agents: FakeAgent[], tasks: Array<{ agentId: string; updatedAt: Date }> = []) {
    const agentRepo = {
        findByIdAndUser: jest.fn(async (id: string) => agents.find((a) => a.id === id) ?? null),
        findByUserIdScoped: jest.fn(async (_userId: string, filter: Record<string, unknown>) => {
            const rows = agents.filter((a) => {
                if (filter.scope && a.scope !== filter.scope) return false;
                if (filter.workId && a.workId !== filter.workId) return false;
                if (
                    filter.assignedWorkId &&
                    !(a.assigned ?? []).includes(String(filter.assignedWorkId))
                )
                    return false;
                return true;
            });
            return { rows, total: rows.length };
        }),
    };
    const taskRepo = {
        findByUserIdFiltered: jest.fn(async () => ({ rows: tasks, total: tasks.length })),
    };
    const service = new AppWorkAgentResolverService(taskRepo as never, agentRepo as never);
    return { service, agentRepo, taskRepo };
}

describe('AppWorkAgentResolverService (APW-08 T25)', () => {
    const input = { userId: 'u1', workId: 'w1' };

    it('is the ONE token — app-upstream-state re-exports the same Symbol (APW08-G18)', () => {
        expect(REEXPORTED).toBe(APP_WORK_AGENT_RESOLVER);
    });

    it('1. prefers the Agent of the most recent in_review/done Task', async () => {
        const { service, taskRepo } = build(
            [
                agent('old'),
                agent('recent'),
                agent('pinned', { scope: AgentScope.WORK, workId: 'w1' }),
            ],
            [
                { agentId: 'old', updatedAt: new Date('2026-10-01') },
                { agentId: 'recent', updatedAt: new Date('2026-10-10') },
            ],
        );
        await expect(service.resolve(input)).resolves.toEqual({
            agentId: 'recent',
            source: 'recent-task',
        });
        expect(taskRepo.findByUserIdFiltered).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                workId: 'w1',
                status: [TaskStatus.IN_REVIEW, TaskStatus.DONE],
            }),
            undefined,
        );
    });

    it('skips an archived or non-committing recent Agent', async () => {
        const { service } = build(
            [
                agent('archived', { status: AgentStatus.ARCHIVED }),
                agent('readonly', { permissions: { canCommitToRepo: false } }),
                agent('pinned', { scope: AgentScope.WORK, workId: 'w1' }),
            ],
            [
                { agentId: 'archived', updatedAt: new Date('2026-10-10') },
                { agentId: 'readonly', updatedAt: new Date('2026-10-09') },
            ],
        );
        await expect(service.resolve(input)).resolves.toEqual({
            agentId: 'pinned',
            source: 'pinned',
        });
    });

    it('2/3. only pinned, then only assigned', async () => {
        const assignedOnly = build([
            agent('a', { scope: AgentScope.TENANT, assigned: ['w1'] }),
            agent('b', { scope: AgentScope.TENANT }),
        ]);
        await expect(assignedOnly.service.resolve(input)).resolves.toEqual({
            agentId: 'a',
            source: 'assigned',
        });
    });

    it('4. the only tenant Agent is the default; two are ambiguous → null', async () => {
        await expect(build([agent('solo')]).service.resolve(input)).resolves.toEqual({
            agentId: 'solo',
            source: 'tenant-default',
        });
        await expect(build([agent('x'), agent('y')]).service.resolve(input)).resolves.toBeNull();
    });

    it('answers null with no Agents, and never throws on a failing read', async () => {
        await expect(build([]).service.resolve(input)).resolves.toBeNull();
        const { service, agentRepo } = build([agent('solo')]);
        agentRepo.findByUserIdScoped.mockRejectedValue(new Error('db down'));
        await expect(service.resolve(input)).resolves.toBeNull();
    });

    it('lists committing candidates for the 409 picker', async () => {
        const { service } = build([
            agent('a'),
            agent('b', { permissions: { canCommitToRepo: false } }),
        ]);
        await expect(service.listCandidates('u1')).resolves.toEqual([{ id: 'a', name: 'a' }]);
    });

    describe('0. the Work default Agent (works.defaultAgentId)', () => {
        const ORG_SCOPE = {
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
        };
        const owned = (id: string, over: Partial<FakeAgent> = {}) =>
            ({ ...agent(id, { ...ORG_SCOPE, ...over }), userId: 'u1' }) as FakeAgent;
        const withWork = (agents: FakeAgent[], defaultAgentId: string | null, tasks = []) => {
            const built = build(agents, tasks);
            const works = {
                findById: jest.fn(async (id: string) => ({ id, ...ORG_SCOPE, defaultAgentId })),
            };
            const service = new AppWorkAgentResolverService(
                built.taskRepo as never,
                built.agentRepo as never,
                works as never,
            );
            return { service, works };
        };

        it('beats the recent-Task heuristic and the tenant default', async () => {
            const { service } = withWork(
                [owned('named'), owned('recent'), owned('other')],
                'named',
                [{ agentId: 'recent', updatedAt: new Date('2026-10-10') }] as never,
            );
            await expect(service.resolve({ ...input, scope: ORG_SCOPE })).resolves.toEqual({
                agentId: 'named',
                source: 'work-default',
            });
        });

        it('is skipped when it may not commit, was archived, or sits in another organization', async () => {
            for (const named of [
                owned('named', { permissions: { canCommitToRepo: false } }),
                owned('named', { status: AgentStatus.ARCHIVED }),
                owned('named', { organizationId: '33333333-3333-4333-8333-333333333333' }),
            ]) {
                const { service } = withWork(
                    [named, owned('pinned', { scope: AgentScope.WORK, workId: 'w1' })],
                    'named',
                );
                await expect(service.resolve({ ...input, scope: ORG_SCOPE })).resolves.toEqual({
                    agentId: 'pinned',
                    source: 'pinned',
                });
            }
        });

        it('a failed Work read is no candidate from that step, as for every step', async () => {
            const { service, works } = withWork([owned('solo')], 'solo');
            works.findById.mockRejectedValue(new Error('db down'));
            await expect(service.resolve({ ...input, scope: ORG_SCOPE })).resolves.toEqual({
                agentId: 'solo',
                source: 'tenant-default',
            });
        });
    });

    it('isCommittingAgent', () => {
        expect(isCommittingAgent(null)).toBe(false);
        expect(isCommittingAgent(agent('a') as never)).toBe(true);
        expect(isCommittingAgent(agent('a', { status: AgentStatus.ARCHIVED }) as never)).toBe(
            false,
        );
    });
});
