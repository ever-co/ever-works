import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import type { FleetAgentReadinessStored } from '@ever-works/contracts';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetJobService } from '../fleet-job.service';
import { FleetNodeRepository } from '../fleet-node.repository';

/**
 * Fleet agent readiness — what the platform's own run records say about a
 * node, against a REAL schema (better-sqlite3, synchronize from the
 * entities, as CI and the e2e stack run).
 *
 * What only a real database can prove: the grouped `CASE` sums bind their
 * two instants correctly, a NULL cost sums as zero, only `agent-task` jobs
 * that reached a terminal status are counted, and another owner's jobs on a
 * node id that travelled are never read. And that the node's stored report
 * survives the `simple-json` round trip through the new column.
 */
describe('fleet node run stats — repository integration (better-sqlite3)', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const STRANGER = '22222222-2222-4222-8222-222222222222';
    const NOW = new Date('2026-11-10T12:00:00.000Z');
    const HOUR = 3_600_000;
    const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

    let dataSource: DataSource;
    let jobRows: Repository<FleetJob>;
    let nodeRows: Repository<FleetNode>;
    let service: FleetJobService;

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
        service = new FleetJobService(
            new FleetJobRepository(jobRows),
            new FleetNodeRepository(nodeRows),
            undefined as never,
        );
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    afterEach(async () => {
        await jobRows.clear();
        await nodeRows.clear();
    });

    const seedNode = (overrides: Partial<FleetNode> = {}): Promise<FleetNode> =>
        nodeRows.save(
            nodeRows.create({
                userId: OWNER,
                name: 'everdesk3-vm',
                kind: 'node',
                status: 'online',
                capabilities: [],
                capabilitiesPinned: false,
                ...overrides,
            }),
        );

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

    it('counts finished and failed agent-task jobs and their spend, per node, for both windows', async () => {
        const node = await seedNode();
        const other = await seedNode({ name: 'build-02' });
        await Promise.all([
            // Inside the last 24 hours.
            seedJob({ nodeId: node.id, status: 'done', completedAt: ago(1), costCents: 120 }),
            seedJob({ nodeId: node.id, status: 'failed', completedAt: ago(2), costCents: null }),
            seedJob({ nodeId: node.id, status: 'failed', completedAt: ago(23), costCents: 5 }),
            // Inside the last 7 days only.
            seedJob({ nodeId: node.id, status: 'done', completedAt: ago(30), costCents: 300 }),
            seedJob({
                nodeId: node.id,
                status: 'failed',
                completedAt: ago(6 * 24),
                costCents: 10,
            }),
            // Older than 7 days: in neither window.
            seedJob({ nodeId: node.id, status: 'failed', completedAt: ago(8 * 24), costCents: 99 }),
            // The other node of the same owner.
            seedJob({ nodeId: other.id, status: 'done', completedAt: ago(3), costCents: 40 }),
        ]);

        await expect(
            service.runStatsByNodeForUser(OWNER, [node.id, other.id], NOW),
        ).resolves.toEqual({
            [node.id]: {
                last24h: { runs: 3, failed: 2, costCents: 125 },
                last7d: { runs: 5, failed: 3, costCents: 435 },
            },
            [other.id]: {
                last24h: { runs: 1, failed: 0, costCents: 40 },
                last7d: { runs: 1, failed: 0, costCents: 40 },
            },
        });
    });

    it('counts only agent-task jobs that reached a terminal status', async () => {
        const node = await seedNode();
        await Promise.all([
            seedJob({ nodeId: node.id, status: 'running', startedAt: ago(1) }),
            seedJob({ nodeId: node.id, status: 'leased' }),
            seedJob({ nodeId: null, targetNodeId: node.id, status: 'queued' }),
            seedJob({
                nodeId: node.id,
                kind: 'acceptance-checks',
                status: 'failed',
                completedAt: ago(1),
            }),
            seedJob({ nodeId: node.id, status: 'done', completedAt: ago(1), costCents: 7 }),
        ]);

        await expect(service.runStatsByNodeForUser(OWNER, [node.id], NOW)).resolves.toEqual({
            [node.id]: {
                last24h: { runs: 1, failed: 0, costCents: 7 },
                last7d: { runs: 1, failed: 0, costCents: 7 },
            },
        });
    });

    it('a node that ran nothing reads zeros — every requested node gets an entry', async () => {
        const node = await seedNode();
        await expect(service.runStatsByNodeForUser(OWNER, [node.id], NOW)).resolves.toEqual({
            [node.id]: {
                last24h: { runs: 0, failed: 0, costCents: 0 },
                last7d: { runs: 0, failed: 0, costCents: 0 },
            },
        });
        await expect(service.runStatsByNodeForUser(OWNER, [], NOW)).resolves.toEqual({});
    });

    it('is owner-scoped in the query: a stranger asking with my node id reads nothing of mine', async () => {
        const node = await seedNode();
        await seedJob({ nodeId: node.id, status: 'failed', completedAt: ago(1), costCents: 50 });

        await expect(service.runStatsByNodeForUser(STRANGER, [node.id], NOW)).resolves.toEqual({
            [node.id]: {
                last24h: { runs: 0, failed: 0, costCents: 0 },
                last7d: { runs: 0, failed: 0, costCents: 0 },
            },
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
                    reason: 'Your organization has disabled Claude subscription access for Claude Code',
                    checkedAt: '2026-11-10T12:00:00.000Z',
                    usage: [
                        {
                            window: 'five_hour',
                            usedPercent: 42.5,
                            resetsAt: '2026-11-10T15:00:00.000Z',
                        },
                    ],
                    usageObservedAt: '2026-11-10T11:30:00.000Z',
                    lastSuccessAt: '2026-11-08T10:00:00.000Z',
                },
            ],
        };
        const node = await seedNode();
        expect((await nodeRows.findOneByOrFail({ id: node.id })).agentReadiness ?? null).toBeNull();

        await nodeRows.update(node.id, { agentReadiness: report });
        expect((await nodeRows.findOneByOrFail({ id: node.id })).agentReadiness).toEqual(report);
    });
});
