import { emptyFleetNodeRunStats } from '@ever-works/contracts';
import type { FleetJobView, FleetNodeRunStats } from '@ever-works/contracts';
import { correlateAgentTaskJob } from './fleet-agent-task.correlation';
import { isFailedJobOutcome } from './fleet-node-history';

/**
 * A node's run statistics — "N finished, M failed" over the last 24 hours and
 * 7 days, composed at the API edge.
 *
 * ## Why this is not a count by job status
 *
 * A fleet job's status is the NODE's verdict on the job. An agent run that
 * fails — the CLI was signed out, the organization switched access off — is
 * reported by a node that did its work properly: the executor returns
 * `{ status: 'failed' }`, the worker reports success, and the job settles
 * `done`. Counting failures by job status therefore read "12 finished, 0
 * failed" during exactly the outage this figure exists to show (PR #3131
 * review, item 3).
 *
 * The outcome of the work is on the Agent run the job carried, and the node
 * history already has the rule for it (`fleet-node-history.ts`): the run the
 * job correlates to decides; only when no run is known does the job's own
 * status speak. This module applies that same rule, through the same two
 * functions ({@link correlateAgentTaskJob}, {@link isFailedJobOutcome}), so
 * the two figures an owner sees side by side cannot disagree.
 *
 * ## What it refuses to do
 *
 * When jobs carry runs and the runs cannot be read, there is no honest count:
 * {@link readNodeRunStats} answers `null` (the field is then absent) rather
 * than falling back to job statuses, which is the wrong answer described
 * above.
 */

/** One finished `agent-task` job, as `FleetJobService.agentTaskOutcomesForNode` reads it. */
export interface NodeRunOutcome {
    jobId: string;
    /** The job's own terminal status. */
    status: string;
    costCents: number;
    /** True when it finished inside the last 24 hours. */
    recent: boolean;
    /** `payload.runId` / `payload.taskId` as stored; null when absent or purged. */
    runId: string | null;
    taskId: string | null;
}

/** The run a finished job correlates to, by the reconciler's own rule; null when it names none. */
function correlatedRunId(outcome: Pick<NodeRunOutcome, 'runId' | 'taskId'>): string | null {
    const job = {
        kind: 'agent-task',
        payload: { runId: outcome.runId, taskId: outcome.taskId },
    } as unknown as FleetJobView;
    return correlateAgentTaskJob(job)?.runId ?? null;
}

/** The run ids a set of finished jobs correlates to, deduplicated — what to read before counting. */
export function nodeRunStatsRunIds(outcomes: readonly NodeRunOutcome[]): string[] {
    const ids = new Set<string>();
    for (const outcome of outcomes) {
        const runId = correlatedRunId(outcome);
        if (runId) ids.add(runId);
    }
    return [...ids];
}

/**
 * Count finished and failed jobs, and their spend, over both windows. Pure.
 *
 * `runStatuses` maps a run id to its status; a job whose run is not in it is
 * judged by its own status, exactly as a history row with `reconciled: null`.
 */
export function buildNodeRunStats(
    outcomes: readonly NodeRunOutcome[],
    runStatuses: ReadonlyMap<string, string>,
    capped = false,
): FleetNodeRunStats {
    const stats = emptyFleetNodeRunStats();
    for (const outcome of outcomes) {
        const runId = correlatedRunId(outcome);
        const failed = isFailedJobOutcome(
            outcome.status,
            runId ? (runStatuses.get(runId) ?? null) : null,
        );
        const cost = Number.isFinite(outcome.costCents) ? Math.max(0, outcome.costCents) : 0;
        for (const window of outcome.recent ? [stats.last7d, stats.last24h] : [stats.last7d]) {
            window.runs += 1;
            window.costCents += cost;
            if (failed) window.failed += 1;
        }
    }
    if (capped) stats.capped = true;
    return stats;
}

/** What {@link readNodeRunStats} reads from. */
export interface NodeRunStatsSources {
    jobs: {
        agentTaskOutcomesForNode(
            userId: string,
            nodeId: string,
            now?: Date,
        ): Promise<{ outcomes: NodeRunOutcome[]; capped: boolean }>;
    };
    /** The run store; absent on an install without it. */
    runs?: {
        findStatusesByIds(ids: readonly string[], userId: string): Promise<Map<string, string>>;
    } | null;
}

/**
 * One node's run statistics for its owner, or `null` when they cannot be
 * known: its jobs carried runs and there is no run store to read them from.
 * A read that throws is the caller's to handle (the controller degrades to
 * an absent field).
 */
export async function readNodeRunStats(
    sources: NodeRunStatsSources,
    userId: string,
    nodeId: string,
    now: Date = new Date(),
): Promise<FleetNodeRunStats | null> {
    const { outcomes, capped } = await sources.jobs.agentTaskOutcomesForNode(userId, nodeId, now);
    const runIds = nodeRunStatsRunIds(outcomes);
    let runStatuses: Map<string, string> = new Map();
    if (runIds.length > 0) {
        if (!sources.runs) return null;
        runStatuses = await sources.runs.findStatusesByIds(runIds, userId);
    }
    return buildNodeRunStats(outcomes, runStatuses, capped);
}
