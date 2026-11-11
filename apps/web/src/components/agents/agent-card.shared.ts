/**
 * Pure helpers behind the Agent card's "what drives it" and "last run" lines.
 * Client-safe: no server imports.
 */

import type { Agent } from '@/lib/api/agents';

/**
 * Whether a stored heartbeat cadence means "there is a heartbeat". `manual`
 * is stored in the same column but means "no cron" — the heartbeat dispatcher
 * never fires it (`findDueForHeartbeat`), and Settings saves it as `null`.
 */
export function hasHeartbeatCadence(cadence: string | null | undefined): cadence is string {
    if (typeof cadence !== 'string') return false;
    const trimmed = cadence.trim();
    return trimmed.length > 0 && trimmed.toLowerCase() !== 'manual';
}

/** What runs an Agent, as its card says it. */
export type AgentDrive =
    | { kind: 'heartbeat'; cadence: string }
    /** Driven by active recurring Tasks; `nextRunAt` is the soonest next fire. */
    | { kind: 'schedule'; activeCount: number; nextRunAt: Date | null }
    /** No heartbeat and no active recurring Task: it runs when work is assigned. */
    | { kind: 'assigned' }
    /** No heartbeat, and the response did not say anything about Tasks. */
    | { kind: 'unknown' };

export function agentDriveOf(
    agent: Pick<Agent, 'heartbeatCadence'> & Partial<Pick<Agent, 'recurringTasks'>>,
): AgentDrive {
    if (hasHeartbeatCadence(agent.heartbeatCadence)) {
        return { kind: 'heartbeat', cadence: agent.heartbeatCadence.trim() };
    }
    const recurring = agent.recurringTasks;
    if (!recurring) return { kind: 'unknown' };
    if (recurring.activeCount > 0) {
        const next = recurring.nextRunAt ? new Date(recurring.nextRunAt) : null;
        return {
            kind: 'schedule',
            activeCount: recurring.activeCount,
            nextRunAt: next && !Number.isNaN(next.getTime()) ? next : null,
        };
    }
    return { kind: 'assigned' };
}

/**
 * The `dashboard.agentsPage.card` key for a stored `lastRunStatus`, or `null`
 * for a value with no copy (the caller shows the raw value). The values are
 * the run statuses (`completed`, `failed`, `cancelled`) plus the two the
 * heartbeat release writes on its own (`dispatch-failed`, `recovered-stuck`).
 */
export type AgentLastRunStatusKey =
    | 'lastRunCompleted'
    | 'lastRunFailed'
    | 'lastRunCancelled'
    | 'lastRunDispatchFailed'
    | 'lastRunRecoveredStuck';

export function agentLastRunStatusKey(
    status: string | null | undefined,
): AgentLastRunStatusKey | null {
    switch (status) {
        case 'completed':
            return 'lastRunCompleted';
        case 'failed':
            return 'lastRunFailed';
        case 'cancelled':
            return 'lastRunCancelled';
        case 'dispatch-failed':
            return 'lastRunDispatchFailed';
        case 'recovered-stuck':
            return 'lastRunRecoveredStuck';
        default:
            return null;
    }
}
