import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { MissionWorkRepository } from '../database/repositories/mission-work.repository';
import { ownershipSqlPredicate, type OwnershipScope } from '../database/ownership-scope';
import { Agent, AgentScope, AgentStatus } from '../entities/agent.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { RecordAccessPolicy } from '../record-visibility/record-access-policy.service';
import { MissionsService } from './missions.service';

/** One Agent on the Mission page's "Team and agents" panel. */
export interface MissionTeamAgentView {
    id: string;
    name: string;
    status: string;
    /** When its most recent run began (ISO), or `null` when it never ran. */
    lastRunAt: string | null;
    lastRunStatus: string | null;
}

/** A Team that holds the Mission as a resource, with its Agent members. */
export interface MissionTeamTeamView {
    id: string;
    name: string;
    slug: string;
    agents: MissionTeamAgentView[];
}

/** An Agent on no listed Team: scoped to the Mission, or to one of its attached Works. */
export interface MissionTeamOtherAgentView extends MissionTeamAgentView {
    via: 'mission' | 'work';
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

/**
 * Who works on a Mission — the Mission page's "Team and agents" panel, in one
 * read:
 *
 *  - the **Teams** that hold this Mission as a team resource
 *    (`team_resources` type `mission`), each with its **Agent members**;
 *  - the **other Agents** working on it that no listed Team already shows:
 *    Agents scoped to this Mission, and Agents scoped to one of its attached
 *    Works (`mission_works`).
 *
 * Security, the same posture as the neighbouring `/me/missions/:id/*` reads:
 *
 *  - the Mission gate is the OWNER gate (`MissionsService.getForUser` with the
 *    request scope), so a foreign or out-of-scope Mission is a 404;
 *  - Teams are read only in the Mission's own Organization (a Mission is
 *    attached to Teams of that Organization only), which is the request's
 *    Organization by the gate above;
 *  - attached Works come from the owner-scoped `mission_works` read, so an
 *    out-of-scope Work contributes nothing;
 *  - every Agent goes through `visibleTo(caller)` (the Agents "organization"
 *    tab rule): an Agent the caller could not open elsewhere — another
 *    member's private Agent on a shared Team — is not listed. Without the
 *    access policy (unit tests), only the caller's own Agents are.
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
    ) {}

    async getForUser(
        userId: string,
        missionId: string,
        scope?: OwnershipScope,
    ): Promise<MissionTeamView> {
        // Owner gate: throws NotFoundException for a foreign / missing /
        // out-of-scope Mission, exactly like `GET /me/missions/:id/works`.
        const mission = await this.missions.getForUser(userId, missionId, scope);
        const organizationId = mission.organizationId ?? null;

        const teams = organizationId ? await this.teamsHolding(organizationId, missionId) : [];
        const teamIds = teams.map((team) => team.id);
        const memberships =
            teamIds.length > 0
                ? await this.members.find({
                      where: { teamId: In(teamIds), memberType: 'agent' },
                      order: { createdAt: 'ASC' },
                  })
                : [];

        const relations = this.missionWorks
            ? await this.missionWorks.listForMissionWithWork(missionId, userId, scope)
            : [];
        const workNames = new Map<string, string | null>();
        for (const relation of relations) {
            if (!workNames.has(relation.workId)) workNames.set(relation.workId, relation.workName);
        }

        const agents = await this.readableAgents(userId, scope, {
            ids: [...new Set(memberships.map((m) => m.memberId))],
            missionId,
            workIds: [...workNames.keys()],
        });
        const byId = new Map(agents.map((agent) => [agent.id, agent]));

        const listed = new Set<string>();
        const teamViews: MissionTeamTeamView[] = teams.map((team) => {
            const teamAgents: MissionTeamAgentView[] = [];
            for (const membership of memberships) {
                if (membership.teamId !== team.id) continue;
                const agent = byId.get(membership.memberId);
                if (!agent) continue;
                teamAgents.push(toAgentView(agent));
                listed.add(agent.id);
            }
            teamAgents.sort((a, b) => a.name.localeCompare(b.name));
            return { id: team.id, name: team.name, slug: team.slug, agents: teamAgents };
        });

        const others: MissionTeamOtherAgentView[] = [];
        for (const agent of agents) {
            if (listed.has(agent.id)) continue;
            if (agent.scope === AgentScope.MISSION && agent.missionId === missionId) {
                others.push({
                    ...toAgentView(agent),
                    via: 'mission',
                    workId: null,
                    workName: null,
                });
            } else if (
                agent.scope === AgentScope.WORK &&
                agent.workId &&
                workNames.has(agent.workId)
            ) {
                others.push({
                    ...toAgentView(agent),
                    via: 'work',
                    workId: agent.workId,
                    workName: workNames.get(agent.workId) ?? null,
                });
            }
        }
        // Mission-scoped first, then by Work, then by name: stable for the UI.
        others.sort(
            (a, b) =>
                (a.via === b.via ? 0 : a.via === 'mission' ? -1 : 1) ||
                (a.workName ?? '').localeCompare(b.workName ?? '') ||
                a.name.localeCompare(b.name),
        );

        return { teams: teamViews, agents: others };
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
     * The candidate Agents the caller may read — Team members by id, plus the
     * Agents scoped to this Mission or to one of its attached Works — in ONE
     * query, through `visibleTo(caller)`.
     */
    private async readableAgents(
        userId: string,
        scope: OwnershipScope | undefined,
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
                        any.orWhere('agent.id IN (:...memberAgentIds)', {
                            memberAgentIds: candidates.ids,
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

        if (this.accessPolicy) {
            const context = await this.accessPolicy.contextFor({ kind: 'user', userId }, scope);
            this.accessPolicy.applyVisibleTo(qb, 'agent', 'agent', context, 'organization', 'mtv');
        } else {
            qb.andWhere('agent.userId = :me', { me: userId });
            const ownership = ownershipSqlPredicate('agent', scope, 'mtOwnership');
            if (ownership) qb.andWhere(ownership.clause, ownership.parameters);
        }
        return qb.orderBy('agent.name', 'ASC').take(MAX_AGENTS).getMany();
    }
}

function toAgentView(agent: Agent): MissionTeamAgentView {
    return {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        lastRunAt: agent.lastRunAt ? agent.lastRunAt.toISOString() : null,
        lastRunStatus: agent.lastRunStatus ?? null,
    };
}
