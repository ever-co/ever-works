import type { EntityManager } from 'typeorm';
import { AgentRun, type AgentRunStatus } from '../../entities/agent-run.entity';

/** An Agent's most recent run that has ENDED — what its card calls "Last run". */
export interface LatestEndedAgentRun {
    runId: string;
    /** `completed`, `failed` or `cancelled`. */
    status: AgentRunStatus;
    finishedAt: Date;
}

const ENDED_STATUSES: readonly AgentRunStatus[] = ['completed', 'failed', 'cancelled'];

/** Agents per statement; a list page is far below it. */
const CHUNK = 200;

/**
 * Per Agent, its most recent ENDED run of any kind — a cloud Task run, a fleet
 * run, a heartbeat, a chat reply — read from `agent_runs`, for a whole page of
 * Agents in one statement (per {@link CHUNK} ids).
 *
 * Deliberately not `agents.lastRunAt` / `lastRunStatus`: those mean the
 * HEARTBEAT's last run (the Schedules page and Home's Today read them so), and
 * only the heartbeat claim and release write them.
 *
 * Portable SQL, the same on Postgres and SQLite (the e2e stack): a grouped
 * `MAX(finishedAt)` per Agent, joined back to its row (`DISTINCT ON` is
 * Postgres-only). A run still queued or running is not an ended run, so an
 * Agent working right now shows the run before it; its live state is its
 * status. Two runs that ended in the same instant are rare and equivalent for
 * this purpose; the first returned is kept.
 *
 * Agents with no ended run are absent from the map.
 */
export async function findLatestEndedRunsByAgent(
    manager: EntityManager,
    agentIds: readonly string[],
): Promise<Map<string, LatestEndedAgentRun>> {
    const out = new Map<string, LatestEndedAgentRun>();
    const ids = [...new Set(agentIds)].filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return out;
    const e = (identifier: string) => manager.connection.driver.escape(identifier);

    for (let offset = 0; offset < ids.length; offset += CHUNK) {
        const chunk = ids.slice(offset, offset + CHUNK);
        const rows = await manager
            .createQueryBuilder(AgentRun, 'run')
            .select(['run.id', 'run.agentId', 'run.status', 'run.finishedAt'])
            .innerJoin(
                (latest) =>
                    latest
                        .select('ended.agentId', 'agentId')
                        .addSelect('MAX(ended.finishedAt)', 'finishedAt')
                        .from(AgentRun, 'ended')
                        .where('ended.agentId IN (:...latestRunAgentIds)')
                        .andWhere('ended.status IN (:...latestRunStatuses)')
                        .andWhere('ended.finishedAt IS NOT NULL')
                        .groupBy('ended.agentId'),
                'latest',
                `${e('latest')}.${e('agentId')} = run.agentId AND ${e('latest')}.${e('finishedAt')} = run.finishedAt`,
            )
            .where('run.status IN (:...latestRunStatuses)')
            .setParameters({ latestRunAgentIds: chunk, latestRunStatuses: [...ENDED_STATUSES] })
            .getMany();
        for (const run of rows) {
            if (!run.agentId || !run.finishedAt || out.has(run.agentId)) continue;
            out.set(run.agentId, { runId: run.id, status: run.status, finishedAt: run.finishedAt });
        }
    }
    return out;
}
