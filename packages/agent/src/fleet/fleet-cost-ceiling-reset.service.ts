import { Injectable, Logger, Optional } from '@nestjs/common';
import { FLEET_AUDIT_MAX_LIMIT, type FleetAuditView } from '@ever-works/contracts';
import type { FleetNode } from '../entities/fleet-node.entity';
import { FleetAuditService } from './fleet-audit.service';
import {
    resolveFleetDailyCeilingCents,
    resolveNodeDailyCeilingCents,
    utcDay,
    utcDayStart,
} from './fleet-cost-ceiling.shared';
import { FleetCostPolicyRepository } from './fleet-cost-policy.repository';
import { FleetJobRepository } from './fleet-job.repository';
import { FleetNodeRepository } from './fleet-node.repository';

/** The `via` the cost-ceiling drain stamps on its `node.disable` rows. */
export const FLEET_COST_CEILING_VIA = 'cost-ceiling';

/** A node the cost ceiling took out of service, and what undoing that means. */
export interface FleetCostCeilingTrip {
    /** UTC day (`YYYY-MM-DD`) of the newest ceiling drain of this disable. */
    trippedOn: string;
    /** When the ceiling disabled the node (the row that took it out of service). */
    disabledAt: Date;
    /**
     * What the reset puts the node back to: `paused` when the ceiling
     * disabled a node someone had paused (the pause is theirs and outlives
     * the ceiling), otherwise `offline` — the same landing a manual
     * re-enable uses, until the next accepted heartbeat proves it alive.
     */
    restoreTo: 'offline' | 'paused';
}

export type FleetCostCeilingOwnership =
    | { owned: true; trip: FleetCostCeilingTrip }
    | {
          owned: false;
          /**
           * `no-ceiling-trip` — no ceiling drain in the window at all;
           * `not-ceiling` — a person (or anything else) wrote the node's
           * status at or after the ceiling's drain, or the ceiling only
           * re-drained a node that was already disabled for another reason;
           * `unreadable` — a status row the walk cannot order or date.
           */
          reason: 'no-ceiling-trip' | 'not-ceiling' | 'unreadable';
      };

export type FleetCostCeilingResetOutcome =
    | { reset: true; status: 'offline' | 'paused'; trippedOn: string }
    | {
          reset: false;
          reason:
              | 'not-disabled'
              | 'no-audit'
              | 'no-ceiling-trip'
              | 'not-ceiling'
              | 'unreadable'
              | 'drained-all'
              | 'tripped-today'
              | 'over-ceiling'
              | 'unevaluable'
              | 'lost-race'
              | 'checked-today';
      };

/** Above this many remembered nodes the negative memo simply starts over. */
const MEMO_MAX_ENTRIES = 10_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Two days: wider than any time-zone offset a driver could misapply. */
const DRAIN_ALL_READ_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Fleet cost accounting — the DAILY RESET of the cost ceilings (owner
 * request 2026-11-21: "make sure it resets daily").
 *
 * The per-node and fleet-wide ceilings (`FleetCostCeilingService`) drain a
 * node by DISABLING it. Before this, nothing ever undid that: a node
 * tripped on the 16th was still disabled on the 20th. A daily ceiling must
 * hand the machine back when the UTC day it was counting is over — so on
 * the first heartbeat after midnight UTC (and whenever the owner opens the
 * ceiling settings) a node the ceiling ALONE disabled is put back in
 * service, its trip markers are cleared, and one `fleet_audit` row says so.
 *
 * ## Telling the ceiling's disable from a person's — without a migration
 *
 * `disabled` carries no reason column. The reason is read from the node's
 * own `fleet_audit` trail, which every status write already leaves:
 *
 *   - the ceiling's drain writes `node.disable` with `actorUserId: null`,
 *     `details.via: 'cost-ceiling'`, `details.day` and `before` / `after`
 *     statuses (`FleetCostCeilingService.drain`);
 *   - a person's PATCH / hub act writes `node.disable` with THEIR id; a
 *     per-node drain writes `node.drain`; a pause, an unenroll, a rotation
 *     each write their own row with an `after.status`;
 *   - drain-all writes ONE owner-level `drain-all` row (no node id).
 *
 * The node counts as ceiling-only disabled when, among its status rows,
 * the newest ceiling drain that took it OUT of service (its `before` was
 * `online` / `offline` / `paused`) is strictly newer than every other
 * status row, and no `drain-all` was pressed since. Everything else stays
 * disabled. The walk fails CLOSED: no audit writer, an unreadable row, a
 * tie on the timestamp, a window too short to reach the drain — each one
 * leaves the node disabled for a person to re-enable, never the reverse.
 *
 * ## Not while today is already over
 *
 * A trip stamped today is still in force. And a node is not handed back
 * while TODAY's spend is already at or above a ceiling that applies to it
 * (or cannot be summed): it would lease new work into a crossed ceiling.
 * A completion that crosses after midnight trips the node again the
 * normal way (new day, new notice), so the reset never flaps.
 *
 * ## Concurrency
 *
 * The flip is a compare-and-set on `status = 'disabled'`
 * (`FleetNodeRepository.casLiftCostCeilingDisable`), so two heartbeats
 * racing the rollover re-enable once and audit once; the heartbeat no
 * longer writes a sticky status back (see `FleetService.heartbeat`), so a
 * concurrent beat that read the old `disabled` cannot undo it. Residual,
 * stated plainly: a person who disables an ALREADY-disabled node in the
 * milliseconds between this walk and its compare-and-set is not seen.
 *
 * ## Cost
 *
 * A disabled node beats every 30-60 s. A negative structural verdict
 * (not the ceiling's, or tripped today) cannot change before the next UTC
 * day — every row that can still arrive today is either a person's or a
 * trip for today — so it is remembered per node until midnight and the
 * trail is read about once per disabled node per day per replica. The
 * memo can only DELAY a reset, never cause one.
 *
 * A leaf service (no dependency on `FleetService` or
 * `FleetCostCeilingService`) so both can call it without a cycle.
 */
@Injectable()
export class FleetCostCeilingResetService {
    private readonly logger = new Logger(FleetCostCeilingResetService.name);
    /** nodeId → the UTC day a negative structural verdict holds for. */
    private readonly notDueOn = new Map<string, string>();

    constructor(
        private readonly nodes: FleetNodeRepository,
        private readonly policies: FleetCostPolicyRepository,
        private readonly jobs: FleetJobRepository,
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    /**
     * Re-enable `node` iff it is disabled by the cost ceiling ALONE and the
     * day it tripped is over. Never throws; every failure keeps the node
     * disabled.
     */
    async resetIfDue(
        node: Pick<FleetNode, 'id' | 'userId' | 'status' | 'dailyCostCeilingCents'>,
        now: Date = new Date(),
    ): Promise<FleetCostCeilingResetOutcome> {
        if (node.status !== 'disabled') return { reset: false, reason: 'not-disabled' };
        // No audit writer bound ⇒ no trail ⇒ no way to prove the disable is
        // the ceiling's. Fail closed.
        if (!this.audit) return { reset: false, reason: 'no-audit' };
        const today = utcDay(now);
        if (this.notDueOn.get(node.id) === today) return { reset: false, reason: 'checked-today' };

        try {
            const rows = await this.audit.recentForOwnerNode(
                node.userId,
                node.id,
                FLEET_AUDIT_MAX_LIMIT,
            );
            const ownership = findCostCeilingOwnership(rows);
            // `in`, not `!owned`: this package compiles without
            // strictNullChecks, where a negated boolean discriminant does
            // not narrow.
            if ('reason' in ownership) {
                if (ownership.reason !== 'unreadable') this.remember(node.id, today);
                return { reset: false, reason: ownership.reason };
            }
            const { trip } = ownership;
            if (trip.trippedOn >= today) {
                this.remember(node.id, today);
                return { reset: false, reason: 'tripped-today' };
            }
            if (await this.drainAllSince(node.userId, trip.disabledAt)) {
                this.remember(node.id, today);
                return { reset: false, reason: 'drained-all' };
            }
            const spend = await this.todayIsUnderCeilings(node, now);
            if (spend !== 'under') return { reset: false, reason: spend };

            const won = await this.nodes.casLiftCostCeilingDisable(node.id, trip.restoreTo);
            if (!won) return { reset: false, reason: 'lost-race' };
            this.notDueOn.delete(node.id);
            await this.clearStaleMarkers(node, today);
            await this.audit.recordNodeAction({
                action: 'node.disable',
                actorUserId: null,
                ownerUserId: node.userId,
                nodeId: node.id,
                before: { status: 'disabled' },
                after: { status: trip.restoreTo },
                extra: {
                    via: FLEET_COST_CEILING_VIA,
                    reset: 'daily',
                    reason: `daily reset of a cost-ceiling trip from ${trip.trippedOn}`,
                    trippedOn: trip.trippedOn,
                    day: today,
                },
            });
            this.logger.log(
                `Fleet cost ceiling: node ${node.id} back in service (${trip.restoreTo}) — daily reset of a trip from ${trip.trippedOn}`,
            );
            return { reset: true, status: trip.restoreTo, trippedOn: trip.trippedOn };
        } catch (error) {
            this.logger.warn(
                `Fleet cost ceiling: daily reset check failed for node ${node.id}: ${describeError(error)}`,
            );
            return { reset: false, reason: 'unevaluable' };
        }
    }

    /**
     * Sweep every disabled node of one owner (the settings read). Returns
     * how many were put back in service. Never throws.
     */
    async resetDueForUser(userId: string, now: Date = new Date()): Promise<number> {
        let rows: FleetNode[];
        try {
            rows = await this.nodes.findByUser(userId);
        } catch (error) {
            this.logger.warn(
                `Fleet cost ceiling: could not list nodes of user ${userId} for the daily reset: ${describeError(error)}`,
            );
            return 0;
        }
        let reset = 0;
        for (const row of rows) {
            if (row.status !== 'disabled') continue;
            const outcome = await this.resetIfDue(row, now);
            if (outcome.reset) reset += 1;
        }
        return reset;
    }

    /** True when the owner pressed drain-all at or after `since` (ties count). */
    private async drainAllSince(userId: string, since: Date): Promise<boolean> {
        // Read with generous slack below the bound, then compare exactly
        // here, on instants parsed the same way as `since` itself was: a
        // driver that stores whole seconds, or hands a timestamp back in
        // local time, must not hide a drain-all pressed around the drain.
        const rows = await this.audit!.forOwnerActionSince(
            userId,
            'drain-all',
            new Date(since.getTime() - DRAIN_ALL_READ_SLACK_MS),
            FLEET_AUDIT_MAX_LIMIT,
        );
        return rows.some((row) => {
            const at = parseInstant(row.occurredAt);
            return at === null || at >= since.getTime();
        });
    }

    /**
     * `under` when every ceiling that applies to this node has room today;
     * otherwise why not. A sum that cannot be read holds the node, exactly
     * as the ceiling itself fails closed.
     */
    private async todayIsUnderCeilings(
        node: Pick<FleetNode, 'id' | 'userId' | 'dailyCostCeilingCents'>,
        now: Date,
    ): Promise<'under' | 'over-ceiling' | 'unevaluable'> {
        const dayStart = utcDayStart(now);
        const nodeCeiling = resolveNodeDailyCeilingCents(node);
        const fleetCeiling = resolveFleetDailyCeilingCents(
            await this.policies.findByUser(node.userId),
        );
        const checks: Array<[number | null, () => Promise<number>]> = [
            [nodeCeiling, () => this.jobs.sumCostCentsForNodeSince(node.id, dayStart)],
            [fleetCeiling, () => this.jobs.sumCostCentsForUserSince(node.userId, dayStart)],
        ];
        for (const [ceiling, sum] of checks) {
            if (ceiling === null) continue;
            const spent = await sum();
            if (!Number.isFinite(spent)) return 'unevaluable';
            if (spent >= ceiling) return 'over-ceiling';
        }
        return 'under';
    }

    /** Bookkeeping after the flip: never a reason to undo it. */
    private async clearStaleMarkers(node: Pick<FleetNode, 'id' | 'userId'>, today: string) {
        try {
            await this.nodes.clearStaleDailyCostTrip(node.id, today);
            await this.policies.clearStaleTrip(node.userId, today);
        } catch (error) {
            this.logger.warn(
                `Fleet cost ceiling: node ${node.id} was reset but its trip markers could not be cleared: ${describeError(error)}`,
            );
        }
    }

    private remember(nodeId: string, day: string): void {
        if (this.notDueOn.size >= MEMO_MAX_ENTRIES) this.notDueOn.clear();
        this.notDueOn.set(nodeId, day);
    }
}

/**
 * Pure: is this node's CURRENT disable the cost ceiling's alone? `rows`
 * are one node's audit rows (any order, any actions). Exported for the
 * spec — this function is the whole safety argument of the reset.
 */
export function findCostCeilingOwnership(
    rows: readonly FleetAuditView[],
): FleetCostCeilingOwnership {
    const statusRows: Array<{ row: FleetAuditView; at: number; before: string | null }> = [];
    for (const row of rows) {
        // A row that wrote no status (rename, consents, a live view…) says
        // nothing about why the node is disabled.
        if (readStatus(row.details?.after) === null) continue;
        const at = parseInstant(row.occurredAt);
        if (at === null) return { owned: false, reason: 'unreadable' };
        statusRows.push({ row, at, before: readStatus(row.details?.before) });
    }

    let newestOther = Number.NEGATIVE_INFINITY;
    for (const entry of statusRows) {
        if (!isCostCeilingDrain(entry.row)) newestOther = Math.max(newestOther, entry.at);
    }
    // Only drains strictly newer than every other status write can still be
    // in force; a tie is not proof of order, so it is not ownership.
    const chain = statusRows.filter(
        (entry) => isCostCeilingDrain(entry.row) && entry.at > newestOther,
    );
    if (chain.length === 0) {
        return {
            owned: false,
            reason: statusRows.some((entry) => isCostCeilingDrain(entry.row))
                ? 'not-ceiling'
                : 'no-ceiling-trip',
        };
    }
    // The drain that took the node OUT of service: the newest one whose
    // `before` was not already `disabled`. Every later drain re-drained it.
    let start: (typeof chain)[number] | null = null;
    for (const entry of chain) {
        if (entry.before === 'disabled') continue;
        if (start === null || entry.at > start.at) start = entry;
    }
    if (start === null) {
        // Every drain in force found the node already disabled — by someone
        // or something whose row is older than the window. Not ours.
        return { owned: false, reason: 'not-ceiling' };
    }
    if (start.before !== 'online' && start.before !== 'offline' && start.before !== 'paused') {
        return { owned: false, reason: 'not-ceiling' };
    }
    let trippedOn: string | null = null;
    for (const entry of chain) {
        if (entry.at < start.at) continue;
        const day = entry.row.details?.day;
        if (typeof day !== 'string' || !DAY_RE.test(day)) {
            return { owned: false, reason: 'unreadable' };
        }
        if (trippedOn === null || day > trippedOn) trippedOn = day;
    }
    return {
        owned: true,
        trip: {
            trippedOn: trippedOn as string,
            disabledAt: new Date(start.at),
            restoreTo: start.before === 'paused' ? 'paused' : 'offline',
        },
    };
}

/** A `node.disable` the cost ceiling's drain wrote (system actor, `via: cost-ceiling`, → disabled). */
function isCostCeilingDrain(row: FleetAuditView): boolean {
    return (
        row.action === 'node.disable' &&
        row.actorUserId === null &&
        row.details?.via === FLEET_COST_CEILING_VIA &&
        readStatus(row.details?.after) === 'disabled'
    );
}

function readStatus(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const status = (value as Record<string, unknown>).status;
    return typeof status === 'string' ? status : null;
}

function parseInstant(value: string | null | undefined): number | null {
    if (typeof value !== 'string') return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
