import { BadRequestException } from '@nestjs/common';
import { FLEET_MAX_DAILY_COST_CEILING_CENTS } from '@ever-works/contracts';
import { config } from '../config';
import type { FleetCostPolicy } from '../entities/fleet-cost-policy.entity';
import type { FleetNode } from '../entities/fleet-node.entity';

/**
 * Fleet cost accounting (EW-777) — pure helpers shared by `FleetService`
 * (the per-node ceiling), `FleetCostCeilingService` (the fleet-wide one
 * and the evaluation) and `FleetCostCeilingResetService` (the daily
 * reset), kept in a leaf file so the services do not import each other.
 */

/** The per-node ceiling in force: the node's own column, else the deployment default. */
export function resolveNodeDailyCeilingCents(
    node: Pick<FleetNode, 'dailyCostCeilingCents'>,
): number | null {
    return node.dailyCostCeilingCents ?? config.fleet.getDefaultNodeDailyCostCeilingCents();
}

/** The fleet-wide ceiling in force: the owner's policy row, else the deployment default. */
export function resolveFleetDailyCeilingCents(
    policy: Pick<FleetCostPolicy, 'dailyCeilingCents'> | null | undefined,
): number | null {
    return policy?.dailyCeilingCents ?? config.fleet.getDefaultFleetDailyCostCeilingCents();
}

/**
 * Validate a ceiling from the edge: null clears it; otherwise a positive
 * whole number of cents no larger than the contract cap. Refused rather
 * than clamped — a clamped ceiling would be a decision the owner never made.
 */
export function normalizeDailyCeilingCents(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > FLEET_MAX_DAILY_COST_CEILING_CENTS
    ) {
        throw new BadRequestException(
            `Daily cost ceiling must be a whole number of cents between 1 and ${FLEET_MAX_DAILY_COST_CEILING_CENTS}, or null`,
        );
    }
    return value;
}

/** `YYYY-MM-DD` of the UTC day `now` falls in — the ceilings' day key. */
export function utcDay(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/** Midnight UTC of the day `now` falls in — the lower bound of the daily sums. */
export function utcDayStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
