import { AgentsService } from '../agents.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
    type Agent,
} from '../../entities/agent.entity';

/**
 * The Agents list carries, per Agent, the caller's ACTIVE recurring Tasks
 * that drive it — read for the whole page at once — so a card without a
 * heartbeat can say "Runs on schedule · next …" or "Runs when assigned"
 * instead of a bare "No heartbeat".
 */
function makeAgent(id: string): Agent {
    return {
        id,
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: id,
        slug: id,
        title: null,
        capabilities: null,
        status: AgentStatus.ACTIVE,
        permissions: {},
        targets: null,
        guardrails: null,
        heartbeatCadence: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
    } as unknown as Agent;
}

describe('AgentsService.list — recurring-Task drivers', () => {
    const SCOPE = { tenantId: 't1', organizationId: 'o1' };
    const NEXT = new Date('2026-11-11T03:00:00.000Z');

    function makeService(drivers: jest.Mock) {
        const repo = {
            findByUserIdScoped: jest
                .fn()
                .mockResolvedValue({ rows: [makeAgent('a1'), makeAgent('a2')], total: 2 }),
            findRecurringTaskDrivers: drivers,
        };
        const service = new AgentsService(repo as never, {} as never, {} as never);
        jest.spyOn(
            (service as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        return { service, repo };
    }

    afterEach(() => jest.restoreAllMocks());

    it('attaches the drivers to every row in ONE read for the page', async () => {
        const drivers = jest
            .fn()
            .mockResolvedValue(new Map([['a1', { activeCount: 2, nextRunAt: NEXT }]]));
        const { service } = makeService(drivers);

        const { rows } = await service.list('u1', {}, SCOPE);

        expect(drivers).toHaveBeenCalledTimes(1);
        expect(drivers).toHaveBeenCalledWith('u1', ['a1', 'a2'], SCOPE);
        expect(rows[0].recurringTasks).toEqual({ activeCount: 2, nextRunAt: NEXT });
        // Computed and none: the card says "Runs when assigned".
        expect(rows[1].recurringTasks).toEqual({ activeCount: 0, nextRunAt: null });
    });

    it('a failed read leaves the field absent ("not computed") and never fails the list', async () => {
        const { service } = makeService(jest.fn().mockRejectedValue(new Error('db down')));

        const { rows, total } = await service.list('u1', {}, SCOPE);

        expect(total).toBe(2);
        expect(rows.map((row) => row.recurringTasks)).toEqual([undefined, undefined]);
    });
});
