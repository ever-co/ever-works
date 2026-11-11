import {
    ownershipRelationScopeOf,
    ownershipScopeMatches,
    type OwnershipScope,
} from '../database/ownership-scope';
import { AgentStatus, type Agent } from '../entities/agent.entity';
import type { Work } from '../entities/work.entity';

/**
 * A Work's default Agent (`works.defaultAgentId`) — the Agent that runs the Work's new Tasks
 * when nobody names one.
 *
 * ONE rule for the write (`PATCH /api/works/:id`, `WorkLifecycleService.updateWork`) and for
 * every read that resolves "the Work's Agent" (`TasksService` Run + Mission Task output, the
 * Goal router's first iteration, `AppWorkAgentResolverService`), so a default that may be
 * stored is exactly a default that may run, and one that stopped qualifying (archived,
 * deleted, moved to another scope, the Work moved) is skipped rather than obeyed: the caller
 * then applies the rule it had before the column existed.
 */

/** The one read the rule needs — `AgentRepository.findByIdAndUser`. */
export interface WorkDefaultAgentLookup {
    findByIdAndUser(
        id: string,
        userId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<Agent | null>;
}

/**
 * The Work columns the rule reads. `userId` (the Work's owner) is optional only so a caller
 * holding a projection without it still compiles; every production caller passes the row.
 */
export type WorkDefaultAgentScopeHolder = Pick<Work, 'tenantId' | 'organizationId'> & {
    userId?: string | null;
};
export type WorkDefaultAgentHolder = WorkDefaultAgentScopeHolder & Pick<Work, 'defaultAgentId'>;

/**
 * `403` code when someone other than the Work's owner tries to change its default Agent: a
 * shared Work has ONE default, and it decides what the owner's Missions, Run and Goals start.
 */
export const WORK_DEFAULT_AGENT_OWNER_ONLY = 'workDefaultAgentOwnerOnly';

/**
 * The Agent `agentId` names when `userId` may use it as `work`'s default: owned by `userId`
 * (and by the Work's owner, when the row says who that is), not archived, inside the Work's own
 * tenant/organization scope AND inside the caller's request scope when one is given. `null`
 * otherwise — a single answer for an id that does not exist, belongs to someone else, sits in
 * another scope or was archived, so neither the write nor a read can tell those apart (no
 * existence leak).
 *
 * The Work's scope is `ownershipRelationScopeOf(work)`. A Work with no tenant or organization
 * recorded (`null`/`null`, written before ownership stamping) admits only a PERSONAL Agent —
 * one with no organization — whatever the request scope, and also on a scope-less background
 * read: an unstamped Work must never run an organization's Agent (review of #3159).
 */
export async function usableWorkDefaultAgent(
    agents: WorkDefaultAgentLookup,
    agentId: string,
    work: WorkDefaultAgentScopeHolder,
    userId: string,
    ownershipScope?: OwnershipScope,
): Promise<Agent | null> {
    if (!agentId || !userId) return null;
    if (work.userId && work.userId !== userId) return null;
    const workScope = ownershipRelationScopeOf(work);
    const agent = await agents.findByIdAndUser(agentId, userId, workScope ?? ownershipScope);
    if (!agent || agent.status === AgentStatus.ARCHIVED) return null;
    // Re-checked in memory even though the query was owner- and scope-bound: the query used ONE
    // of the two scopes, and the rule needs both.
    if (agent.userId !== userId) return null;
    if (workScope) {
        if (!ownershipScopeMatches(agent, workScope)) return null;
    } else if ((agent.organizationId ?? null) !== null) {
        return null;
    }
    if (!ownershipScopeMatches(agent, ownershipScope)) return null;
    return agent;
}

/**
 * The Work's default Agent for `userId` in `ownershipScope`, or `null` when the Work names none
 * or the one it names no longer qualifies ({@link usableWorkDefaultAgent}). A failed read is
 * NOT turned into `null` here — each caller decides whether a read it could not make may fall
 * back to its older rule.
 */
export async function resolveWorkDefaultAgent(
    agents: WorkDefaultAgentLookup,
    work: WorkDefaultAgentHolder,
    userId: string,
    ownershipScope?: OwnershipScope,
): Promise<Agent | null> {
    const agentId = work.defaultAgentId;
    if (!agentId) return null;
    return usableWorkDefaultAgent(agents, agentId, work, userId, ownershipScope);
}
