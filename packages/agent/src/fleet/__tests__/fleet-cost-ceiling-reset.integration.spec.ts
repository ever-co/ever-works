import { createHash } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetAudit } from '../../entities/fleet-audit.entity';
import { FleetCostPolicy } from '../../entities/fleet-cost-policy.entity';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetNode, type FleetNodeStatus } from '../../entities/fleet-node.entity';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetCostCeilingResetService } from '../fleet-cost-ceiling-reset.service';
import { FleetCostCeilingService } from '../fleet-cost-ceiling.service';
import { FleetCostPolicyRepository } from '../fleet-cost-policy.repository';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetService } from '../fleet.service';

/**
 * The cost ceiling RESETS DAILY (owner, 2026-11-21) — end to end, against
 * a real (better-sqlite3, synchronize) schema.
 *
 * Every piece is the production one: the ceiling trips through
 * `FleetCostCeilingService` → `FleetService.setDisabledForUser`, the rows
 * are written by the real `FleetAuditService` (redaction belt and all), the
 * node beats through the real `FleetService.heartbeat`, and the reset is
 * the real compare-and-set. Only the clock is driven (Date alone is faked;
 * every audit row is stamped with it, one second apart, so the order the
 * reset reads is the order the test wrote) and the claim requeue / Inbox
 * are stubs.
 *
 * What it pins, in the owner's words: trip on day D → still disabled later
 * on D → back on D+1; a person's disable is never undone (alone, after the
 * trip, before it, via drain-all); the per-node ceiling too; two beats
 * re-enable once; and spend already over the ceiling after midnight trips
 * again normally instead of flapping.
 */
describe('fleet cost ceiling — daily reset (better-sqlite3, end to end)', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const SECRET_A = 'sec_'.padEnd(43, 'a');
    const SECRET_B = 'sec_'.padEnd(43, 'b');
    const D = '2026-11-16';
    const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

    let dataSource: DataSource;
    let nodeRows: Repository<FleetNode>;
    let jobRows: Repository<FleetJob>;
    let policyRows: Repository<FleetCostPolicy>;
    let auditRows: Repository<FleetAudit>;
    let nodes: FleetNodeRepository;
    let jobs: FleetJobRepository;
    let policies: FleetCostPolicyRepository;
    let audit: FleetAuditService;
    let reset: FleetCostCeilingResetService;
    let fleet: FleetService;
    let ceiling: FleetCostCeilingService;
    let inbox: { notice: jest.Mock };
    let jobService: { releaseClaimsForNode: jest.Mock };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        nodeRows = dataSource.getRepository(FleetNode);
        jobRows = dataSource.getRepository(FleetJob);
        policyRows = dataSource.getRepository(FleetCostPolicy);
        auditRows = dataSource.getRepository(FleetAudit);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(() => {
        delete process.env.FLEET_NODE_DAILY_COST_CEILING_USD;
        delete process.env.FLEET_DAILY_COST_CEILING_USD;
        // Date alone: the driver and TypeORM still need real timers.
        jest.useFakeTimers({
            doNotFake: [
                'nextTick',
                'setImmediate',
                'clearImmediate',
                'setInterval',
                'clearInterval',
                'setTimeout',
                'clearTimeout',
                'queueMicrotask',
                'hrtime',
                'performance',
            ],
        });
        clock(`${D}T09:00:00.000Z`);
        nodes = new FleetNodeRepository(nodeRows);
        jobs = new FleetJobRepository(jobRows);
        policies = new FleetCostPolicyRepository(policyRows);
        // Every row is stamped with the faked clock, so "newer" in the
        // trail means "written later in this test" — never a same-second
        // tie the driver's `datetime('now')` default would produce.
        const stamped = new Proxy(auditRows, {
            get(target, prop) {
                if (prop === 'create') {
                    return (data: Partial<FleetAudit>) =>
                        target.create({ ...data, occurredAt: new Date() });
                }
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        audit = new FleetAuditService(stamped as never);
        reset = new FleetCostCeilingResetService(nodes, policies, jobs, audit);
        fleet = new FleetService(
            nodes,
            undefined,
            undefined,
            undefined,
            audit,
            undefined,
            undefined,
            reset,
        );
        inbox = { notice: jest.fn(async () => undefined) };
        jobService = { releaseClaimsForNode: jest.fn(async () => 0) };
        ceiling = new FleetCostCeilingService(
            nodes,
            jobs,
            policies,
            fleet,
            jobService as never,
            inbox as never,
            reset,
        );
    });

    afterEach(async () => {
        jest.useRealTimers();
        await jobRows.clear();
        await nodeRows.clear();
        await policyRows.clear();
        await auditRows.clear();
    });

    afterAll(() => {
        delete process.env.FLEET_NODE_DAILY_COST_CEILING_USD;
        delete process.env.FLEET_DAILY_COST_CEILING_USD;
    });

    /** Move the (Date-only) clock, then one more second per later write. */
    function clock(iso: string): void {
        jest.setSystemTime(new Date(iso));
    }

    const seedNode = (secret: string, overrides: Partial<FleetNode> = {}): Promise<FleetNode> =>
        nodeRows.save(
            nodeRows.create({
                userId: OWNER,
                name: `pc-${secret.slice(-1)}`,
                kind: 'desktop-node',
                status: 'online',
                capabilities: [],
                capabilitiesPinned: false,
                enrollmentTokenHash: sha256(secret),
                credentialIssuedAt: new Date(),
                lastHeartbeatAt: new Date(),
                ...overrides,
            }),
        );

    /** A completed job, stamped like the reconciler stamps one, then the evaluation it triggers. */
    async function complete(nodeId: string, costCents: number, completedAt: string) {
        clock(completedAt);
        const job = await jobRows.save(
            jobRows.create({
                userId: OWNER,
                nodeId,
                kind: 'agent-task',
                status: 'done',
                requiredCapabilities: [],
                costCents,
                completedAt: new Date(completedAt),
            }),
        );
        return ceiling.evaluateAfterCompletion({
            userId: OWNER,
            nodeId,
            jobId: job.id,
            costCents,
            now: new Date(completedAt),
        });
    }

    const statusOf = async (id: string): Promise<FleetNodeStatus> =>
        (await nodeRows.findOneByOrFail({ id })).status;

    const resetRows = async (nodeId: string) =>
        (await auditRows.find({ where: { nodeId } })).filter(
            (row) => (row.details as { reset?: string } | null)?.reset === 'daily',
        );

    it('the harness stamps audit rows with the driven clock (else every order below is luck)', async () => {
        const node = await seedNode(SECRET_A);
        clock(`${D}T10:00:00.000Z`);
        await fleet.setDisabledForUser(OWNER, node.id, true);
        const [row] = await auditRows.find({ where: { nodeId: node.id } });
        expect(new Date(row.occurredAt).toISOString()).toBe(`${D}T10:00:00.000Z`);
    });

    describe('fleet-wide ceiling', () => {
        beforeEach(async () => {
            await policies.upsertCeiling(OWNER, 1000);
        });

        it('trip on D → still disabled later on D → back in service on D+1, once, with one system row', async () => {
            const a = await seedNode(SECRET_A);
            const b = await seedNode(SECRET_B);

            const verdict = await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            expect(verdict.fleet.outcome).toBe('crossed');
            expect(await statusOf(a.id)).toBe('disabled');
            expect(await statusOf(b.id)).toBe('disabled');
            expect((await policies.findByUser(OWNER))?.trippedOn).toBe(D);

            // Later the same UTC day: a beat keeps it visible, and disabled.
            clock(`${D}T23:59:30.000Z`);
            const late = await fleet.heartbeat(a.id, SECRET_A, {});
            expect(late?.node.status).toBe('disabled');
            expect(await statusOf(a.id)).toBe('disabled');
            expect(await resetRows(a.id)).toHaveLength(0);

            // First beat after midnight UTC.
            clock('2026-11-17T00:00:30.000Z');
            const next = await fleet.heartbeat(a.id, SECRET_A, {});
            expect(next?.node.status).toBe('online');
            expect(await statusOf(a.id)).toBe('online');
            const rows = await resetRows(a.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                action: 'node.disable',
                actorUserId: null,
                ownerUserId: OWNER,
                nodeId: a.id,
                details: {
                    via: 'cost-ceiling',
                    reason: `daily reset of a cost-ceiling trip from ${D}`,
                    trippedOn: D,
                    before: { status: 'disabled' },
                    after: { status: 'offline' },
                },
            });
            // The fleet trip marker is cleared with it.
            expect((await policies.findByUser(OWNER))?.trippedOn).toBeNull();

            // Further beats change nothing and write nothing.
            clock('2026-11-17T00:01:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await resetRows(a.id)).toHaveLength(1);

            // B never beat; the owner opening the ceiling settings sweeps it.
            clock('2026-11-17T08:00:00.000Z');
            await ceiling.describeForUser(OWNER);
            expect(await statusOf(b.id)).toBe('offline');
            expect(await resetRows(b.id)).toHaveLength(1);
        });

        it('a node a person disabled — and nothing else — is never re-enabled', async () => {
            const a = await seedNode(SECRET_A);
            clock(`${D}T10:00:00.000Z`);
            await fleet.setDisabledForUser(OWNER, a.id, true);

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            await ceiling.describeForUser(OWNER);
            clock('2026-11-20T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});

            expect(await statusOf(a.id)).toBe('disabled');
            expect(await resetRows(a.id)).toHaveLength(0);
        });

        it('ceiling trip, then a person disabled it too: it stays disabled', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            clock(`${D}T16:00:00.000Z`);
            // The owner's own "disable" on the already-disabled node.
            await fleet.setDisabledForUser(OWNER, a.id, true);

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});

            expect(await statusOf(a.id)).toBe('disabled');
            expect(await resetRows(a.id)).toHaveLength(0);
        });

        it('a person disabled it first, then the fleet trip re-drained it: it stays disabled', async () => {
            const a = await seedNode(SECRET_A);
            const b = await seedNode(SECRET_B);
            clock(`${D}T09:00:00.000Z`);
            await fleet.setDisabledForUser(OWNER, a.id, true);
            // B's completion trips the fleet ceiling; the drain covers A too.
            await complete(b.id, 1200, `${D}T15:00:00.000Z`);

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            await fleet.heartbeat(b.id, SECRET_B, {});

            expect(await statusOf(a.id)).toBe('disabled');
            expect(await statusOf(b.id)).toBe('online');
            expect(await resetRows(a.id)).toHaveLength(0);
        });

        it('drain-all pressed after the trip keeps every node down', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            clock(`${D}T16:00:00.000Z`);
            // Exactly the row `FleetPanicService.drainAllForUser` writes —
            // which SKIPS already-disabled nodes, so A has no per-node row.
            await audit.record({
                action: 'drain-all',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                details: { drainedNodes: 0, skippedNodes: 1, nodeIds: [] },
            });

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('disabled');
        });

        it('a paused node the ceiling disabled comes back PAUSED — the pause was not the ceiling’s', async () => {
            const a = await seedNode(SECRET_A);
            const b = await seedNode(SECRET_B);
            clock(`${D}T09:00:00.000Z`);
            await fleet.setPausedForUser(OWNER, a.id, true);
            await complete(b.id, 1200, `${D}T15:00:00.000Z`);
            expect(await statusOf(a.id)).toBe('disabled');

            clock('2026-11-17T00:00:30.000Z');
            const beat = await fleet.heartbeat(a.id, SECRET_A, {});
            expect(beat?.node.status).toBe('paused');
            expect(await statusOf(a.id)).toBe('paused');
        });

        it('raising the ceiling after the trip (which clears trippedOn) does not strand the node', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            clock(`${D}T16:00:00.000Z`);
            await ceiling.setFleetCeilingForUser(OWNER, 10_000);
            expect((await policies.findByUser(OWNER))?.trippedOn).toBeNull();
            expect(await statusOf(a.id)).toBe('disabled');

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('online');
        });

        it('two heartbeats racing the rollover re-enable once and audit once', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);

            clock('2026-11-17T00:00:30.000Z');
            const beats = await Promise.all([
                fleet.heartbeat(a.id, SECRET_A, {}),
                fleet.heartbeat(a.id, SECRET_A, {}),
            ]);
            expect(beats.every((beat) => beat !== null)).toBe(true);
            expect(await statusOf(a.id)).toBe('online');
            expect(await resetRows(a.id)).toHaveLength(1);
        });

        it('a beat that read the node BEFORE the reset cannot write its stale `disabled` back', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            // The losing beat's read, taken before the winner's flip — the
            // interleaving `Promise.all` above may or may not produce.
            const staleRead = await nodeRows.findOneByOrFail({ id: a.id });

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('online');

            jest.spyOn(nodes, 'findById').mockResolvedValueOnce(staleRead);
            const loser = await fleet.heartbeat(a.id, SECRET_A, {});
            expect(loser).not.toBeNull();
            expect(await statusOf(a.id)).toBe('online');
            expect(await resetRows(a.id)).toHaveLength(1);
        });

        it('two resets from the SAME stale read: the CAS lets exactly one through', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            const stale = await nodeRows.findOneByOrFail({ id: a.id });

            clock('2026-11-17T00:00:30.000Z');
            const outcomes = await Promise.all([reset.resetIfDue(stale), reset.resetIfDue(stale)]);
            expect(outcomes.filter((outcome) => outcome.reset)).toHaveLength(1);
            expect(outcomes.filter((outcome) => !outcome.reset)).toEqual([
                { reset: false, reason: 'lost-race' },
            ]);
            expect(await resetRows(a.id)).toHaveLength(1);
        });

        it('spend already over right after midnight trips again normally, and the reset waits a day', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            expect(inbox.notice).toHaveBeenCalledTimes(1);

            // A claim still running at midnight completes over the ceiling
            // before the node beats: a NEW day's trip, with its own notice.
            const verdict = await complete(a.id, 1100, '2026-11-17T00:00:10.000Z');
            expect(verdict.fleet.outcome).toBe('crossed');
            expect(inbox.notice).toHaveBeenCalledTimes(2);

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            clock('2026-11-17T18:00:00.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('disabled');
            expect(await resetRows(a.id)).toHaveLength(0);

            clock('2026-11-18T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('online');
            expect(await resetRows(a.id)).toHaveLength(1);
        });

        it('reset at midnight, crossed again that day: drained again and NOT re-enabled the same day', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('online');

            await complete(a.id, 1500, '2026-11-17T09:00:00.000Z');
            expect(await statusOf(a.id)).toBe('disabled');
            expect(inbox.notice).toHaveBeenCalledTimes(2);

            clock('2026-11-17T09:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            clock('2026-11-17T23:59:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('disabled');
            expect(await resetRows(a.id)).toHaveLength(1);

            clock('2026-11-18T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('online');
            expect(await resetRows(a.id)).toHaveLength(2);
        });

        it('holds a node while today’s spend is already over without a new trip, then lets it go once there is room', async () => {
            const a = await seedNode(SECRET_A);
            await complete(a.id, 1200, `${D}T15:00:00.000Z`);
            // Spend recorded after midnight whose evaluation has not run.
            await jobRows.save(
                jobRows.create({
                    userId: OWNER,
                    nodeId: a.id,
                    kind: 'agent-task',
                    status: 'done',
                    requiredCapabilities: [],
                    costCents: 1000,
                    completedAt: new Date('2026-11-17T00:00:05.000Z'),
                }),
            );

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('disabled');

            clock('2026-11-17T08:00:00.000Z');
            await policies.upsertCeiling(OWNER, 5000);
            clock('2026-11-17T08:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('online');
        });
    });

    describe('per-node ceiling', () => {
        it('trips the node on D and hands it back on D+1, clearing its own marker', async () => {
            const a = await seedNode(SECRET_A, { dailyCostCeilingCents: 500 });
            const b = await seedNode(SECRET_B);

            const verdict = await complete(a.id, 600, `${D}T15:00:00.000Z`);
            expect(verdict.node.outcome).toBe('crossed');
            expect(verdict.fleet.outcome).toBe('none');
            expect(await statusOf(a.id)).toBe('disabled');
            expect(await statusOf(b.id)).toBe('online');
            expect((await nodeRows.findOneByOrFail({ id: a.id })).dailyCostTrippedOn).toBe(D);

            clock(`${D}T20:00:00.000Z`);
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('disabled');

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            const row = await nodeRows.findOneByOrFail({ id: a.id });
            expect(row.status).toBe('online');
            expect(row.dailyCostTrippedOn).toBeNull();
            expect(await resetRows(a.id)).toHaveLength(1);
        });

        it('a person’s disable after a per-node trip is kept', async () => {
            const a = await seedNode(SECRET_A, { dailyCostCeilingCents: 500 });
            await complete(a.id, 600, `${D}T15:00:00.000Z`);
            clock(`${D}T16:00:00.000Z`);
            await fleet.setDisabledForUser(OWNER, a.id, true);

            clock('2026-11-17T00:00:30.000Z');
            await fleet.heartbeat(a.id, SECRET_A, {});
            expect(await statusOf(a.id)).toBe('disabled');
        });
    });
});
