import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, type Repository } from 'typeorm';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { AGENT_RUN_TERMINAL_EVENT, type AgentRunTerminalEvent } from '../agent-run-terminal.event';
import { AgentRunRepository, ATTENTION_REASON_QUEUED_TOO_LONG } from './agent-run.repository';

/**
 * Every terminal `agent_runs` write raises the `agent-run.terminal` event —
 * the hook a `queued-too-long` escalation closes itself on — and does NOT
 * touch `agents.lastRunAt` / `lastRunStatus`.
 *
 * Those two columns mean the HEARTBEAT's last run: the Schedules page and
 * Home's Today read them so, and only the heartbeat claim / release write
 * them. A Task run, a fleet run or a chat reply writing them would make a
 * heartbeat look as if it had run. The Agents card's "Last run" comes from
 * `agent_runs` instead (`latest-agent-run.query.integration.spec.ts`).
 */
describe('AgentRunRepository — terminal writes raise the terminal event', () => {
    let dataSource: DataSource;
    let agents: Repository<Agent>;
    let rows: Repository<AgentRun>;
    let events: EventEmitter2;
    let runs: AgentRunRepository;
    let emitted: AgentRunTerminalEvent[];

    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const HEARTBEAT_AT = new Date('2026-11-01T09:00:00.000Z');

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        agents = dataSource.getRepository(Agent);
        rows = dataSource.getRepository(AgentRun);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
        await agents.clear();
        events = new EventEmitter2();
        emitted = [];
        events.on(AGENT_RUN_TERMINAL_EVENT, (event: AgentRunTerminalEvent) => {
            emitted.push(event);
        });
        runs = new AgentRunRepository(rows, undefined, events);
        await agents.save(
            agents.create({
                id: AGENT,
                userId: USER,
                scope: AgentScope.TENANT,
                name: 'Fleet Builder',
                slug: 'fleet-builder',
                status: AgentStatus.ACTIVE,
                permissions: {},
                heartbeatCadence: '0 9 * * *',
                lastRunAt: HEARTBEAT_AT,
                lastRunStatus: 'completed',
                errorCount: 0,
            } as Partial<Agent>),
        );
    });

    async function seedRun(over: Partial<AgentRun>): Promise<AgentRun> {
        return rows.save(
            rows.create({
                agentId: AGENT,
                userId: USER,
                triggerKind: 'task',
                status: 'running',
                startedAt: new Date('2026-11-10T21:00:00.000Z'),
                ...over,
            }),
        );
    }

    it('raises the event for every terminal path, with status, attention and queued reason', async () => {
        const completed = await seedRun({});
        const failed = await seedRun({
            attentionReason: ATTENTION_REASON_QUEUED_TOO_LONG,
            queuedReason: 'concurrency-limit',
        });
        const dispatchFailed = await seedRun({ status: 'queued', startedAt: null });
        const cancelled = await seedRun({});
        const reaped = await seedRun({ status: 'queued', startedAt: null });
        const parked = await seedRun({});

        await runs.markCompleted(completed.id, 'opened PR #12');
        await runs.markFailed(failed.id, 'node reported failure');
        await runs.markDispatchFailed(dispatchFailed.id, 'dispatch-failed: boom');
        await runs.cancel(cancelled.id, USER);
        await runs.markStuckFailed([reaped.id], 'stuck-timeout');
        await runs.parkStaleRunning([parked.id], 'stuck-parked');

        expect(emitted.map((e) => [e.runId, e.status])).toEqual([
            [completed.id, 'completed'],
            [failed.id, 'failed'],
            [dispatchFailed.id, 'failed'],
            [cancelled.id, 'cancelled'],
            [reaped.id, 'failed'],
            [parked.id, 'completed'],
        ]);
        const failedEvent = emitted.find((e) => e.runId === failed.id)!;
        expect(failedEvent).toMatchObject({
            agentId: AGENT,
            attentionReason: ATTENTION_REASON_QUEUED_TOO_LONG,
            queuedReason: 'concurrency-limit',
        });
        expect(failedEvent.finishedAt).toBeInstanceOf(Date);
    });

    it("never writes the Agent's heartbeat columns — a Task run is not a heartbeat", async () => {
        const run = await seedRun({ startedAt: new Date('2026-11-10T21:00:00.000Z') });

        await runs.markFailed(run.id, 'boom');

        const agent = await agents.findOneOrFail({ where: { id: AGENT } });
        expect(agent.lastRunAt?.toISOString()).toBe(HEARTBEAT_AT.toISOString());
        expect(agent.lastRunStatus).toBe('completed');
        expect(agent.errorCount).toBe(0);
    });

    it('raises nothing for a CAS loser: an already-terminal row', async () => {
        const run = await seedRun({ status: 'completed' });
        jest.spyOn(
            (runs as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);

        await runs.markFailed(run.id, 'too late');

        expect(emitted).toEqual([]);
    });

    it('a throwing listener never fails the terminal write', async () => {
        events.on(AGENT_RUN_TERMINAL_EVENT, () => {
            throw new Error('listener down');
        });
        const warn = jest
            .spyOn((runs as never as { logger: { warn: () => void } }).logger, 'warn')
            .mockImplementation(() => undefined);
        const run = await seedRun({});

        await expect(runs.markCompleted(run.id, null)).resolves.toBeUndefined();
        expect((await rows.findOneByOrFail({ id: run.id })).status).toBe('completed');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener down'));
    });

    it('reads nothing when no emitter is bound (unit tests, worker contexts)', async () => {
        const bare = new AgentRunRepository(rows);
        const run = await seedRun({});
        const find = jest.spyOn(rows, 'find');

        await bare.markCompleted(run.id, null);

        expect(find).not.toHaveBeenCalled();
        find.mockRestore();
    });
});
