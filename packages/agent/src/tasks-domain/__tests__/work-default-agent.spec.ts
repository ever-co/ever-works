import { ownershipScopeMatches, type OwnershipScope } from '../../database/ownership-scope';
import { AgentStatus, type Agent } from '../../entities/agent.entity';
import {
    resolveWorkDefaultAgent,
    usableWorkDefaultAgent,
    type WorkDefaultAgentLookup,
} from '../work-default-agent';

/**
 * A Work's default Agent — the one rule the write (`PATCH /api/works/:id`) and every read share.
 *
 * The lookup double behaves like `AgentRepository.findByIdAndUser`: the owner AND the scope it is
 * given (`ownershipWhere`). A second, LEAKY double ignores the scope entirely, to prove the rule
 * does not rely on the query alone: an Agent of another tenant or organization is refused even
 * when a read hands it back.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';

function agent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'agent-docs',
        userId: 'u1',
        name: 'Docs writer',
        status: AgentStatus.ACTIVE,
        tenantId: TENANT,
        organizationId: ORG,
        ...over,
    } as Agent;
}

function scopedLookup(rows: Agent[]): WorkDefaultAgentLookup & { findByIdAndUser: jest.Mock } {
    return {
        findByIdAndUser: jest.fn(async (id: string, userId: string, scope?: OwnershipScope) => {
            const row = rows.find(
                (candidate) => candidate.id === id && candidate.userId === userId,
            );
            return row && ownershipScopeMatches(row, scope) ? row : null;
        }),
    };
}

function leakyLookup(rows: Agent[]): WorkDefaultAgentLookup {
    return { findByIdAndUser: async (id: string) => rows.find((row) => row.id === id) ?? null };
}

const orgWork = { tenantId: TENANT, organizationId: ORG };

describe('usableWorkDefaultAgent', () => {
    it("answers the caller's own Agent in the Work's tenant and organization", async () => {
        const own = agent();
        const lookup = scopedLookup([own]);
        await expect(usableWorkDefaultAgent(lookup, own.id, orgWork, 'u1')).resolves.toBe(own);
        // The query is bounded by the Work's own scope, never a wider one.
        expect(lookup.findByIdAndUser).toHaveBeenCalledWith(own.id, 'u1', {
            tenantId: TENANT,
            organizationId: ORG,
        });
    });

    it('refuses an Agent of another organization, another tenant or another owner', async () => {
        const rows = [
            agent({ id: 'agent-other-org', organizationId: OTHER_ORG }),
            agent({ id: 'agent-other-tenant', tenantId: OTHER_TENANT }),
            agent({ id: 'agent-someone-else', userId: 'u2' }),
        ];
        for (const lookup of [scopedLookup(rows), leakyLookup(rows)]) {
            for (const row of rows) {
                await expect(
                    usableWorkDefaultAgent(lookup, row.id, orgWork, 'u1'),
                ).resolves.toBeNull();
            }
        }
    });

    it("refuses a personal Agent for an organization's Work, and an organization Agent for a personal Work", async () => {
        const personal = agent({ id: 'agent-personal', organizationId: null });
        await expect(
            usableWorkDefaultAgent(leakyLookup([personal]), personal.id, orgWork, 'u1'),
        ).resolves.toBeNull();
        const orgAgent = agent({ id: 'agent-org' });
        await expect(
            usableWorkDefaultAgent(
                leakyLookup([orgAgent]),
                orgAgent.id,
                { tenantId: TENANT, organizationId: null },
                'u1',
            ),
        ).resolves.toBeNull();
    });

    it('refuses an archived Agent and an id that does not exist', async () => {
        const archived = agent({ status: AgentStatus.ARCHIVED });
        await expect(
            usableWorkDefaultAgent(scopedLookup([archived]), archived.id, orgWork, 'u1'),
        ).resolves.toBeNull();
        await expect(
            usableWorkDefaultAgent(scopedLookup([]), 'agent-missing', orgWork, 'u1'),
        ).resolves.toBeNull();
    });

    it("also holds the caller's request scope: an Agent the Work admits but the request does not is refused", async () => {
        const own = agent();
        await expect(
            usableWorkDefaultAgent(leakyLookup([own]), own.id, orgWork, 'u1', {
                tenantId: TENANT,
                organizationId: OTHER_ORG,
            }),
        ).resolves.toBeNull();
    });

    // Review of #3159, finding 3: a Work with no tenant/organization recorded admits only the
    // owner's PERSONAL Agents (no organization) — on the write AND on every read, including a
    // scope-less background call, and whatever the request scope is.
    it('a Work with no recorded scope admits only a personal Agent, with or without a request scope', async () => {
        const personal = agent({ id: 'agent-personal', organizationId: null });
        const orgAgent = agent({ id: 'agent-org' });
        const legacyWork = { tenantId: null, organizationId: null };
        for (const lookup of [
            scopedLookup([personal, orgAgent]),
            leakyLookup([personal, orgAgent]),
        ]) {
            for (const requestScope of [undefined, { tenantId: TENANT, organizationId: ORG }]) {
                await expect(
                    usableWorkDefaultAgent(lookup, orgAgent.id, legacyWork, 'u1', requestScope),
                ).resolves.toBeNull();
            }
            await expect(
                usableWorkDefaultAgent(lookup, personal.id, legacyWork, 'u1'),
            ).resolves.toBe(personal);
        }
    });

    it("refuses an Agent that is not the Work owner's, even when the caller owns it", async () => {
        const own = agent();
        await expect(
            usableWorkDefaultAgent(scopedLookup([own]), own.id, { ...orgWork, userId: 'u2' }, 'u1'),
        ).resolves.toBeNull();
        await expect(
            usableWorkDefaultAgent(scopedLookup([own]), own.id, { ...orgWork, userId: 'u1' }, 'u1'),
        ).resolves.toBe(own);
    });
});

describe('resolveWorkDefaultAgent', () => {
    it('answers null without a read when the Work names no default', async () => {
        const lookup = scopedLookup([agent()]);
        await expect(
            resolveWorkDefaultAgent(lookup, { ...orgWork, defaultAgentId: null }, 'u1'),
        ).resolves.toBeNull();
        expect(lookup.findByIdAndUser).not.toHaveBeenCalled();
    });

    it('answers the named Agent while it qualifies, and null once it was archived', async () => {
        const own = agent();
        const work = { ...orgWork, defaultAgentId: own.id };
        await expect(resolveWorkDefaultAgent(scopedLookup([own]), work, 'u1')).resolves.toBe(own);
        await expect(
            resolveWorkDefaultAgent(
                scopedLookup([{ ...own, status: AgentStatus.ARCHIVED } as Agent]),
                work,
                'u1',
            ),
        ).resolves.toBeNull();
    });

    it('a scope-less background read of an unstamped Work never resolves an organization Agent', async () => {
        const orgAgent = agent({ id: 'agent-org' });
        await expect(
            resolveWorkDefaultAgent(
                leakyLookup([orgAgent]),
                { tenantId: null, organizationId: null, defaultAgentId: orgAgent.id },
                'u1',
            ),
        ).resolves.toBeNull();
    });

    it('lets a failed read propagate, so each caller decides whether it may fall back', async () => {
        const failing: WorkDefaultAgentLookup = {
            findByIdAndUser: jest.fn().mockRejectedValue(new Error('connection reset')),
        };
        await expect(
            resolveWorkDefaultAgent(failing, { ...orgWork, defaultAgentId: 'agent-docs' }, 'u1'),
        ).rejects.toThrow('connection reset');
    });
});
