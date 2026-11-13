import type { ExecutionContext } from '@nestjs/common';
import type {
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { OrganizationMembershipService } from '../../../organizations/organization-membership.service';
import { OrganizationLinkAdminGuard } from '../organization-link-admin.guard';

/**
 * Who may read and change an Organization's link, on the REAL
 * `OrganizationMembershipService` and the real `OrganizationLinkAdminGuard`
 * (the link's HTTP spec plays the service with a stand-in, because the real
 * Organization module cannot be loaded there; this is the contract it copies):
 *
 * - an Organization of another account, or one that does not exist, is "not
 *   found" for reading and for changing (never "forbidden": its existence is
 *   not told);
 * - every member of the account reads;
 * - **linking and removing a link** need the account's owner or a member whose
 *   role in the Organization is `admin` (or `owner`), in EVERY configuration:
 *   `ensureRoleAdmin` does not read `ORG_ADMIN_ROLE_ENFORCED`. A plain member,
 *   and a person of the account with no role at all, get `403`;
 * - the general `ensureAdmin`, which other routes use, keeps its opt-in rule
 *   (membership unless `ORG_ADMIN_ROLE_ENFORCED=true`): that is why the link
 *   routes do not rely on it.
 */
describe("Organization link — who may reach an Organization's link", () => {
    const savedEnv = { ...process.env };
    const TENANT = 'tenant-1';
    const ORG = { id: 'org-1', tenantId: TENANT, slug: 'acme' };
    const users: Record<string, { id: string; tenantId: string | null }> = {
        owner: { id: 'owner', tenantId: TENANT },
        admin: { id: 'admin', tenantId: TENANT },
        'second-owner': { id: 'second-owner', tenantId: TENANT },
        member: { id: 'member', tenantId: TENANT },
        // Of the account, with no roster row at all (joined before the roster existed).
        unlisted: { id: 'unlisted', tenantId: TENANT },
        outsider: { id: 'outsider', tenantId: 'tenant-2' },
        new: { id: 'new', tenantId: null },
    };
    const roles: Record<string, string> = {
        admin: 'admin',
        'second-owner': 'owner',
        member: 'member',
    };

    const organizations = {
        findById: async (id: string) => (id === ORG.id ? ORG : null),
    } as unknown as OrganizationRepository;
    const people = {
        findById: async (id: string) => users[id] ?? null,
    } as unknown as UserRepository;
    const tenants = {
        findById: async (id: string) =>
            id === TENANT ? { id: TENANT, ownerUserId: 'owner' } : null,
    } as unknown as TenantRepository;
    const roster = {
        findByOrgAndUser: async (_org: string, userId: string) =>
            roles[userId] ? { role: roles[userId] } : null,
    } as unknown as OrganizationMemberRepository;
    /** `withRoster = false`: the service as it is built where the roster is not wired. */
    const service = (withRoster = true) =>
        withRoster
            ? new OrganizationMembershipService(organizations, people, tenants, roster)
            : new OrganizationMembershipService(organizations, people);
    const statusOf = async (attempt: Promise<unknown>) => {
        try {
            await attempt;
            return 200;
        } catch (error) {
            return (error as { getStatus?: () => number }).getStatus?.() ?? 500;
        }
    };
    const ENFORCED = [
        ['unset (the default)', undefined],
        ['false', 'false'],
        ['true', 'true'],
    ] as const;
    const setEnforced = (value: string | undefined) => {
        if (value === undefined) delete process.env.ORG_ADMIN_ROLE_ENFORCED;
        else process.env.ORG_ADMIN_ROLE_ENFORCED = value;
    };

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it("another account's Organization, a missing one and a person without an account are not found", async () => {
        const membership = service();
        for (const check of ['ensureMember', 'ensureAdmin', 'ensureRoleAdmin'] as const) {
            expect(await statusOf(membership[check](ORG.id, 'outsider'))).toBe(404);
            expect(await statusOf(membership[check](ORG.id, 'new'))).toBe(404);
            expect(await statusOf(membership[check](ORG.id, 'nobody'))).toBe(404);
            expect(await statusOf(membership[check]('org-missing', 'owner'))).toBe(404);
        }
    });

    it.each(ENFORCED)(
        'with ORG_ADMIN_ROLE_ENFORCED %s: only the owner and an admin link or remove a link; every member reads',
        async (_name, value) => {
            setEnforced(value);
            const membership = service();
            for (const user of ['owner', 'admin', 'second-owner']) {
                expect(await membership.ensureRoleAdmin(ORG.id, user)).toBe(ORG);
                expect(await membership.isRoleAdmin(ORG.id, user)).toBe(true);
            }
            for (const user of ['member', 'unlisted']) {
                expect(await statusOf(membership.ensureRoleAdmin(ORG.id, user))).toBe(403);
                expect(await membership.isRoleAdmin(ORG.id, user)).toBe(false);
                // Reading stays open to them.
                expect(await membership.ensureMember(ORG.id, user)).toBe(ORG);
            }
            expect(await membership.isRoleAdmin(ORG.id, 'outsider')).toBe(false);
            expect(await membership.isRoleAdmin('org-missing', 'owner')).toBe(false);
        },
    );

    it.each(ENFORCED)(
        'with ORG_ADMIN_ROLE_ENFORCED %s: the guard of the changing routes lets the owner and an admin through, nobody else',
        async (_name, value) => {
            setEnforced(value);
            const guard = new OrganizationLinkAdminGuard(service());
            const as = (userId: string | undefined, orgId: string | undefined = ORG.id) =>
                ({
                    getType: () => 'http',
                    switchToHttp: () => ({
                        getRequest: () => ({
                            params: orgId ? { orgId } : {},
                            user: userId ? { userId } : undefined,
                        }),
                    }),
                }) as unknown as ExecutionContext;
            expect(await guard.canActivate(as('owner'))).toBe(true);
            expect(await guard.canActivate(as('admin'))).toBe(true);
            expect(await statusOf(guard.canActivate(as('member')))).toBe(403);
            expect(await statusOf(guard.canActivate(as('unlisted')))).toBe(403);
            expect(await statusOf(guard.canActivate(as('outsider')))).toBe(404);
            // No session, or no Organization in the route: not found (fail closed).
            expect(await statusOf(guard.canActivate(as(undefined)))).toBe(404);
            expect(await statusOf(guard.canActivate(as('owner', '')))).toBe(404);
        },
    );

    it('a role that cannot be checked here is refused, never assumed', async () => {
        const membership = service(false);
        expect(await statusOf(membership.ensureRoleAdmin(ORG.id, 'owner'))).toBe(403);
        expect(await membership.isRoleAdmin(ORG.id, 'owner')).toBe(false);
    });

    it('the general admin check of the other routes keeps its opt-in rule, which is why the link does not use it', async () => {
        setEnforced(undefined);
        const lenient = service();
        for (const user of ['owner', 'admin', 'member', 'unlisted']) {
            expect(await lenient.ensureAdmin(ORG.id, user)).toBe(ORG);
        }
        setEnforced('true');
        const enforced = service();
        expect(await statusOf(enforced.ensureAdmin(ORG.id, 'owner'))).toBe(200);
        expect(await statusOf(enforced.ensureAdmin(ORG.id, 'admin'))).toBe(200);
        expect(await statusOf(enforced.ensureAdmin(ORG.id, 'member'))).toBe(403);
        expect(await statusOf(enforced.ensureAdmin(ORG.id, 'outsider'))).toBe(404);
    });
});
