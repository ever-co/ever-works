import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import { AgentRun } from '../../entities/agent-run.entity';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import type { FleetAgentReadinessStored } from '@ever-works/contracts';
import { FleetJobRepository } from '../fleet-job.repository';
import { FLEET_NODE_RUN_STATS_MAX_JOBS, FleetJobService } from '../fleet-job.service';
import { sha256Hex } from '../fleet-node-credential';
import { FleetNodeRepository } from '../fleet-node.repository';

/**
 * Fleet agent readiness — what a node's run statistics are read from, against
 * a REAL schema (better-sqlite3, synchronize from the entities, as CI and the
 * e2e stack run) and rows written the way production writes them.
 *
 * The trap this pins (PR #3131 review, item 3): a failed agent run is a job
 * the node COMPLETES — the executor returns `{ status: 'failed' }`, the
 * worker reports success, and `completeJob` settles the row `done`. Reading
 * failures off the job status counted none of them. So the first case writes
 * its row through the real `completeJob`, and the read hands back each job
 * with the run id its payload carries, for the caller to judge by the run
 * (`readNodeRunStats` at the API edge, pinned end to end in
 * `apps/api/src/fleet/__tests__/fleet-node-run-stats.integration.spec.ts`).
 *
 * What only a real database can prove here: the ids come out of the stored
 * JSON document through the driver's own JSON function, the `CASE` binds its
 * instant, a NULL cost reads zero, only terminal `agent-task` jobs of this
 * owner are read, and the cap holds.
 */
describe('fleet node run stats — repository integration (better-sqlite3)', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const STRANGER = '22222222-2222-4222-8222-222222222222';
    const AGENT = '33333333-3333-4333-8333-333333333333';
    const TASK = '44444444-4444-4444-8444-444444444444';
    const SECRET = 'n0d3-s3cr3t-for-tests-AAAAAAAAAAAAAAAAAAAA';
    const NOW = new Date('2026-11-10T12:00:00.000Z');
    const HOUR = 3_600_000;
    const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
    const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

    let dataSource: DataSource;
    let jobRows: Repository<FleetJob>;
    let nodeRows: Repository<FleetNode>;
    let runRows: Repository<AgentRun>;
    let service: FleetJobService;
    let runs: AgentRunRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        jobRows = dataSource.getRepository(FleetJob);
        nodeRows = dataSource.getRepository(FleetNode);
        runRows = dataSource.getRepository(AgentRun);
        service = new FleetJobService(
            new FleetJobRepository(jobRows),
            new FleetNodeRepository(nodeRows),
            undefined as never,
        );
        runs = new AgentRunRepository(runRows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    afterEach(async () => {
        await jobRows.clear();
        await nodeRows.clear();
        await runRows.clear();
    });

    let seededNodes = 0;
    const seedNode = (overrides: Partial<FleetNode> = {}): Promise<FleetNode> =>
        nodeRows.save(
            nodeRows.create({
                userId: OWNER,
                name: 'everdesk3-vm',
                kind: 'node',
                status: 'online',
                // One credential per node (the column is unique).
                enrollmentTokenHash: sha256Hex(`${SECRET}-${(seededNodes += 1)}`),
                capabilities: [],
                capabilitiesPinned: false,
                ...overrides,
            }),
        );

    /** The executor input an agent-task job is enqueued with (the parts that matter here). */
    const agentTaskPayload = (runId: string, taskId: string = TASK) => ({
        taskId,
        runId,
        agentId: AGENT,
        workspace: {
            repositoryId: 'ever-works/ever-works',
            repoUrl: 'https://github.com/ever-works/ever-works.git',
            baseRef: 'develop',
            branch: 'task/t1-fix',
        },
        execution: { provider: 'claude-code', instructions: '# Task\nFix the thing.' },
    });

    const seedJob = (overrides: Partial<FleetJob> = {}): Promise<FleetJob> =>
        jobRows.save(
            jobRows.create({
                userId: OWNER,
                kind: 'agent-task',
                status: 'done',
                requiredCapabilities: [],
                ...overrides,
            }),
        );

    it('a failed agent run is a job the node COMPLETES: `done`, with the failure in its result', async () => {
        const node = await seedNode({ enrollmentTokenHash: sha256Hex(SECRET) });
        const runId = uuid(1);
        // What the lease leaves behind: the job running on this node.
        const running = await seedJob({
            nodeId: node.id,
            status: 'running',
            attempts: 1,
            leaseGeneration: 1,
            startedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + 60_000),
            payload: agentTaskPayload(runId),
        });

        // The node's report for a run the CLI refused: SUCCESS (the node did
        // its work), carrying the executor's own outcome.
        const view = await service.completeJob({
            nodeId: node.id,
            secret: SECRET,
            jobId: running.id,
            success: true,
            leaseGeneration: 1,
            result: {
                status: 'failed',
                gateStatus: 'none',
                failureReason:
                    'claude-code reported an error: Your organization has disabled Claude subscription access for Claude Code',
                model: { provider: 'claude-code', status: 'failed', summary: null },
            },
        });
        expect(view?.status).toBe('done');

        const stored = await jobRows.findOneByOrFail({ id: running.id });
        expect(stored.status).toBe('done');
        expect(stored.error ?? null).toBeNull();
        expect((stored.result as { status?: string } | null)?.status).toBe('failed');

        // The statistics read does not call that a success or a failure: it
        // hands back the job's own verdict AND the run to judge it by.
        await expect(service.agentTaskOutcomesForNode(OWNER, node.id)).resolves.toEqual({
            capped: false,
            outcomes: [
                {
                    jobId: running.id,
                    status: 'done',
                    costCents: 0,
                    recent: true,
                    runId,
                    taskId: TASK,
                },
            ],
        });
    });

    it('reads both windows, newest first, with the spend each job reported', async () => {
        const node = await seedNode();
        const other = await seedNode({ name: 'build-02' });
        const [a, b, c, d] = await Promise.all([
            seedJob({
                nodeId: node.id,
                completedAt: ago(1),
                costCents: 120,
                payload: agentTaskPayload(uuid(1)),
            }),
            seedJob({
                nodeId: node.id,
                status: 'failed',
                completedAt: ago(23),
                costCents: null,
                payload: agentTaskPayload(uuid(2)),
            }),
            // Inside the last 7 days only.
            seedJob({
                nodeId: node.id,
                completedAt: ago(30),
                costCents: 300,
                payload: agentTaskPayload(uuid(3)),
            }),
            seedJob({
                nodeId: node.id,
                status: 'failed',
                completedAt: ago(6 * 24),
                costCents: 10,
                payload: agentTaskPayload(uuid(4)),
            }),
            // Older than 7 days: not read.
            seedJob({ nodeId: node.id, status: 'failed', completedAt: ago(8 * 24), costCents: 99 }),
            // The owner's other node.
            seedJob({ nodeId: other.id, completedAt: ago(3), costCents: 40 }),
        ]);

        const { outcomes, capped } = await service.agentTaskOutcomesForNode(OWNER, node.id, NOW);
        expect(capped).toBe(false);
        expect(outcomes).toEqual([
            {
                jobId: a.id,
                status: 'done',
                costCents: 120,
                recent: true,
                runId: uuid(1),
                taskId: TASK,
            },
            {
                jobId: b.id,
                status: 'failed',
                costCents: 0,
                recent: true,
                runId: uuid(2),
                taskId: TASK,
            },
            {
                jobId: c.id,
                status: 'done',
                costCents: 300,
                recent: false,
                runId: uuid(3),
                taskId: TASK,
            },
            {
                jobId: d.id,
                status: 'failed',
                costCents: 10,
                recent: false,
                runId: uuid(4),
                taskId: TASK,
            },
        ]);
    });

    it('reads only agent-task jobs that reached a terminal status', async () => {
        const node = await seedNode();
        const [, , , , done] = await Promise.all([
            seedJob({ nodeId: node.id, status: 'running', startedAt: ago(1) }),
            seedJob({ nodeId: node.id, status: 'leased' }),
            seedJob({ nodeId: null, targetNodeId: node.id, status: 'queued' }),
            seedJob({
                nodeId: node.id,
                kind: 'acceptance-checks',
                status: 'failed',
                completedAt: ago(1),
            }),
            seedJob({ nodeId: node.id, completedAt: ago(1), costCents: 7 }),
        ]);

        const { outcomes } = await service.agentTaskOutcomesForNode(OWNER, node.id, NOW);
        expect(outcomes.map((outcome) => outcome.jobId)).toEqual([done.id]);
    });

    it('a job with no usable ids reads null for them: a purged body, a legacy step job, a number', async () => {
        const node = await seedNode();
        const [purged, legacy, numeric, runOnly] = await Promise.all([
            // `FleetJobRetentionService` nulls the bodies and keeps the row.
            seedJob({
                nodeId: node.id,
                completedAt: ago(1),
                payload: null,
                bodiesPurgedAt: ago(0.5),
            }),
            seedJob({
                nodeId: node.id,
                completedAt: ago(2),
                payload: { steps: [{ id: 'lint', command: 'pnpm lint' }] },
            }),
            seedJob({
                nodeId: node.id,
                completedAt: ago(3),
                payload: { runId: 42, taskId: { nested: true } },
            }),
            seedJob({ nodeId: node.id, completedAt: ago(4), payload: { runId: uuid(9) } }),
        ]);

        const { outcomes } = await service.agentTaskOutcomesForNode(OWNER, node.id, NOW);
        const ids = (jobId: string) => {
            const outcome = outcomes.find((entry) => entry.jobId === jobId);
            return { runId: outcome?.runId, taskId: outcome?.taskId };
        };
        expect(ids(purged.id)).toEqual({ runId: null, taskId: null });
        expect(ids(legacy.id)).toEqual({ runId: null, taskId: null });
        expect(ids(numeric.id)).toEqual({ runId: null, taskId: null });
        expect(ids(runOnly.id)).toEqual({ runId: uuid(9), taskId: null });
    });

    it('is owner-scoped in the query: a stranger asking with my node id reads nothing of mine', async () => {
        const node = await seedNode();
        await seedJob({ nodeId: node.id, status: 'failed', completedAt: ago(1), costCents: 50 });

        await expect(service.agentTaskOutcomesForNode(STRANGER, node.id, NOW)).resolves.toEqual({
            outcomes: [],
            capped: false,
        });
    });

    it('stops at the cap and says so — the newest jobs are the ones kept', async () => {
        const node = await seedNode();
        const total = FLEET_NODE_RUN_STATS_MAX_JOBS + 5;
        const rows = Array.from({ length: total }, (_, index) => ({
            userId: OWNER,
            kind: 'agent-task' as const,
            status: 'done' as const,
            requiredCapabilities: [],
            nodeId: node.id,
            // One second apart, the first row the newest.
            completedAt: new Date(NOW.getTime() - (index + 1) * 1000),
            costCents: 1,
        }));
        for (let offset = 0; offset < rows.length; offset += 50) {
            await jobRows.insert(rows.slice(offset, offset + 50));
        }

        const { outcomes, capped } = await service.agentTaskOutcomesForNode(OWNER, node.id, NOW);
        expect(capped).toBe(true);
        expect(outcomes).toHaveLength(FLEET_NODE_RUN_STATS_MAX_JOBS);

        // Exactly at the cap is not capped.
        const newest = await jobRows.find({ order: { completedAt: 'DESC' }, take: 5 });
        await jobRows.remove(newest);
        await expect(service.agentTaskOutcomesForNode(OWNER, node.id, NOW)).resolves.toMatchObject({
            capped: false,
        });
    });

    it('on Postgres the same two ids come out through json_typeof / ->> (the emitted statement, pinned)', async () => {
        // No Postgres runs in this suite, so the statement cannot be EXECUTED
        // here; what can be pinned is exactly what TypeORM emits for that
        // driver, with the two things that matter: the ids are read only
        // when they are JSON strings, and every column is quoted by TypeORM.
        const postgres = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: [FleetJob],
        });
        await (postgres as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        const emitted: string[] = [];
        const spy = jest
            .spyOn(SelectQueryBuilder.prototype, 'getRawMany')
            .mockImplementation(async function (this: SelectQueryBuilder<FleetJob>) {
                emitted.push(this.getQuery());
                return [];
            });
        try {
            await new FleetJobRepository(
                postgres.getRepository(FleetJob),
            ).findAgentTaskOutcomesForNode(OWNER, uuid(7), ago(7 * 24), ago(24), 10);
        } finally {
            spy.mockRestore();
        }
        expect(emitted).toHaveLength(1);
        const sql = emitted[0];
        for (const name of ['runId', 'taskId']) {
            expect(sql).toContain(
                `CASE WHEN json_typeof(("j"."payload")::json -> '${name}') = 'string' THEN ("j"."payload")::json ->> '${name}' END AS "${name}"`,
            );
        }
        expect(sql).toContain(
            'CASE WHEN "j"."completedAt" >= :recentSince THEN 1 ELSE 0 END AS "recent"',
        );
        expect(sql).toContain('"j"."userId" = :userId AND "j"."nodeId" = :nodeId');
        expect(sql).toContain('ORDER BY "j"."completedAt" DESC LIMIT 10');
        expect(sql).not.toContain('json_extract');
    });

    describe('AgentRunRepository.findStatusesByIds — the status of some runs, nothing else', () => {
        /** A run taken through the same writes the fleet reconciler makes. */
        async function settledRun(userId: string, outcome: 'failed' | 'completed' | 'running') {
            const run = await runs.createQueued({
                agentId: AGENT,
                userId,
                triggerKind: 'task',
                taskId: TASK,
            });
            await runs.markStarted(run.id, null);
            if (outcome === 'failed') {
                await runs.markFailed(run.id, 'claude-code reported an error: Not logged in');
            } else if (outcome === 'completed') {
                await runs.markCompleted(run.id, 'Implemented the change.');
            }
            return run.id;
        }

        it('answers the status of each of my runs, and of nobody else`s', async () => {
            const failed = await settledRun(OWNER, 'failed');
            const completed = await settledRun(OWNER, 'completed');
            const running = await settledRun(OWNER, 'running');
            const theirs = await settledRun(STRANGER, 'failed');

            const statuses = await runs.findStatusesByIds(
                [failed, completed, running, theirs, failed, uuid(404), 'not-a-run-id', ''],
                OWNER,
            );
            expect(Object.fromEntries(statuses)).toEqual({
                [failed]: 'failed',
                [completed]: 'completed',
                [running]: 'running',
            });
            expect((await runs.findStatusesByIds([failed], STRANGER)).size).toBe(0);
            expect((await runs.findStatusesByIds([], OWNER)).size).toBe(0);
        });

        it('reads more ids than one statement carries', async () => {
            const mine = await settledRun(OWNER, 'failed');
            const many = [...Array.from({ length: 1200 }, (_, index) => uuid(index + 1000)), mine];
            const statuses = await runs.findStatusesByIds(many, OWNER);
            expect(Object.fromEntries(statuses)).toEqual({ [mine]: 'failed' });
        });
    });

    it('the stored agent report survives the column round trip', async () => {
        const report: FleetAgentReadinessStored = {
            at: '2026-11-10T12:00:01.000Z',
            checkedAt: '2026-11-10T12:00:00.000Z',
            agents: [
                {
                    provider: 'claude-code',
                    installed: true,
                    version: '2.1.319',
                    signedIn: true,
                    authMethod: 'subscription',
                    account: 'owner@example.com (Acme, max)',
                    status: 'access_denied',
                    reasonCode: 'org_access_disabled',
                    reason: 'The organization has disabled subscription access for this CLI. Use an API key, or ask an admin to enable access.',
                    checkedAt: '2026-11-10T12:00:00.000Z',
                    usage: [
                        {
                            window: 'five_hour',
                            usedPercent: 42.5,
                            resetsAt: '2026-11-10T15:00:00.000Z',
                            windowMinutes: 300,
                        },
                    ],
                    usageObservedAt: '2026-11-10T11:30:00.000Z',
                    lastSuccessAt: '2026-11-08T10:00:00.000Z',
                    lastFailureAt: '2026-11-10T11:00:00.000Z',
                    lastFailureKind: 'access_denied',
                    lastFailureCode: 'org_access_disabled',
                },
            ],
        };
        const node = await seedNode();
        expect((await nodeRows.findOneByOrFail({ id: node.id })).agentReadiness ?? null).toBeNull();

        await nodeRows.update(node.id, { agentReadiness: report });
        expect((await nodeRows.findOneByOrFail({ id: node.id })).agentReadiness).toEqual(report);
    });
});
