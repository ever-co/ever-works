import type { FleetAuditView } from '@ever-works/contracts';
import {
    FleetCostCeilingResetService,
    findCostCeilingOwnership,
} from '../fleet-cost-ceiling-reset.service';

/**
 * Fleet cost accounting — the DAILY RESET's decision, unit by unit.
 *
 * `findCostCeilingOwnership` is the whole safety argument of the reset: it
 * decides, from one node's audit trail alone, whether the node's CURRENT
 * disable is the cost ceiling's and nobody else's. Every case where the
 * answer is "no" is a case where a person's stop would otherwise be
 * silently undone at midnight, so most of this file is "no" cases.
 *
 * The end-to-end behaviour (a real trip, a real heartbeat, the real CAS and
 * the real audit rows) is pinned by
 * `fleet-cost-ceiling-reset.integration.spec.ts`.
 */

const OWNER = 'user-1';
const NODE = '11111111-1111-4111-8111-111111111111';

let seq = 0;

/** A row exactly as `FleetCostCeilingService.drain` → `setDisabledForUser` writes it. */
const ceilingDrain = (
    occurredAt: string,
    day: string,
    before: string = 'online',
): FleetAuditView => ({
    id: `row-${++seq}`,
    action: 'node.disable',
    actorUserId: null,
    ownerUserId: OWNER,
    nodeId: NODE,
    details: {
        day,
        nodeCeilingCents: null,
        nodeSpendCents: null,
        nodeOutcome: 'none',
        fleetCeilingCents: 1000,
        fleetSpendCents: 1200,
        fleetOutcome: 'crossed',
        via: 'cost-ceiling',
        before: { status: before },
        after: { status: 'disabled' },
    },
    occurredAt,
});

/** The owner's own PATCH `{ disabled }` (actor = the owner, no `via`). */
const ownerToggle = (occurredAt: string, before: string, after: string): FleetAuditView => ({
    id: `row-${++seq}`,
    action: 'node.disable',
    actorUserId: OWNER,
    ownerUserId: OWNER,
    nodeId: NODE,
    details: { before: { status: before }, after: { status: after } },
    occurredAt,
});

const rename = (occurredAt: string): FleetAuditView => ({
    id: `row-${++seq}`,
    action: 'node.rename',
    actorUserId: OWNER,
    ownerUserId: OWNER,
    nodeId: NODE,
    details: { before: { name: 'a' }, after: { name: 'b' } },
    occurredAt,
});

describe('findCostCeilingOwnership', () => {
    it('owns a node the ceiling took out of service, and reports the trip day', () => {
        const verdict = findCostCeilingOwnership([
            ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
        ]);
        expect(verdict).toEqual({
            owned: true,
            trip: {
                trippedOn: '2026-11-16',
                disabledAt: new Date('2026-11-16T15:00:00.000Z'),
                restoreTo: 'offline',
            },
        });
    });

    it('follows repeat drains of the same disable and dates the trip by the NEWEST of them', () => {
        // A completion after midnight re-drained the already-disabled node:
        // the trip is still in force on the 17th.
        const verdict = findCostCeilingOwnership([
            ceilingDrain('2026-11-17T00:05:00.000Z', '2026-11-17', 'disabled'),
            ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
        ]);
        expect(verdict).toMatchObject({ owned: true, trip: { trippedOn: '2026-11-17' } });
        expect('trip' in verdict && verdict.trip.disabledAt.toISOString()).toBe(
            '2026-11-16T15:00:00.000Z',
        );
    });

    it('is not fooled by row order — it reads the timestamps', () => {
        const rows = [
            ownerToggle('2026-11-16T16:00:00.000Z', 'disabled', 'disabled'),
            ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
        ];
        expect(findCostCeilingOwnership([...rows].reverse())).toEqual(
            findCostCeilingOwnership(rows),
        );
        expect(findCostCeilingOwnership(rows)).toEqual({ owned: false, reason: 'not-ceiling' });
    });

    it('restores a pause the ceiling stacked on — the pause is not the ceiling’s to lift', () => {
        const verdict = findCostCeilingOwnership([
            ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16', 'paused'),
        ]);
        expect(verdict).toMatchObject({ owned: true, trip: { restoreTo: 'paused' } });
    });

    it('ignores rows that wrote no status (a rename, a consent change, a live view)', () => {
        const verdict = findCostCeilingOwnership([
            rename('2026-11-16T18:00:00.000Z'),
            {
                id: 'x',
                action: 'computer.session-open',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                nodeId: NODE,
                details: null,
                occurredAt: '2026-11-16T17:00:00.000Z',
            },
            ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
        ]);
        expect(verdict.owned).toBe(true);
    });

    describe('a person’s stop is never the ceiling’s', () => {
        it('manual disable only — no ceiling row at all', () => {
            expect(
                findCostCeilingOwnership([
                    ownerToggle('2026-11-16T15:00:00.000Z', 'online', 'disabled'),
                ]),
            ).toEqual({ owned: false, reason: 'no-ceiling-trip' });
        });

        it('ceiling trip, THEN a person disabled the (already disabled) node', () => {
            expect(
                findCostCeilingOwnership([
                    ownerToggle('2026-11-16T16:00:00.000Z', 'disabled', 'disabled'),
                    ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
                ]),
            ).toEqual({ owned: false, reason: 'not-ceiling' });
        });

        it('a person disabled it FIRST, then the ceiling re-drained it', () => {
            expect(
                findCostCeilingOwnership([
                    ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16', 'disabled'),
                    ownerToggle('2026-11-16T09:00:00.000Z', 'online', 'disabled'),
                ]),
            ).toEqual({ owned: false, reason: 'not-ceiling' });
        });

        it('the person’s disable fell out of the window: a re-drain alone is not ownership', () => {
            expect(
                findCostCeilingOwnership([
                    ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16', 'disabled'),
                ]),
            ).toEqual({ owned: false, reason: 'not-ceiling' });
        });

        it('a per-node drain or a pause written after the trip', () => {
            const drain: FleetAuditView = {
                id: 'd',
                action: 'node.drain',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                nodeId: NODE,
                details: {
                    before: { status: 'disabled', drained: true },
                    after: { status: 'disabled', drained: true },
                    via: 'node-drain',
                },
                occurredAt: '2026-11-16T16:00:00.000Z',
            };
            expect(
                findCostCeilingOwnership([
                    drain,
                    ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
                ]),
            ).toEqual({ owned: false, reason: 'not-ceiling' });
        });

        it('a tie on the timestamp is not proof of order — fail closed', () => {
            expect(
                findCostCeilingOwnership([
                    ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
                    ownerToggle('2026-11-16T15:00:00.000Z', 'online', 'disabled'),
                ]),
            ).toEqual({ owned: false, reason: 'not-ceiling' });
        });

        it('the reset’s own row closes the episode: it cannot fire twice', () => {
            const resetRow: FleetAuditView = {
                id: 'r',
                action: 'node.disable',
                actorUserId: null,
                ownerUserId: OWNER,
                nodeId: NODE,
                details: {
                    via: 'cost-ceiling',
                    reset: 'daily',
                    before: { status: 'disabled' },
                    after: { status: 'offline' },
                },
                occurredAt: '2026-11-17T00:01:00.000Z',
            };
            expect(
                findCostCeilingOwnership([
                    resetRow,
                    ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
                ]),
            ).toEqual({ owned: false, reason: 'not-ceiling' });
        });

        it('a drain recorded with a person as actor is not the system’s', () => {
            const forged = ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16');
            forged.actorUserId = OWNER;
            expect(findCostCeilingOwnership([forged])).toEqual({
                owned: false,
                reason: 'no-ceiling-trip',
            });
        });
    });

    describe('what it cannot read, it does not own', () => {
        it('a status row with no timestamp', () => {
            const row = ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16');
            row.occurredAt = null;
            expect(findCostCeilingOwnership([row])).toEqual({
                owned: false,
                reason: 'unreadable',
            });
        });

        it('a ceiling drain with no usable day', () => {
            const row = ceilingDrain('2026-11-16T15:00:00.000Z', 'yesterday');
            expect(findCostCeilingOwnership([row])).toEqual({
                owned: false,
                reason: 'unreadable',
            });
        });

        it('a drain whose before-status is not an in-service one', () => {
            expect(
                findCostCeilingOwnership([
                    ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16', 'enrolling'),
                ]),
            ).toEqual({ owned: false, reason: 'not-ceiling' });
        });

        it('an empty trail', () => {
            expect(findCostCeilingOwnership([])).toEqual({
                owned: false,
                reason: 'no-ceiling-trip',
            });
        });
    });
});

describe('FleetCostCeilingResetService', () => {
    const DAY_AFTER = new Date('2026-11-17T00:00:30.000Z');
    let audit: {
        recentForOwnerNode: jest.Mock;
        forOwnerActionSince: jest.Mock;
        recordNodeAction: jest.Mock;
    };
    let nodes: {
        casLiftCostCeilingDisable: jest.Mock;
        clearStaleDailyCostTrip: jest.Mock;
        findByUser: jest.Mock;
    };
    let policies: { findByUser: jest.Mock; clearStaleTrip: jest.Mock };
    let jobs: { sumCostCentsForNodeSince: jest.Mock; sumCostCentsForUserSince: jest.Mock };

    const disabled = {
        id: NODE,
        userId: OWNER,
        status: 'disabled' as const,
        dailyCostCeilingCents: null,
    };
    const build = (withAudit = true) =>
        new FleetCostCeilingResetService(
            nodes as never,
            policies as never,
            jobs as never,
            (withAudit ? audit : undefined) as never,
        );

    beforeEach(() => {
        delete process.env.FLEET_NODE_DAILY_COST_CEILING_USD;
        delete process.env.FLEET_DAILY_COST_CEILING_USD;
        audit = {
            recentForOwnerNode: jest.fn(async () => [
                ceilingDrain('2026-11-16T15:00:00.000Z', '2026-11-16'),
            ]),
            forOwnerActionSince: jest.fn(async () => []),
            recordNodeAction: jest.fn(async () => true),
        };
        nodes = {
            casLiftCostCeilingDisable: jest.fn(async () => true),
            clearStaleDailyCostTrip: jest.fn(async () => undefined),
            findByUser: jest.fn(async () => []),
        };
        policies = {
            findByUser: jest.fn(async () => ({ dailyCeilingCents: 1000 })),
            clearStaleTrip: jest.fn(async () => undefined),
        };
        jobs = {
            sumCostCentsForNodeSince: jest.fn(async () => 0),
            sumCostCentsForUserSince: jest.fn(async () => 0),
        };
    });

    afterAll(() => {
        delete process.env.FLEET_NODE_DAILY_COST_CEILING_USD;
        delete process.env.FLEET_DAILY_COST_CEILING_USD;
    });

    it('resets a ceiling-only disable on the next UTC day: CAS, markers, one system audit row', async () => {
        const outcome = await build().resetIfDue(disabled, DAY_AFTER);

        expect(outcome).toEqual({ reset: true, status: 'offline', trippedOn: '2026-11-16' });
        expect(nodes.casLiftCostCeilingDisable).toHaveBeenCalledWith(NODE, 'offline');
        expect(nodes.clearStaleDailyCostTrip).toHaveBeenCalledWith(NODE, '2026-11-17');
        expect(policies.clearStaleTrip).toHaveBeenCalledWith(OWNER, '2026-11-17');
        expect(audit.recordNodeAction).toHaveBeenCalledTimes(1);
        expect(audit.recordNodeAction).toHaveBeenCalledWith({
            action: 'node.disable',
            actorUserId: null,
            ownerUserId: OWNER,
            nodeId: NODE,
            before: { status: 'disabled' },
            after: { status: 'offline' },
            extra: expect.objectContaining({
                via: 'cost-ceiling',
                reset: 'daily',
                reason: 'daily reset of a cost-ceiling trip from 2026-11-16',
                trippedOn: '2026-11-16',
            }),
        });
    });

    it('does nothing for a node that is not disabled — and reads nothing', async () => {
        const outcome = await build().resetIfDue({ ...disabled, status: 'online' }, DAY_AFTER);
        expect(outcome).toEqual({ reset: false, reason: 'not-disabled' });
        expect(audit.recentForOwnerNode).not.toHaveBeenCalled();
    });

    it('fails closed with no audit writer: there is no trail to prove the reason with', async () => {
        const outcome = await build(false).resetIfDue(disabled, DAY_AFTER);
        expect(outcome).toEqual({ reset: false, reason: 'no-audit' });
        expect(nodes.casLiftCostCeilingDisable).not.toHaveBeenCalled();
    });

    it('waits while the trip day is still today', async () => {
        const outcome = await build().resetIfDue(disabled, new Date('2026-11-16T23:59:59.000Z'));
        expect(outcome).toEqual({ reset: false, reason: 'tripped-today' });
        expect(nodes.casLiftCostCeilingDisable).not.toHaveBeenCalled();
    });

    it('stays disabled when drain-all was pressed since the trip (ties included)', async () => {
        audit.forOwnerActionSince.mockResolvedValue([
            {
                id: 'da',
                action: 'drain-all',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                nodeId: null,
                details: { nodeIds: [] },
                occurredAt: '2026-11-16T15:00:00.000Z',
            },
        ]);
        const outcome = await build().resetIfDue(disabled, DAY_AFTER);
        expect(outcome).toEqual({ reset: false, reason: 'drained-all' });
        expect(nodes.casLiftCostCeilingDisable).not.toHaveBeenCalled();
    });

    it('ignores a drain-all from BEFORE the trip', async () => {
        audit.forOwnerActionSince.mockResolvedValue([
            {
                id: 'da',
                action: 'drain-all',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                nodeId: null,
                details: null,
                occurredAt: '2026-11-16T14:59:59.000Z',
            },
        ]);
        expect((await build().resetIfDue(disabled, DAY_AFTER)).reset).toBe(true);
    });

    it('holds the node while TODAY’s spend is already at the fleet ceiling', async () => {
        jobs.sumCostCentsForUserSince.mockResolvedValue(1000);
        const outcome = await build().resetIfDue(disabled, DAY_AFTER);
        expect(outcome).toEqual({ reset: false, reason: 'over-ceiling' });
        expect(jobs.sumCostCentsForUserSince).toHaveBeenCalledWith(
            OWNER,
            new Date('2026-11-17T00:00:00.000Z'),
        );
        expect(nodes.casLiftCostCeilingDisable).not.toHaveBeenCalled();
    });

    it('holds the node while TODAY’s spend is already at its own ceiling', async () => {
        policies.findByUser.mockResolvedValue(null);
        jobs.sumCostCentsForNodeSince.mockResolvedValue(500);
        const outcome = await build().resetIfDue(
            { ...disabled, dailyCostCeilingCents: 500 },
            DAY_AFTER,
        );
        expect(outcome).toEqual({ reset: false, reason: 'over-ceiling' });
    });

    it('holds the node when today’s spend cannot be read (fail closed, like the ceiling)', async () => {
        jobs.sumCostCentsForUserSince.mockRejectedValue(new Error('db down'));
        const outcome = await build().resetIfDue(disabled, DAY_AFTER);
        expect(outcome).toEqual({ reset: false, reason: 'unevaluable' });

        jobs.sumCostCentsForUserSince.mockResolvedValue(Number.NaN);
        expect(await build().resetIfDue(disabled, DAY_AFTER)).toEqual({
            reset: false,
            reason: 'unevaluable',
        });
        expect(nodes.casLiftCostCeilingDisable).not.toHaveBeenCalled();
    });

    it('re-checks a held node on the next beat (a hold is not remembered)', async () => {
        jobs.sumCostCentsForUserSince.mockResolvedValueOnce(1000).mockResolvedValue(0);
        const service = build();
        expect((await service.resetIfDue(disabled, DAY_AFTER)).reset).toBe(false);
        expect((await service.resetIfDue(disabled, DAY_AFTER)).reset).toBe(true);
    });

    it('writes no audit row when it loses the compare-and-set', async () => {
        nodes.casLiftCostCeilingDisable.mockResolvedValue(false);
        const outcome = await build().resetIfDue(disabled, DAY_AFTER);
        expect(outcome).toEqual({ reset: false, reason: 'lost-race' });
        expect(audit.recordNodeAction).not.toHaveBeenCalled();
        expect(nodes.clearStaleDailyCostTrip).not.toHaveBeenCalled();
    });

    it('reads a person-disabled node’s trail once per UTC day, not on every beat', async () => {
        audit.recentForOwnerNode.mockResolvedValue([
            ownerToggle('2026-11-16T15:00:00.000Z', 'online', 'disabled'),
        ]);
        const service = build();
        await service.resetIfDue(disabled, DAY_AFTER);
        const second = await service.resetIfDue(disabled, new Date('2026-11-17T12:00:00.000Z'));
        expect(second).toEqual({ reset: false, reason: 'checked-today' });
        expect(audit.recentForOwnerNode).toHaveBeenCalledTimes(1);

        await service.resetIfDue(disabled, new Date('2026-11-18T00:00:30.000Z'));
        expect(audit.recentForOwnerNode).toHaveBeenCalledTimes(2);
    });

    it('never throws: a trail read failure keeps the node disabled', async () => {
        audit.recentForOwnerNode.mockRejectedValue(new Error('boom'));
        await expect(build().resetIfDue(disabled, DAY_AFTER)).resolves.toEqual({
            reset: false,
            reason: 'unevaluable',
        });
    });

    it('sweeps only the disabled nodes of an owner', async () => {
        nodes.findByUser.mockResolvedValue([
            { ...disabled },
            { ...disabled, id: '22222222-2222-4222-8222-222222222222', status: 'online' },
        ]);
        expect(await build().resetDueForUser(OWNER, DAY_AFTER)).toBe(1);
        expect(audit.recentForOwnerNode).toHaveBeenCalledTimes(1);
    });
});
