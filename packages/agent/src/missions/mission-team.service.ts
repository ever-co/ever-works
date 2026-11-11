import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { MissionWorkRepository } from '../database/repositories/mission-work.repository';
import { findLatestEndedRunsByAgent } from '../database/repositories/latest-agent-run.query';
import {
    recurringTaskDriverIds,
    whereActiveRecurringTemplate,
} from '../database/repositories/recurring-task-drivers';
import { ownershipSqlPredicate, type OwnershipScope } from '../database/ownership-scope';
import { Agent, AgentScope, AgentStatus } from '../entities/agent.entity';
import { AgentMembership } from '../entities/agent-membership.entity';
import { Mission } from '../entities/mission.entity';
import { Task } from '../entities/task.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { RecordAccessPolicy } from '../record-visibility/record-access-policy.service';
import type { RecordAccessContext } from '../record-visibility/record-access.types';
import { MissionsService } from './missions.service';

/** One Agent on the Mission page's "Team and agents" panel. */
export interface MissionTeamAgentView {
    id: string;
    name: string;
    status: string;
    /**
     * Its most recent ENDED run of any kind (Task, fleet, heartbeat, chat):
     * when it finished (ISO) and how. `null` when it never ran to an end.
     */
    latestRun: { status: string; finishedAt: string } | null;
}

/** A Team that holds the Mission as a resource, with its Agent members. */
export interface MissionTeamTeamView {
    id: string;
    name: string;
    slug: string;
    agents: MissionTeamAgentView[];
}

/**
 * How an Agent on no listed Team is tied to the Mission:
 *
 * - `mission` — scoped to the Mission, or assigned to it (`agent_memberships`);
 * - `work` — scoped to one of its attached Works, or assigned to one;
 * - `standing-tasks` — the assigned Agent of an ACTIVE recurring Task on one of
 *   its attached Works (how shared workspace Agents reach a Work).
 */
export type MissionTeamAgentVia = 'mission' | 'work' | 'standing-tasks';

/** An Agent on no listed Team, with what ties it to the Mission. */
export interface MissionTeamOtherAgentView extends MissionTeamAgentView {
    via: MissionTeamAgentVia;
    workId: string | null;
    workName: string | null;
}

/** `GET /api/me/missions/:id/team`. */
export interface MissionTeamView {
    teams: MissionTeamTeamView[];
    agents: MissionTeamOtherAgentView[];
}

/** More than enough for one Mission page; keeps a pathological Team bounded. */
const MAX_AGENTS = 200;

/** Standing Tasks read per Mission; a Mission's Works never carry more. */
const MAX_STANDING_TASKS = 500;

const VIA_ORDER: Record<MissionTeamAgentVia, number> = {
    mission: 0,
    work: 1,
    'standing-tasks': 2,
};

/**
 * Who works on a Mission — the Mission page's "Team and agents" panel, in one
 * read:
 *
 *  - the **Teams** that hold this Mission as a team resource
 *    (`team_resources` type `mission`), each with its **Agent members**;
 *  - the **other Agents** working on it that no listed Team already shows:
 *    Agents scoped or assigned (`agent_memberships`) to this Mission, Agents
 *    scoped or assigned to one of its attached Works (`mission_works`), and
 *    the assigned Agents of ACTIVE recurring Tasks on those Works ("standing
 *    Tasks" — how shared workspace Agents reach a Work).
 *
 * Security:
 *
 *  - the Mission gate is the READ gate of `GET /me/missions/:id`
 *    (`MissionsService.getReadable` with the request scope): the owner, or a
 *    person the Mission's visibility admits; anyone else gets a 404;
 *  - Teams are read only in the Mission's own Organization;
 *  - the attached Works are the owner's `mission_works` edges in the request
 *    scope; a viewer who is not the owner only gets the Works they own or
 *    are a member of (`RecordAccessPolicy` context), so no Work name leaks;
 *  - every Agent goes through `visibleTo(caller)` (the Agents "organization"
 *    tab rule): an Agent the caller could not open elsewhere — another
 *    member's private Agent on a shared Team — is not listed. Without the
 *    access policy (unit tests), only the caller's own Agents are, and only
 *    the owner sees Works.
 *
 * Archived Agents are left out: they do not work on anything.
 */
@Injectable()
export class MissionTeamService {
    constructor(
        private readonly missions: MissionsService,
        @InjectRepository(TeamResource)
        private readonly resources: Repository<TeamResource>,
        @InjectRepository(Team)
        private readonly teams: Repository<Team>,
        @InjectRepository(TeamMember)
        private readonly members: Repository<TeamMember>,
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
        @Optional() private readonly missionWorks?: MissionWorkRepository,
        @Optional() private readonly accessPolicy?: RecordAccessPolicy,
        // The Mission's owner, whose `mission_works` edges the Works come from
        // when a viewer who is not the owner opens a shared Mission. Appended
        // LAST + @Optional() per the positional-spec rule; `Mission` is in the
        // MissionsModule forFeature.
        @Optional()
        @InjectRepository(Mission)
        private readonly missionRows?: Repository<Mission>,
    ) {}

    async getForUser(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<MissionTeamView> {
        // Read gate: throws NotFoundException for a Mission the caller may not
        // read, exactly like `GET /me/missions/:id`.
        const mission = await this.missions.getReadable(userId, missionId, scope);
        const organizationId = mission.organizationId ?? null;
        const context = this.accessPolicy
            ? await this.accessPolicy.contextFor({ kind: 'user', userId }, scope)
            : null;

        const teams = organizationId ? await this.teamsHolding(organizationId, missionId) : [];
        const teamIds = teams.map((team) => team.id);
        const memberships =
            teamIds.length > 0
                ? await this.members.find({
                      where: { teamId: In(teamIds), memberType: 'agent' },
                      order: { createdAt: 'ASC' },
                  })
                : [];

        const workNames = await this.attachedWorks(userId, missionId, scope, context);
        const workIds = [...workNames.keys()];
        const assigned = await this.assignedAgents(missionId, workIds);
        const standing = await this.standingTaskAgents(workIds, scope);

        const agents = await this.readableAgents(userId, scope, context, {
            ids: [
                ...new Set([
                    ...memberships.map((m) => m.memberId),
                    ...assigned.mission,
                    ...assigned.work.keys(),
                    ...standing.keys(),
                ]),
            ],
            missionId,
            workIds,
        });
        const byId = new Map(agents.map((agent) => [agent.id, agent]));
        const latest = await findLatestEndedRunsByAgent(
            this.agents.manager,
            agents.map((agent) => agent.id),
        );
        const view = (agent: Agent): MissionTeamAgentView => {
            const run = latest.get(agent.id);
            return {
                id: agent.id,
                name: agent.name,
                status: agent.status,
                latestRun: run
                    ? { status: run.status, finishedAt: run.finishedAt.toISOString() }
                    : null,
            };
        };

        const listed = new Set<string>();
        const teamViews: MissionTeamTeamView[] = teams.map((team) => {
            const teamAgents: MissionTeamAgentView[] = [];
            for (const membership of memberships) {
                if (membership.teamId !== team.id) continue;
                const agent = byId.get(membership.memberId);
                if (!agent || teamAgents.some((a) => a.id === agent.id)) continue;
                teamAgents.push(view(agent));
                listed.add(agent.id);
            }
            teamAgents.sort((a, b) => a.name.localeCompare(b.name));
            return { id: team.id, name: team.name, slug: team.slug, agents: teamAgents };
        });

        const others: MissionTeamOtherAgentView[] = [];
        for (const agent of agents) {
            if (listed.has(agent.id)) continue;
            const tie = this.tieOf(agent, missionId, workNames, assigned, standing);
            if (!tie) continue;
            others.push({
                ...view(agent),
                via: tie.via,
                workId: tie.workId,
                workName: tie.workId ? (workNames.get(tie.workId) ?? null) : null,
            });
        }
        // Mission first, then Work, then standing Tasks; by Work, then by name.
        others.sort(
            (a, b) =>
                VIA_ORDER[a.via] - VIA_ORDER[b.via] ||
                (a.workName ?? '').localeCompare(b.workName ?? '') ||
                a.name.localeCompare(b.name),
        );

        return { teams: teamViews, agents: others };
    }

    /** The closest tie an Agent has to the Mission, or `null` for none. */
    private tieOf(
        agent: Agent,
        missionId: string,
        workNames: Map<string, string | null>,
        assigned: { mission: Set<string>; work: Map<string, string> },
        standing: Map<string, string>,
    ): { via: MissionTeamAgentVia; workId: string | null } | null {
        if (
            (agent.scope === AgentScope.MISSION && agent.missionId === missionId) ||
            assigned.mission.has(agent.id)
        ) {
            return { via: 'mission', workId: null };
        }
        if (agent.scope === AgentScope.WORK && agent.workId && workNames.has(agent.workId)) {
            return { via: 'work', workId: agent.workId };
        }
        const assignedWork = assigned.work.get(agent.id);
        if (assignedWork) return { via: 'work', workId: assignedWork };
        const standingWork = standing.get(agent.id);
        if (standingWork) return { via: 'standing-tasks', workId: standingWork };
        return null;
    }

    /** Teams of `organizationId` that hold the Mission as a resource, by name. */
    private async teamsHolding(organizationId: string, missionId: string): Promise<Team[]> {
        const rows = await this.resources.find({
            where: { organizationId, resourceType: 'mission', resourceId: missionId },
        });
        if (rows.length === 0) return [];
        return this.teams.find({
            where: { id: In([...new Set(rows.map((row) => row.teamId))]), organizationId },
            order: { name: 'ASC' },
        });
    }

    /**
     * The Mission's attached Works (id → name): the OWNER's `mission_works`
     * edges in the request scope. A viewer who is not the owner keeps only the
     * Works they own or are a member of; without the access policy, only the
     * owner sees any.
     */
    private async attachedWorks(
        userId: string,
        missionId: string,
        scope: OwnershipScope | undefined,
        context: RecordAccessContext | null,
    ): Promise<Map<string, string | null>> {
        const names = new Map<string, string | null>();
        if (!this.missionWorks) return names;
        const ownerId = await this.ownerOf(missionId, userId);
        if (!ownerId) return names;
        const relations = await this.missionWorks.listForMissionWithWork(missionId, ownerId, scope);
        const reachable =
            ownerId === userId ? null : new Set(context ? context.workIds : ([] as string[]));
        for (const relation of relations) {
            if (reachable && !reachable.has(relation.workId)) continue;
            if (!names.has(relation.workId)) names.set(relation.workId, relation.workName);
        }
        return names;
    }

    private async ownerOf(missionId: string, fallback: string): Promise<string | null> {
        if (!this.missionRows) return fallback;
        const row = await this.missionRows.findOne({
            where: { id: missionId },
            select: ['id', 'userId'],
        });
        return row?.userId ?? null;
    }

    /**
     * Agents ASSIGNED (not scoped) through `agent_memberships` — to this
     * Mission, or to one of its attached Works — the same edges the Work
     * header's Agents dropdown reads (`assignedWorkId`). One query.
     */
    private async assignedAgents(
        missionId: string,
        workIds: string[],
    ): Promise<{ mission: Set<string>; work: Map<string, string> }> {
        const out = { mission: new Set<string>(), work: new Map<string, string>() };
        const rows = await this.agents.manager
            .createQueryBuilder(AgentMembership, 'membership')
            .select(['membership.agentId', 'membership.targetType', 'membership.targetId'])
            .where(
                new Brackets((target) => {
                    target.where(
                        '(membership.targetType = :missionTarget AND membership.targetId = :assignedMissionId)',
                        { missionTarget: 'mission', assignedMissionId: missionId },
                    );
                    if (workIds.length > 0) {
                        target.orWhere(
                            '(membership.targetType = :workTarget AND membership.targetId IN (:...assignedWorkIds))',
                            { workTarget: 'work', assignedWorkIds: workIds },
                        );
                    }
                }),
            )
            .orderBy('membership.createdAt', 'ASC')
            .getMany();
        for (const row of rows) {
            if (row.targetType === 'mission') out.mission.add(row.agentId);
            else if (row.targetId && !out.work.has(row.agentId)) {
                out.work.set(row.agentId, row.targetId);
            }
        }
        return out;
    }

    /**
     * Agent id → attached Work, for the assigned Agents of ACTIVE recurring
     * Tasks on the attached Works (assignees, else the Task's own Agent — the
     * dispatcher's rule). This is how a shared workspace Agent (no Work scope,
     * no membership) works on a Work. Bounded, in the request scope.
     */
    private async standingTaskAgents(
        workIds: string[],
        scope: OwnershipScope | undefined,
    ): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        if (workIds.length === 0) return out;
        const qb = this.agents.manager
            .createQueryBuilder(Task, 'task')
            .select(['task.id', 'task.agentId', 'task.workId'])
            .where('task.workId IN (:...standingWorkIds)', { standingWorkIds: workIds });
        whereActiveRecurringTemplate(qb, 'task', new Date());
        const ownership = ownershipSqlPredicate('task', scope, 'standingOwnership');
        if (ownership) qb.andWhere(ownership.clause, ownership.parameters);
        const tasks = await qb
            .orderBy('task.nextOccurrenceAt', 'ASC')
            .take(MAX_STANDING_TASKS)
            .getMany();
        const drivers = await recurringTaskDriverIds(this.agents.manager, tasks);
        for (const task of tasks) {
            if (!task.workId) continue;
            for (const agentId of drivers.get(task.id) ?? []) {
                if (!out.has(agentId)) out.set(agentId, task.workId);
            }
        }
        return out;
    }

    /**
     * The candidate Agents the caller may read — by id (Team members,
     * memberships, standing Tasks), plus the Agents scoped to this Mission or
     * to one of its attached Works — in ONE query, through `visibleTo(caller)`.
     */
    private async readableAgents(
        userId: string,
        scope: OwnershipScope | undefined,
        context: RecordAccessContext | null,
        candidates: { ids: string[]; missionId: string; workIds: string[] },
    ): Promise<Agent[]> {
        const qb = this.agents
            .createQueryBuilder('agent')
            .where('agent.status != :archived', { archived: AgentStatus.ARCHIVED })
            .andWhere(
                new Brackets((any) => {
                    any.where('(agent.scope = :missionScope AND agent.missionId = :missionId)', {
                        missionScope: AgentScope.MISSION,
                        missionId: candidates.missionId,
                    });
                    if (candidates.ids.length > 0) {
                        any.orWhere('agent.id IN (:...candidateAgentIds)', {
                            candidateAgentIds: candidates.ids,
                        });
                    }
                    if (candidates.workIds.length > 0) {
                        any.orWhere(
                            '(agent.scope = :workScope AND agent.workId IN (:...workIds))',
                            {
                                workScope: AgentScope.WORK,
                                workIds: candidates.workIds,
                            },
                        );
                    }
                }),
            );

        if (this.accessPolicy && context) {
            this.accessPolicy.applyVisibleTo(qb, 'agent', 'agent', context, 'organization', 'mtv');
        } else {
            qb.andWhere('agent.userId = :me', { me: userId });
            const ownership = ownershipSqlPredicate('agent', scope, 'mtOwnership');
            if (ownership) qb.andWhere(ownership.clause, ownership.parameters);
        }
        return qb.orderBy('agent.name', 'ASC').take(MAX_AGENTS).getMany();
    }
}
