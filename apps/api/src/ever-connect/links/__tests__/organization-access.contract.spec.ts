import type {
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { OrganizationMembershipService } from '../../../organizations/organization-membership.service';

/**
 * Who may read and change an Organization's link is decided by
 * `OrganizationMembershipService`, as on every `/organizations/:orgId` route.
 * The link's HTTP spec plays that service with a stand-in (the real
 * Organization module cannot be loaded there); this spec pins, on the real
 * service, the contract the stand-in copies:
 *
 * - an Organization of another account, or one that does not exist, is "not
 *   found" for reading and for changing (never "forbidden": its existence is
 *   not told);
 * - an account's member reads; by default it also changes;
 * - with `ORG_ADMIN_ROLE_ENFORCED=true`, only the account's owner or a member
 *   with the role `admin` (or `owner`) changes, and anyone else of the account
 *   is refused with `403`.
 */
describe("Organization link — who may reach an Organization's link", () => {
    const savedEnv = { ...process.env };
    const TENANT = 'tenant-1';
    const ORG = { id: 'org-1', tenantId: TENANT, slug: 'acme' };
    const users: Record<string, { id: string; tenantId: string | null }> = {
        owner: { id: 'owner', tenantId: TENANT },
        admin: { id: 'admin', tenantId: TENANT },
        member: { id: 'member', tenantId: TENANT },
        outsider: { id: 'outsider', tenantId: 'tenant-2' },
        new: { id: 'new', tenantId: null },
    };
    const roles: Record<string, string> = { admin: 'admin', member: 'member' };

    const service = () =>
        new OrganizationMembershipService(
            {
                findById: async (id: string) => (id === ORG.id ? ORG : null),
            } as unknown as OrganizationRepository,
            {
                findById: async (id: string) => users[id] ?? null,
            } as unknown as UserRepository,
            {
                findById: async (id: string) =>
                    id === TENANT ? { id: TENANT, ownerUserId: 'owner' } : null,
            } as unknown as TenantRepository,
            {
                findByOrgAndUser: async (_org: string, userId: string) =>
                    roles[userId] ? { role: roles[userId] } : null,
            } as unknown as OrganizationMemberRepository,
        );
    const statusOf = async (attempt: Promise<unknown>) => {
        try {
            await attempt;
            return 200;
        } catch (error) {
            return (error as { getStatus?: () => number }).getStatus?.() ?? 500;
        }
    };

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it("another account's Organization, a missing one and a person without an account are not found", async () => {
        const membership = service();
        for (const check of ['ensureMember', 'ensureAdmin'] as const) {
            expect(await statusOf(membership[check](ORG.id, 'outsider'))).toBe(404);
            expect(await statusOf(membership[check](ORG.id, 'new'))).toBe(404);
            expect(await statusOf(membership[check](ORG.id, 'nobody'))).toBe(404);
            expect(await statusOf(membership[check]('org-missing', 'owner'))).toBe(404);
        }
    });

    it("the account's members read; by default they change too", async () => {
        delete process.env.ORG_ADMIN_ROLE_ENFORCED;
        const membership = service();
        for (const user of ['owner', 'admin', 'member']) {
            expect(await membership.ensureMember(ORG.id, user)).toBe(ORG);
            expect(await membership.ensureAdmin(ORG.id, user)).toBe(ORG);
        }
    });

    it('with the admin role enforced, only the owner and an admin change; a member is refused, not hidden from', async () => {
        process.env.ORG_ADMIN_ROLE_ENFORCED = 'true';
        const membership = service();
        expect(await statusOf(membership.ensureAdmin(ORG.id, 'owner'))).toBe(200);
        expect(await statusOf(membership.ensureAdmin(ORG.id, 'admin'))).toBe(200);
        expect(await statusOf(membership.ensureAdmin(ORG.id, 'member'))).toBe(403);
        expect(await statusOf(membership.ensureMember(ORG.id, 'member'))).toBe(200);
        expect(await statusOf(membership.ensureAdmin(ORG.id, 'outsider'))).toBe(404);
    });
});
