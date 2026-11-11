import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';

// The sibling modules pull the whole agent graph (better-auth's ESM through subscriptions); the
// wiring check below reads only MissionsModule's own metadata, so they stand in as empty classes.
jest.mock('../../work-agent/work-agent.module', () => ({
    WorkAgentModule: class WorkAgentModule {},
}));
jest.mock('../../user-research/user-research.module', () => ({
    UserResearchModule: class UserResearchModule {},
}));
jest.mock('../../facades/facades.module', () => ({ FacadesModule: class FacadesModule {} }));

import { ENTITIES } from '../../database/_entities-inventory';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { AgentMembership } from '../../entities/agent-membership.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { Task, TaskPriority, TaskStatus } from '../../entities/task.entity';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { Team } from '../../entities/team.entity';
import { TeamMember } from '../../entities/team-member.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import { RecordAccessPolicy } from '../../record-visibility/record-access-policy.service';
import { MissionTeamService } from '../mission-team.service';
import { MissionsModule } from '../missions.module';

/**
 * The Mission page's "Team and agents" panel: who works on a Mission, in one
 * read — the Teams that hold it (with their Agents), then the Agents tied to
 * it or to one of its attached Works (scoped, assigned through
 * `agent_memberships`, or driving a standing Task) that no listed Team shows.
 *
 * Run against a real database with the real `RecordAccessPolicy`, because the
 * claim that matters most is a visibility claim: a viewer never sees an Agent
 * (or a Work) here that they could not open elsewhere.
 */
describe('MissionTeamService', () => {
    let dataSource: DataSource;
    let agents: Repository<Agent>;
    let teams: Repository<Team>;
    let members: Repository<TeamMember>;
    let resources: Repository<TeamResource>;
    let missionRows: Repository<Mission>;
    let slugSeq = 0;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    const TEAMMATE = '22222222-2222-4222-8222-222222222222';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const OTHER_ORG = '66666666-6666-4666-8666-666666666666';
    const MISSION = '33333333-3333-4333-8333-333333333333';
    const WORK = '44444444-4444-4444-8444-444444444444';
    const OTHER_WORK = '77777777-7777-4777-8777-777777777777';
    const SCOPE = { tenantId: TENANT, organizationId: ORG };

    let missionsGate: { getReadable: jest.Mock };
    let missionWorks: { listForMissionWithWork: jest.Mock };

    function service(withPolicy = true): MissionTeamService {
        const policy = withPolicy
            ? new RecordAccessPolicy(
                  ...([
                      'OrganizationMember',
                      'Organization',
                      'Tenant',
                      'TeamMember',
                      'Team',
                      'WorkMember',
                      'Work',
                      'TaskAssignee',
                      'TaskApprover',
                      'TaskReviewer',
                      'TaskWatcher',
                      'Task',
                      'Goal',
                      'Mission',
                      'WorkProposal',
                      'Agent',
                  ].map((name) => dataSource.getRepository(name)) as ConstructorParameters<
                      typeof RecordAccessPolicy
                  >),
              )
            : undefined;
        return new MissionTeamService(
            missionsGate as never,
            resources,
            teams,
            members,
            agents,
            missionWorks as never,
            policy,
            missionRows,
        );
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        agents = dataSource.getRepository(Agent);
        teams = dataSource.getRepository(Team);
        members = dataSource.getRepository(TeamMember);
        resources = dataSource.getRepository(TeamResource);
        missionRows = dataSource.getRepository(Mission);
        await missionRows.save(
            missionRows.create({
                id: MISSION,
                userId: OWNER,
                tenantId: TENANT,
                organizationId: ORG,
                title: 'Grow ever.co',
                description: 'More visitors',
                type: MissionType.ONE_SHOT,
                status: MissionStatus.ACTIVE,
            } as Partial<Mission>),
        );
        const roster = dataSource.getRepository(OrganizationMember);
        await roster.save([
            roster.create({
                organizationId: ORG,
                tenantId: TENANT,
                userId: OWNER,
                joinedAt: new Date('2026-01-01T00:00:00.000Z'),
            }),
            roster.create({
                organizationId: ORG,
                tenantId: TENANT,
                userId: TEAMMATE,
                joinedAt: new Date('2026-01-01T00:00:00.000Z'),
            }),
        ]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        for (const entity of [
            Agent,
            Team,
            TeamMember,
            TeamResource,
            AgentMembership,
            AgentRun,
            Task,
            TaskAssignee,
        ]) {
            await dataSource.getRepository(entity).clear();
        }
        missionsGate = {
            getReadable: jest.fn().mockResolvedValue({
                id: MISSION,
                tenantId: TENANT,
                organizationId: ORG,
            }),
        };
        missionWorks = {
            listForMissionWithWork: jest
                .fn()
                .mockResolvedValue([{ workId: WORK, workName: 'ever.co website' }]),
        };
    });

    async function agent(over: Partial<Agent>): Promise<Agent> {
        return agents.save(
            agents.create({
                userId: OWNER,
                tenantId: TENANT,
                organizationId: ORG,
                scope: AgentScope.TENANT,
                status: AgentStatus.ACTIVE,
                permissions: {},
                visibility: 'organization',
                ...over,
            } as Partial<Agent>),
        );
    }

    async function team(name: string, organizationId = ORG): Promise<Team> {
        return teams.save(
            teams.create({
                userId: OWNER,
                name,
                slug: name.toLowerCase().replace(/\s+/g, '-'),
                tenantId: TENANT,
                organizationId,
            } as Partial<Team>),
        );
    }

    async function holdsMission(teamId: string, organizationId = ORG): Promise<void> {
        await resources.save(
            resources.create({
                teamId,
                resourceType: 'mission',
                resourceId: MISSION,
                tenantId: TENANT,
                organizationId,
                createdAt: new Date('2026-11-01T00:00:00.000Z'),
            }),
        );
    }

    async function onTeam(teamId: string, agentId: string): Promise<void> {
        await members.save(members.create({ teamId, memberType: 'agent', memberId: agentId }));
    }

    async function assign(
        agentId: string,
        targetType: 'mission' | 'work',
        targetId: string,
    ): Promise<void> {
        const repo = dataSource.getRepository(AgentMembership);
        await repo.save(
            repo.create({ agentId, targetType, targetId, tenantId: TENANT, organizationId: ORG }),
        );
    }

    async function standingTask(over: Partial<Task>): Promise<Task> {
        slugSeq += 1;
        const repo = dataSource.getRepository(Task);
        return repo.save(
            repo.create({
                userId: OWNER,
                slug: `T-${slugSeq}`,
                title: `Weekly ${slugSeq}`,
                status: TaskStatus.TODO,
                priority: TaskPriority.P3,
                createdByType: 'user',
                createdById: OWNER,
                isRecurring: true,
                recurrenceCron: '0 3 * * 1',
                nextOccurrenceAt: new Date('2099-01-05T03:00:00.000Z'),
                recurrenceOccurredCount: 0,
                workId: WORK,
                tenantId: TENANT,
                organizationId: ORG,
                ...over,
            } as Partial<Task>),
        );
    }

    async function endedRun(
        agentId: string,
        status: AgentRun['status'],
        finishedAt: string,
    ): Promise<void> {
        const repo = dataSource.getRepository(AgentRun);
        await repo.save(
            repo.create({
                agentId,
                userId: OWNER,
                triggerKind: 'task',
                status,
                finishedAt: new Date(finishedAt),
            }),
        );
    }

    it('lists the Teams holding the Mission with their Agents, then the Work agents not already shown', async () => {
        const product = await team('Product');
        await holdsMission(product.id);
        const builder = await agent({
            name: 'Builder',
            slug: 'builder',
            // The HEARTBEAT's last run: not what the panel shows.
            lastRunAt: new Date('2026-11-01T09:00:00.000Z'),
            lastRunStatus: 'failed',
        });
        await endedRun(builder.id, 'completed', '2026-11-10T21:04:00.000Z');
        const reviewer = await agent({ name: 'Reviewer', slug: 'reviewer' });
        await onTeam(product.id, builder.id);
        await onTeam(product.id, reviewer.id);
        // Work-scoped AND on the Team: listed once, under the Team.
        const workBot = await agent({
            name: 'Site Bot',
            slug: 'site-bot',
            scope: AgentScope.WORK,
            workId: WORK,
        });
        await onTeam(product.id, workBot.id);
        const workOnly = await agent({
            name: 'Docs Bot',
            slug: 'docs-bot',
            scope: AgentScope.WORK,
            workId: WORK,
        });
        const missionScoped = await agent({
            name: 'Mission Lead',
            slug: 'mission-lead',
            scope: AgentScope.MISSION,
            missionId: MISSION,
        });

        const view = await service().getForUser(OWNER, MISSION, SCOPE);

        expect(missionsGate.getReadable).toHaveBeenCalledWith(OWNER, MISSION, SCOPE);
        expect(missionWorks.listForMissionWithWork).toHaveBeenCalledWith(MISSION, OWNER, SCOPE);
        expect(view.teams).toHaveLength(1);
        expect(view.teams[0]).toMatchObject({ id: product.id, name: 'Product', slug: 'product' });
        expect(view.teams[0].agents.map((a) => a.name)).toEqual([
            'Builder',
            'Reviewer',
            'Site Bot',
        ]);
        expect(view.teams[0].agents[0]).toEqual({
            id: builder.id,
            name: 'Builder',
            status: 'active',
            latestRun: { status: 'completed', finishedAt: '2026-11-10T21:04:00.000Z' },
        });
        expect(view.teams[0].agents[1].latestRun).toBeNull();
        expect(view.agents).toEqual([
            expect.objectContaining({
                id: missionScoped.id,
                via: 'mission',
                workId: null,
                workName: null,
            }),
            expect.objectContaining({
                id: workOnly.id,
                via: 'work',
                workId: WORK,
                workName: 'ever.co website',
            }),
        ]);
    });

    it('lists Agents ASSIGNED through memberships — to the Mission or to an attached Work', async () => {
        const toMission = await agent({ name: 'Planner', slug: 'planner' });
        const toWork = await agent({ name: 'Site Editor', slug: 'site-editor' });
        const elsewhere = await agent({ name: 'Elsewhere', slug: 'elsewhere' });
        await assign(toMission.id, 'mission', MISSION);
        await assign(toWork.id, 'work', WORK);
        await assign(elsewhere.id, 'work', OTHER_WORK);

        const view = await service().getForUser(OWNER, MISSION, SCOPE);

        expect(view.agents).toEqual([
            expect.objectContaining({ id: toMission.id, via: 'mission', workId: null }),
            expect.objectContaining({
                id: toWork.id,
                via: 'work',
                workId: WORK,
                workName: 'ever.co website',
            }),
        ]);
    });

    it('lists a shared workspace Agent that drives an active standing Task on an attached Work', async () => {
        const editor = await agent({ name: 'Ever Web & Content Editor', slug: 'web-editor' });
        const writer = await agent({ name: 'Ever Docs Writer', slug: 'docs-writer' });
        const paused = await agent({ name: 'Paused Bot', slug: 'paused-bot' });
        const assignedTask = await standingTask({ agentId: null });
        await dataSource
            .getRepository(TaskAssignee)
            .save({ taskId: assignedTask.id, assigneeType: 'agent', assigneeId: writer.id });
        await standingTask({ agentId: editor.id });
        await standingTask({ agentId: paused.id, recurrencePausedAt: new Date('2026-11-01') });
        await standingTask({ agentId: paused.id, workId: OTHER_WORK });

        const view = await service().getForUser(OWNER, MISSION, SCOPE);

        expect(view.agents.map((a) => [a.name, a.via, a.workName])).toEqual([
            ['Ever Docs Writer', 'standing-tasks', 'ever.co website'],
            ['Ever Web & Content Editor', 'standing-tasks', 'ever.co website'],
        ]);
    });

    it("never lists another member's PRIVATE Agent — the same rule as everywhere else", async () => {
        const product = await team('Product');
        await holdsMission(product.id);
        const shared = await agent({ name: 'Shared', slug: 'shared', userId: TEAMMATE });
        const hidden = await agent({
            name: 'Private',
            slug: 'private',
            userId: TEAMMATE,
            visibility: 'private',
        });
        const mine = await agent({ name: 'Mine', slug: 'mine', visibility: 'private' });
        for (const a of [shared, hidden, mine]) await onTeam(product.id, a.id);
        const privateWorkBot = await agent({
            name: 'Private Work Bot',
            slug: 'private-work-bot',
            userId: TEAMMATE,
            visibility: 'private',
            scope: AgentScope.WORK,
            workId: WORK,
        });
        // A private Agent reached through a membership or a standing Task stays hidden too.
        await assign(privateWorkBot.id, 'mission', MISSION);
        await standingTask({ agentId: hidden.id });

        const view = await service().getForUser(OWNER, MISSION, SCOPE);

        expect(view.teams[0].agents.map((a) => a.name)).toEqual(['Mine', 'Shared']);
        expect(view.agents).toEqual([]);
    });

    it('a viewer who may read a shared Mission sees its Teams — but no Work they cannot reach', async () => {
        const product = await team('Product');
        await holdsMission(product.id);
        const builder = await agent({ name: 'Builder', slug: 'builder' });
        await onTeam(product.id, builder.id);
        await agent({ name: 'Docs Bot', slug: 'docs-bot', scope: AgentScope.WORK, workId: WORK });

        const view = await service().getForUser(TEAMMATE, MISSION, SCOPE);

        expect(missionsGate.getReadable).toHaveBeenCalledWith(TEAMMATE, MISSION, SCOPE);
        // The Works are the OWNER's edges; the viewer neither owns nor is a
        // member of this one, so its name (and its Agents) stay out.
        expect(missionWorks.listForMissionWithWork).toHaveBeenCalledWith(MISSION, OWNER, SCOPE);
        expect(view.teams[0].agents.map((a) => a.name)).toEqual(['Builder']);
        expect(view.agents).toEqual([]);
    });

    it("without the access policy, lists only the caller's own Agents", async () => {
        const product = await team('Product');
        await holdsMission(product.id);
        const theirs = await agent({ name: 'Theirs', slug: 'theirs', userId: TEAMMATE });
        const mine = await agent({ name: 'Mine', slug: 'mine' });
        await onTeam(product.id, theirs.id);
        await onTeam(product.id, mine.id);

        const view = await service(false).getForUser(OWNER, MISSION, SCOPE);

        expect(view.teams[0].agents.map((a) => a.name)).toEqual(['Mine']);
    });

    it("reads Teams only in the Mission's own Organization, and leaves archived Agents out", async () => {
        const foreign = await team('Elsewhere', OTHER_ORG);
        await holdsMission(foreign.id, OTHER_ORG);
        const product = await team('Product');
        await holdsMission(product.id);
        const retired = await agent({
            name: 'Retired',
            slug: 'retired',
            status: AgentStatus.ARCHIVED,
        });
        await onTeam(product.id, retired.id);

        const view = await service().getForUser(OWNER, MISSION, SCOPE);

        expect(view.teams.map((t) => t.name)).toEqual(['Product']);
        expect(view.teams[0].agents).toEqual([]);
    });

    it('a personal Mission has no Teams', async () => {
        missionsGate.getReadable.mockResolvedValue({
            id: MISSION,
            tenantId: TENANT,
            organizationId: null,
        });
        const product = await team('Product');
        await holdsMission(product.id);

        const view = await service().getForUser(OWNER, MISSION, {
            tenantId: TENANT,
            organizationId: null,
        });

        expect(view.teams).toEqual([]);
    });

    it('is a 404 for a Mission the caller may not read — the gate runs first', async () => {
        missionsGate.getReadable.mockRejectedValue(new NotFoundException('Mission not found'));

        await expect(service().getForUser(TEAMMATE, MISSION, SCOPE)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(missionWorks.listForMissionWithWork).not.toHaveBeenCalled();
    });

    describe('MissionsModule wiring', () => {
        it('registers the Team repositories and provides + exports the service', () => {
            const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MissionsModule) ??
                []) as Array<{ providers?: Array<{ provide?: unknown }> }>;
            const tokens = imports.flatMap((entry) =>
                Array.isArray(entry?.providers) ? entry.providers.map((p) => p?.provide) : [],
            );
            for (const entity of [Team, TeamMember, TeamResource, Agent, Mission]) {
                expect(tokens).toContain(getRepositoryToken(entity));
            }
            expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MissionsModule)).toContain(
                MissionTeamService,
            );
            expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, MissionsModule)).toContain(
                MissionTeamService,
            );
        });
    });
});
