import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, UpdateQueryBuilder, type Repository } from 'typeorm';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { AGENT_RUN_TERMINAL_EVENT, type AgentRunTerminalEvent } from '../agent-run-terminal.event';
import { AgentRunRepository, ATTENTION_REASON_QUEUED_TOO_LONG } from './agent-run.repository';

/**
 * Every terminal `agent_runs` write stamps the Agent's last run.
 *
 * Before this, `agents.lastRunAt` / `lastRunStatus` were written only by the
 * heartbeat claim, so an Agent driven by recurring Tasks (cloud or fleet) kept
 * "never ran" on its card after a night of runs and PRs. The stamp now hangs
 * off the repository's terminal choke point — the same place the run-cost
 * settlement does — so every path that ends a run (finalize, the fleet
 * reconciler, cancel, a dispatch rollback, the stuck sweeper) stamps it.
 *
 * Pinned against a real database because "monotonic" and "do not touch
 * updatedAt" are claims about the UPDATE statement.
 */
describe('AgentRunRepository — terminal runs stamp the Agent last run', () => {
    let dataSource: DataSource;
    let agents: Repository<Agent>;
    let rows: Repository<AgentRun>;
    let events: EventEmitter2;
    let runs: AgentRunRepository;
    let emitted: AgentRunTerminalEvent[];

    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const UPDATED_AT = new Date('2026-10-01T00:00:00.000Z');

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
                heartbeatCadence: null,
                errorCount: 0,
            } as Partial<Agent>),
        );
        // A known updatedAt, to prove the stamp leaves it alone.
        await dataSource.query(`UPDATE "agents" SET "updatedAt" = ? WHERE "id" = ?`, [
            '2026-10-01 00:00:00.000',
            AGENT,
        ]);
    });

    async function seedRun(over: Partial<AgentRun>): Promise<AgentRun> {
        return rows.save(
            rows.create({
                agentId: AGENT,
                userId: USER,
                triggerKind: 'task',
                status: 'queued',
                ...over,
            }),
        );
    }

    async function agentRow(): Promise<Agent> {
        return agents.findOneOrFail({ where: { id: AGENT } });
    }

    it('a completed Task run sets lastRunAt to when it began and lastRunStatus to how it ended', async () => {
        const startedAt = new Date('2026-11-10T21:00:00.000Z');
        const run = await seedRun({ status: 'running', startedAt });

        await runs.markCompleted(run.id, 'opened PR #12');

        const agent = await agentRow();
        expect(agent.lastRunAt?.toISOString()).toBe(startedAt.toISOString());
        expect(agent.lastRunStatus).toBe('completed');
    });

    it('a failed run (the fleet reconciler path) stamps `failed` and leaves errorCount alone', async () => {
        const run = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
        });

        await runs.markFailed(run.id, 'node reported failure');

        const agent = await agentRow();
        expect(agent.lastRunStatus).toBe('failed');
        // Task-run failures never counted toward pauseAfterFailures, and still do not.
        expect(agent.errorCount).toBe(0);
        expect(agent.status).toBe(AgentStatus.ACTIVE);
    });

    it('does not move updatedAt — the Agents list is ordered by it', async () => {
        const run = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
        });

        await runs.markCompleted(run.id, null);

        expect((await agentRow()).updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());
    });

    it('is monotonic: an older run finishing late never overwrites a newer one', async () => {
        const older = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T20:00:00.000Z'),
        });
        const newer = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
        });

        await runs.markCompleted(newer.id, null);
        await runs.markFailed(older.id, 'late failure');

        const agent = await agentRow();
        expect(agent.lastRunAt?.toISOString()).toBe('2026-11-10T21:00:00.000Z');
        expect(agent.lastRunStatus).toBe('completed');
    });

    it('a run that never started is stamped at the time it was asked for', async () => {
        const createdAt = new Date('2026-11-10T19:00:00.000Z');
        const run = await seedRun({ status: 'queued', createdAt });

        await runs.markDispatchFailed(run.id, 'dispatch-failed: boom');

        const agent = await agentRow();
        expect(agent.lastRunAt?.toISOString()).toBe(createdAt.toISOString());
        expect(agent.lastRunStatus).toBe('failed');
    });

    it('a cancel stamps `cancelled`', async () => {
        const run = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
        });

        await runs.cancel(run.id, USER);

        expect((await agentRow()).lastRunStatus).toBe('cancelled');
    });

    it('the stuck sweeper (bulk) stamps every reaped and parked run', async () => {
        const reaped = await seedRun({
            status: 'queued',
            createdAt: new Date('2026-11-10T10:00:00.000Z'),
        });
        await runs.markStuckFailed([reaped.id], 'stuck-timeout');
        expect((await agentRow()).lastRunStatus).toBe('failed');

        const parked = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T11:00:00.000Z'),
        });
        await runs.parkStaleRunning([parked.id], 'stuck-parked');
        const agent = await agentRow();
        expect(agent.lastRunAt?.toISOString()).toBe('2026-11-10T11:00:00.000Z');
        expect(agent.lastRunStatus).toBe('completed');
    });

    it('leaves the columns to the heartbeat claim while the Agent is `running`', async () => {
        const claimedAt = new Date('2026-11-10T20:00:00.000Z');
        await agents.update(AGENT, {
            status: AgentStatus.RUNNING,
            lastRunAt: claimedAt,
            lastRunStatus: null,
        });
        const run = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T20:30:00.000Z'),
        });

        await runs.markCompleted(run.id, null);

        const agent = await agentRow();
        // The stuck-run recovery reads lastRunAt as the claim time.
        expect(agent.lastRunAt?.toISOString()).toBe(claimedAt.toISOString());
        expect(agent.lastRunStatus).toBeNull();
    });

    it('does nothing for a CAS loser: an already-terminal row is not re-stamped by markFailed', async () => {
        const run = await seedRun({
            status: 'completed',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
        });

        await runs.markFailed(run.id, 'too late');

        const agent = await agentRow();
        expect(agent.lastRunAt).toBeNull();
        expect(emitted).toEqual([]);
    });

    it('raises the terminal event with the run status and its attention flag', async () => {
        const run = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
            attentionReason: ATTENTION_REASON_QUEUED_TOO_LONG,
        });

        await runs.markFailed(run.id, 'boom');

        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            runId: run.id,
            agentId: AGENT,
            status: 'failed',
            attentionReason: ATTENTION_REASON_QUEUED_TOO_LONG,
        });
        expect(emitted[0].finishedAt).toBeInstanceOf(Date);
    });

    it('a throwing listener never fails the terminal write', async () => {
        events.on(AGENT_RUN_TERMINAL_EVENT, () => {
            throw new Error('listener down');
        });
        const warn = jest
            .spyOn((runs as never as { logger: { warn: () => void } }).logger, 'warn')
            .mockImplementation(() => undefined);
        const run = await seedRun({
            status: 'running',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
        });

        await expect(runs.markCompleted(run.id, null)).resolves.toBeUndefined();
        expect((await rows.findOneByOrFail({ id: run.id })).status).toBe('completed');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener down'));
    });
});

describe('AgentRunRepository — the last-run stamp SQL on Postgres', () => {
    it('quotes every identifier, keeps updatedAt and guards on running + monotonic', async () => {
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: ENTITIES,
        });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        const runRepo = dataSource.getRepository(AgentRun);
        const terminal = {
            id: 'r1',
            agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'completed',
            startedAt: new Date('2026-11-10T21:00:00.000Z'),
            createdAt: new Date('2026-11-10T20:59:00.000Z'),
            finishedAt: new Date('2026-11-10T21:10:00.000Z'),
            attentionReason: null,
        } as unknown as AgentRun;
        jest.spyOn(dataSource.manager, 'find').mockResolvedValue([terminal]);
        const captured: string[] = [];
        const execute = jest
            .spyOn(UpdateQueryBuilder.prototype, 'execute')
            .mockImplementation(function (this: UpdateQueryBuilder<unknown>) {
                captured.push(this.getQuery());
                return Promise.resolve({ affected: 1, raw: [], generatedMaps: [] });
            });
        try {
            const repository = new AgentRunRepository(runRepo);
            await (
                repository as unknown as { recordTerminalEffects(ids: string[]): Promise<void> }
            ).recordTerminalEffects(['r1']);
        } finally {
            execute.mockRestore();
        }

        const stamp = captured.find((sql) => sql.includes('UPDATE "agents"'));
        expect(stamp).toBe(
            'UPDATE "agents" SET "lastRunAt" = :orm_param_0, "lastRunStatus" = :orm_param_1, ' +
                '"updatedAt" = "updatedAt" WHERE "id" = :agentId AND "status" != :claimed ' +
                'AND ("lastRunAt" IS NULL OR "lastRunAt" <= :lastRunAt)',
        );
        expect(stamp).not.toContain('CURRENT_TIMESTAMP');
    });
});
