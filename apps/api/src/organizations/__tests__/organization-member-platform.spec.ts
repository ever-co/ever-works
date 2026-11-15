import { ConflictException } from '@nestjs/common';

jest.mock('@ever-works/agent/services', () => ({
    OrganizationInvitationService: class OrganizationInvitationService {
        static normaliseEmail(email: string): string {
            return email.trim().toLowerCase();
        }
    },
}));
jest.mock('@ever-works/agent/database', () => ({
    OrganizationMemberRepository: class OrganizationMemberRepository {},
    OrganizationRepository: class OrganizationRepository {},
    TenantRepository: class TenantRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('../../scope/tenant-bootstrap.service', () => ({
    TenantBootstrapService: class TenantBootstrapService {},
}));
jest.mock('../../mail/mail.service', () => ({ MailService: class MailService {} }));
jest.mock('../../config/constants', () => ({
    config: { webAppUrl: () => 'https://app.test' },
}));
jest.mock('../organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));

import { OrganizationInvitationFlowService } from '../organization-invitation-flow.service';

/**
 * Ever Connect membership sync — the Organization's own membership code, with
 * no actor (`addMemberForPlatform`, `setMemberRoleForPlatform`,
 * `removeMemberForPlatform`):
 *
 * - a person with no workspace joins with the roster role (roster row, then the
 *   grant), after a seat check; someone already in the workspace just gets the
 *   roster row; the same call again changes nothing;
 * - the Tenant owner is never changed or removed, so the Organization never
 *   loses its owner;
 * - an account homed in another workspace is never moved;
 * - removing clears the account's workspace only when no other membership
 *   there remains.
 */
const TENANT = 'ten-1';
const ORG = { id: 'org-1', tenantId: TENANT, slug: 'acme', displayName: 'Acme' };
const SIBLING = { id: 'org-2', tenantId: TENANT, slug: 'acme-labs', displayName: 'Acme Labs' };
const OWNER = 'owner-1';

interface RosterRow {
    id: string;
    organizationId: string;
    tenantId: string;
    userId: string;
    role: string;
    joinedAt: Date;
}

function build(options: { users?: Record<string, string | null>; seatsFull?: boolean } = {}) {
    const users = new Map<string, { id: string; tenantId: string | null }>(
        Object.entries({ [OWNER]: TENANT, ...(options.users ?? {}) }).map(([id, tenantId]) => [
            id,
            { id, tenantId },
        ]),
    );
    const roster: RosterRow[] = [];
    const members = {
        findByOrgAndUser: jest.fn(
            async (organizationId: string, userId: string) =>
                roster.find((r) => r.organizationId === organizationId && r.userId === userId) ??
                null,
        ),
        create: jest.fn(async (data: Omit<RosterRow, 'id'>) => {
            const row = { ...data, id: `m-${roster.length + 1}` };
            roster.push(row);
            return row;
        }),
        updateRole: jest.fn(async (organizationId: string, userId: string, role: string) => {
            const row = roster.find(
                (r) => r.organizationId === organizationId && r.userId === userId,
            );
            if (row) row.role = role;
            return !!row;
        }),
        deleteByOrgAndUser: jest.fn(async (organizationId: string, userId: string) => {
            const at = roster.findIndex(
                (r) => r.organizationId === organizationId && r.userId === userId,
            );
            if (at < 0) return false;
            roster.splice(at, 1);
            return true;
        }),
        listForUserInTenant: jest.fn(async (userId: string, tenantId: string) =>
            roster.filter((r) => r.userId === userId && r.tenantId === tenantId),
        ),
    };
    const userRepository = {
        findById: jest.fn(async (id: string) => users.get(id) ?? null),
        update: jest.fn(async (id: string, values: { tenantId: string | null }) => {
            const user = users.get(id);
            if (user) user.tenantId = values.tenantId;
        }),
    };
    const tenantBootstrap = {
        joinTenant: jest.fn(async (userId: string, tenantId: string) => {
            const user = users.get(userId);
            if (!user) throw new Error('no user');
            if (user.tenantId === tenantId) return 'already_member';
            if (user.tenantId) throw new ConflictException('user_already_in_another_tenant');
            user.tenantId = tenantId;
            return 'joined';
        }),
    };
    const seats = {
        resolveBillingOwner: jest.fn(async (id: string) => id),
        assertSeatAvailable: jest.fn(async () => {
            if (!options.seatsFull) return;
            const error = new Error('Seat limit reached');
            error.name = 'SeatLimitExceededError';
            throw error;
        }),
    };
    const organizations = {
        findById: jest.fn(
            async (id: string) => [ORG, SIBLING].find((org) => org.id === id) ?? null,
        ),
    };
    const service = new OrganizationInvitationFlowService(
        {} as never,
        members as never,
        organizations as never,
        userRepository as never,
        { findById: jest.fn().mockResolvedValue({ id: TENANT, ownerUserId: OWNER }) } as never,
        tenantBootstrap as never,
        {} as never,
        {} as never,
        seats as never,
    );
    return { service, users, roster, members, userRepository, tenantBootstrap, seats };
}

describe('OrganizationInvitationFlowService — membership changes from Ever Platform', () => {
    it('a person with no workspace joins with the role; the same change again changes nothing', async () => {
        const { service, users, roster, members, seats } = build({ users: { ada: null } });

        expect(await service.addMemberForPlatform(ORG.id, 'ada', 'admin')).toBe('added');
        expect(roster).toEqual([
            expect.objectContaining({ organizationId: ORG.id, userId: 'ada', role: 'admin' }),
        ]);
        expect(users.get('ada')?.tenantId).toBe(TENANT);
        expect(seats.assertSeatAvailable).toHaveBeenCalledWith(OWNER);

        expect(await service.addMemberForPlatform(ORG.id, 'ada', 'admin')).toBe('unchanged');
        expect(members.create).toHaveBeenCalledTimes(1);
        expect(roster).toHaveLength(1);
    });

    it('someone already in the workspace gets the roster row, without a seat check', async () => {
        const { service, roster, seats } = build({ users: { bob: TENANT } });
        expect(await service.addMemberForPlatform(ORG.id, 'bob', 'member')).toBe('added');
        expect(roster).toEqual([expect.objectContaining({ userId: 'bob', role: 'member' })]);
        expect(seats.assertSeatAvailable).not.toHaveBeenCalled();
    });

    it("a member's role is set; setting it again writes nothing", async () => {
        const { service, roster, members } = build({ users: { ada: null } });
        await service.addMemberForPlatform(ORG.id, 'ada', 'member');

        expect(await service.setMemberRoleForPlatform(ORG.id, 'ada', 'admin')).toBe('role_set');
        expect(roster[0].role).toBe('admin');
        expect(await service.setMemberRoleForPlatform(ORG.id, 'ada', 'admin')).toBe('unchanged');
        expect(members.updateRole).toHaveBeenCalledTimes(1);
        // An addition naming another role is a role change.
        expect(await service.addMemberForPlatform(ORG.id, 'ada', 'member')).toBe('role_set');
        expect(roster[0].role).toBe('member');
    });

    it('a role change for someone not on the roster adds nobody', async () => {
        const { service, roster, users } = build({ users: { ada: null } });
        expect(await service.setMemberRoleForPlatform(ORG.id, 'ada', 'admin')).toBe('not_a_member');
        expect(roster).toEqual([]);
        expect(users.get('ada')?.tenantId).toBeNull();
    });

    it('the Tenant owner is never changed or removed', async () => {
        const { service, roster, members, userRepository, tenantBootstrap } = build();
        expect(await service.addMemberForPlatform(ORG.id, OWNER, 'member')).toBe('owner_unchanged');
        expect(await service.setMemberRoleForPlatform(ORG.id, OWNER, 'member')).toBe(
            'owner_unchanged',
        );
        expect(await service.removeMemberForPlatform(ORG.id, OWNER)).toBe('owner_kept');
        expect(roster).toEqual([]);
        expect(members.create).not.toHaveBeenCalled();
        expect(members.deleteByOrgAndUser).not.toHaveBeenCalled();
        expect(userRepository.update).not.toHaveBeenCalled();
        expect(tenantBootstrap.joinTenant).not.toHaveBeenCalled();
    });

    it('an account homed in another workspace is never moved', async () => {
        const { service, roster, users, tenantBootstrap } = build({ users: { eve: 'ten-other' } });
        expect(await service.addMemberForPlatform(ORG.id, 'eve', 'admin')).toBe('other_account');
        expect(roster).toEqual([]);
        expect(users.get('eve')?.tenantId).toBe('ten-other');
        expect(tenantBootstrap.joinTenant).not.toHaveBeenCalled();
    });

    it('no free seat: nothing is written', async () => {
        const { service, roster, users } = build({ users: { ada: null }, seatsFull: true });
        expect(await service.addMemberForPlatform(ORG.id, 'ada', 'member')).toBe('no_seat');
        expect(roster).toEqual([]);
        expect(users.get('ada')?.tenantId).toBeNull();
    });

    it('a seat check that fails for another reason is a fault, not "no seat"', async () => {
        const { service, seats } = build({ users: { ada: null } });
        seats.assertSeatAvailable.mockRejectedValueOnce(new Error('database is down'));
        await expect(service.addMemberForPlatform(ORG.id, 'ada', 'member')).rejects.toThrow(
            'database is down',
        );
    });

    it('removing clears the workspace only once no other membership there remains', async () => {
        const { service, roster, users } = build({ users: { ada: null } });
        await service.addMemberForPlatform(ORG.id, 'ada', 'member');
        await service.addMemberForPlatform(SIBLING.id, 'ada', 'member');

        expect(await service.removeMemberForPlatform(ORG.id, 'ada')).toBe('removed');
        expect(roster.map((r) => r.organizationId)).toEqual([SIBLING.id]);
        expect(users.get('ada')?.tenantId).toBe(TENANT);

        expect(await service.removeMemberForPlatform(SIBLING.id, 'ada')).toBe('removed');
        expect(roster).toEqual([]);
        expect(users.get('ada')?.tenantId).toBeNull();

        expect(await service.removeMemberForPlatform(SIBLING.id, 'ada')).toBe('not_a_member');
    });

    it('an Organization that does not exist changes nothing', async () => {
        const { service, roster } = build({ users: { ada: null } });
        expect(await service.addMemberForPlatform('org-missing', 'ada', 'member')).toBe(
            'organization_missing',
        );
        expect(await service.removeMemberForPlatform('org-missing', 'ada')).toBe(
            'organization_missing',
        );
        expect(roster).toEqual([]);
    });
});
