// Same isolation as `missions.controller.spec.ts`: the auth decorator and the scope barrel pull
// `better-auth` (ESM), and the agent barrels pull the whole agent graph; the controller needs only
// these names at module evaluation.
jest.mock('../auth/decorators/user.decorator', () => ({ CurrentUser: () => () => undefined }));
jest.mock('../scope', () => ({ ScopeContextService: class ScopeContextService {} }));
jest.mock('@ever-works/agent/missions', () => ({
    MissionsService: class MissionsService {},
    MissionCloneService: class MissionCloneService {},
    MissionTeamService: class MissionTeamService {},
    MissionStatus: { ACTIVE: 'active', PAUSED: 'paused', COMPLETED: 'completed', FAILED: 'failed' },
    MissionType: { ONE_SHOT: 'one-shot', SCHEDULED: 'scheduled' },
}));
jest.mock('@ever-works/agent/work-agent', () => ({
    SUPPORTED_AUTO_GENERATE_CADENCE_PATTERN: /^\*\/\d+\s+\*\s+\*\s+\*\s+\*$/,
    WorkBuildRequestSource: {},
    WorkBuildRequestStatus: {},
    WorkAgentRunLogLevel: {},
    WorkAgentRunStatus: {},
}));
jest.mock('@ever-works/agent/budgets', () => ({ BudgetService: class BudgetService {} }));

import { NotFoundException } from '@nestjs/common';
import { MissionsController } from './missions.controller';

/**
 * `GET /api/me/missions/:id/team` — the Mission page's "Team and agents"
 * panel in one read. Gated like `GET :id` (`getReadable`: the owner, or a
 * viewer the Mission's visibility admits) in the request scope; the agent-side
 * service filters every Agent (and Work) through what the caller may read
 * (pinned by `mission-team.service.spec.ts`).
 */
const MISSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOPE = { tenantId: 't1', organizationId: 'o1' };
const session = { userId: 'u1', authMethod: 'session' } as never;

function build(teamService?: { getForUser: jest.Mock }) {
    const service = { getReadable: jest.fn(async () => ({ id: MISSION })) };
    const scopeContext = { getScope: jest.fn(() => SCOPE) };
    const controller = new (MissionsController as unknown as new (
        ...args: unknown[]
    ) => MissionsController)(service, {}, {}, {}, scopeContext, teamService);
    return { controller, service };
}

describe('MissionsController — GET :id/team', () => {
    it('reads who works on the Mission for the session user in the request scope', async () => {
        const view = {
            teams: [{ id: 't1', name: 'Product', slug: 'product', agents: [] }],
            agents: [],
        };
        const teamService = { getForUser: jest.fn().mockResolvedValue(view) };
        const { controller } = build(teamService);

        await expect(controller.team(session, MISSION)).resolves.toBe(view);
        expect(teamService.getForUser).toHaveBeenCalledWith('u1', MISSION, SCOPE);
    });

    it("passes the owner gate's 404 straight through", async () => {
        const teamService = {
            getForUser: jest.fn().mockRejectedValue(new NotFoundException('Mission not found')),
        };
        const { controller } = build(teamService);

        await expect(controller.team(session, MISSION)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unwired: still gates on the Mission READ (like GET :id), then answers an empty panel', async () => {
        const { controller, service } = build(undefined);

        await expect(controller.team(session, MISSION)).resolves.toEqual({
            teams: [],
            agents: [],
        });
        expect(service.getReadable).toHaveBeenCalledWith('u1', MISSION, SCOPE);
    });
});
