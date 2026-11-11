import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { DataSource, type Repository } from 'typeorm';
import { AgentRunRepository, ENTITIES } from '@ever-works/agent/database';
import { AgentRun, FleetJob, FleetNode } from '@ever-works/agent/entities';
import { FleetJobRepository, FleetJobService, FleetNodeRepository } from '@ever-works/agent/fleet';
import { buildNodeJobHistory, isFailedNodeHistoryEntry } from '../fleet-node-history';
import { readNodeRunStats } from '../fleet-node-run-stats';

/**
 * A node's run statistics, end to end against a REAL schema (better-sqlite3,
 * synchronized from the entities) with every row written the way production
 * writes it (PR #3131 review, item 3):
 *
 *  - the fleet job goes through the real `FleetJobService.completeJob`, with
 *    the report a node sends for an agent run the CLI refused — `success:
 *    true` and the executor's own `{ status: 'failed' }` as the result. The
 *    job settles `done`;
 *  - the Agent run goes through the real `AgentRunRepository` writes the
 *    fleet reconciler makes (`createQueued` → `markStarted` → `markFailed`).
 *
 * The first version of these figures grouped jobs by their own status and
 * showed "N finished, 0 failed" for exactly this — the outage the feature is
 * for. Nothing here is mocked between the two tables and the numbers.
 */
describe('fleet node run stats — production-shaped rows, real schema', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const STRANGER = '22222222-2222-4222-8222-222222222222';
    const AGENT = '33333333-3333-4333-8333-333333333333';
    const TASK = '44444444-4444-4444-8444-444444444444';
    const SECRET = 'n0d3-s3cr3t-for-tests-AAAAAAAAAAAAAAAAAAAA';
    const sha256Hex = (value: string): string =>
        createHash('sha256').update(value, 'utf8').digest('hex');
    const REFUSED =
        'claude-code reported an error: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

    let dataSource: DataSource;
    let jobRows: Repository<FleetJob>;
    let nodeRows: Repository<FleetNode>;
    let runRows: Repository<AgentRun>;
    let jobs: FleetJobService;
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
        jobs = new FleetJobService(
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

    const seedNode = (): Promise<FleetNode> =>
        nodeRows.save(
            nodeRows.create({
                userId: OWNER,
                name: 'everdesk3-vm',
                kind: 'node',
                status: 'online',
                enrollmentTokenHash: sha256Hex(SECRET),
                capabilities: [],
                capabilitiesPinned: false,
            }),
        );

    /**
     * One agent run dispatched to the node and settled:
     *  - `refused`: the CLI refused it — the node completes the job, the run fails;
     *  - `succeeded`: an ordinary good run;
     *  - `crashed`: the node itself could not do the job, and reports failure.
     */
    async function settle(node: FleetNode, outcome: 'refused' | 'succeeded' | 'crashed') {
        const run = await runs.createQueued({
            agentId: AGENT,
            userId: OWNER,
            triggerKind: 'task',
            taskId: TASK,
        });
        await runs.markStarted(run.id, null);
        // What the lease leaves behind: the job running on this node.
        const job = await jobRows.save(
            jobRows.create({
                userId: OWNER,
                kind: 'agent-task',
                status: 'running',
                requiredCapabilities: [],
                nodeId: node.id,
                attempts: 1,
                leaseGeneration: 1,
                startedAt: new Date(),
                leaseExpiresAt: new Date(Date.now() + 60_000),
                payload: {
                    taskId: TASK,
                    runId: run.id,
                    agentId: AGENT,
                    execution: { provider: 'claude-code', instructions: '# Task\nFix the thing.' },
                },
            }),
        );
        const report =
            outcome === 'crashed'
                ? { success: false, error: 'workspace could not be provisioned' }
                : {
                      success: true,
                      result:
                          outcome === 'refused'
                              ? {
                                    status: 'failed',
                                    gateStatus: 'none',
                                    failureReason: REFUSED,
                                    model: { provider: 'claude-code', status: 'failed' },
                                }
                              : {
                                    status: 'succeeded',
                                    gateStatus: 'green',
                                    model: { provider: 'claude-code', status: 'succeeded' },
                                },
                  };
        const view = await jobs.completeJob({
            nodeId: node.id,
            secret: SECRET,
            jobId: job.id,
            leaseGeneration: 1,
            ...report,
        });
        // The reconciler's write for what that report meant for the run.
        if (outcome === 'succeeded') await runs.markCompleted(run.id, 'Implemented the change.');
        else await runs.markFailed(run.id, outcome === 'refused' ? REFUSED : 'node failure');
        return { jobId: job.id, runId: run.id, jobStatus: view?.status };
    }

    it('every run refused by the CLI: the jobs are all `done`, and the figures say all of them failed', async () => {
        const node = await seedNode();
        const settled = [
            await settle(node, 'refused'),
            await settle(node, 'refused'),
            await settle(node, 'refused'),
        ];
        // The trap, as production stores it: nothing in `fleet_jobs` says failed.
        expect(settled.map((entry) => entry.jobStatus)).toEqual(['done', 'done', 'done']);
        expect(await jobRows.count({ where: { status: 'failed' } })).toBe(0);
        expect(await runRows.count({ where: { status: 'failed' } })).toBe(3);

        await expect(readNodeRunStats({ jobs, runs }, OWNER, node.id)).resolves.toEqual({
            last24h: { runs: 3, failed: 3, costCents: 0 },
            last7d: { runs: 3, failed: 3, costCents: 0 },
        });
    });

    it('a mixed day: good runs, refused runs and a node failure are each counted for what they were', async () => {
        const node = await seedNode();
        await settle(node, 'succeeded');
        await settle(node, 'refused');
        await settle(node, 'succeeded');
        await settle(node, 'crashed');

        const stats = await readNodeRunStats({ jobs, runs }, OWNER, node.id);
        expect(stats).toEqual({
            last24h: { runs: 4, failed: 2, costCents: 0 },
            last7d: { runs: 4, failed: 2, costCents: 0 },
        });

        // And the drawer's failed list, built from the same rows by the
        // history's own functions, names the same number.
        const history = await jobs.historyForNode(OWNER, node.id, 20);
        const runIds = history
            .map((job) => (job.payload as { runId?: string } | null)?.runId)
            .filter((id): id is string => typeof id === 'string');
        const rows = await runs.findByIds(runIds, OWNER);
        const failures = buildNodeJobHistory(
            history,
            new Map(rows.map((run) => [run.id, run])),
        ).filter(isFailedNodeHistoryEntry);
        expect(failures).toHaveLength(stats?.last24h.failed ?? -1);
    });

    it('never reads another account`s run through an id that travelled in a payload', async () => {
        const node = await seedNode();
        const { runId } = await settle(node, 'refused');
        // The run now belongs to someone else: for this owner it is not known,
        // so the job's own status (`done`) is all there is to go on.
        await runRows.update(runId, { userId: STRANGER });

        await expect(readNodeRunStats({ jobs, runs }, OWNER, node.id)).resolves.toEqual({
            last24h: { runs: 1, failed: 0, costCents: 0 },
            last7d: { runs: 1, failed: 0, costCents: 0 },
        });
        await expect(readNodeRunStats({ jobs, runs }, STRANGER, node.id)).resolves.toEqual({
            last24h: { runs: 0, failed: 0, costCents: 0 },
            last7d: { runs: 0, failed: 0, costCents: 0 },
        });
    });

    it('without a run store there is no honest count: no figures at all', async () => {
        const node = await seedNode();
        await settle(node, 'refused');
        await expect(readNodeRunStats({ jobs }, OWNER, node.id)).resolves.toBeNull();
    });
});
