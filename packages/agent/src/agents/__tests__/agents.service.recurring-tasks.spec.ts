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
function makeAgent(id: string, userId = 'u1'): Agent {
    return {
        id,
        userId,
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

describe('AgentsService.list — the card facts (recurring Tasks, latest run)', () => {
    const SCOPE = { tenantId: 't1', organizationId: 'o1' };
    const NEXT = new Date('2026-11-11T03:00:00.000Z');
    const ENDED = new Date('2026-11-10T21:04:00.000Z');

    function makeService(
        drivers: jest.Mock,
        latest: jest.Mock = jest.fn().mockResolvedValue(new Map()),
        agents: Agent[] = [makeAgent('a1'), makeAgent('a2')],
    ) {
        const repo = {
            findByUserIdScoped: jest.fn().mockResolvedValue({ rows: agents, total: agents.length }),
            findRecurringTaskDrivers: drivers,
            findLatestEndedRuns: latest,
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
        // The caller's own Agent, computed and none: the card says "Runs when assigned".
        expect(rows[1].recurringTasks).toEqual({ activeCount: 0, nextRunAt: null });
    });

    it("claims nothing about a teammate's Agent that none of the caller's Tasks drive", async () => {
        const drivers = jest
            .fn()
            .mockResolvedValue(new Map([['mate-driven', { activeCount: 1, nextRunAt: NEXT }]]));
        const { service } = makeService(drivers, undefined, [
            makeAgent('mate-idle', 'u2'),
            makeAgent('mate-driven', 'u2'),
        ]);

        const { rows } = await service.list('u1', { view: 'organization' }, SCOPE);

        // Its owner's Tasks may drive it: absent, so the card says nothing.
        expect(rows[0]).not.toHaveProperty('recurringTasks');
        // Driven by the caller's own Task: that much is known and shown.
        expect(rows[1].recurringTasks).toEqual({ activeCount: 1, nextRunAt: NEXT });
    });

    it("attaches each Agent's latest ENDED run (any kind), null when it never ended one", async () => {
        const latest = jest
            .fn()
            .mockResolvedValue(
                new Map([['a1', { runId: 'r9', status: 'failed', finishedAt: ENDED }]]),
            );
        const { service } = makeService(jest.fn().mockResolvedValue(new Map()), latest);

        const { rows } = await service.list('u1', {}, SCOPE);

        expect(latest).toHaveBeenCalledTimes(1);
        expect(latest).toHaveBeenCalledWith(['a1', 'a2']);
        expect(rows[0].latestRun).toEqual({ status: 'failed', finishedAt: ENDED });
        expect(rows[1].latestRun).toBeNull();
    });

    it('a failed read leaves its field absent ("not computed") and never fails the list', async () => {
        const { service } = makeService(
            jest.fn().mockRejectedValue(new Error('db down')),
            jest.fn().mockRejectedValue(new Error('db down')),
        );

        const { rows, total } = await service.list('u1', {}, SCOPE);

        expect(total).toBe(2);
        for (const row of rows) {
            expect(row).not.toHaveProperty('recurringTasks');
            expect(row).not.toHaveProperty('latestRun');
        }
    });
});
