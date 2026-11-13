import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';

/**
 * Admits only an administrator of the Organization named in the route: the
 * account's owner, or a member whose role in the Organization is `admin` (or
 * `owner`). **Always**, whatever `ORG_ADMIN_ROLE_ENFORCED` says.
 *
 * Linking an Organization to an organization on Ever Platform decides where the
 * names and addresses of its Works may be listed, and removing a link ends what
 * the Organization turned on there. Neither is left to every member of the
 * account, which is all the general `@OrgAdmin()` check asks for while its
 * opt-in switch is off.
 *
 * Fail closed, with the answers of every `/organizations/:orgId` route: no
 * session, another account's Organization or a missing one is `404`; a member
 * of the account who is not an administrator is `403`.
 */
@Injectable()
export class OrganizationLinkAdminGuard implements CanActivate {
    constructor(private readonly membership: OrganizationMembershipService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== 'http') return true;
        const request = context.switchToHttp().getRequest<{
            params?: Record<string, string>;
            user?: { userId?: string };
        }>();
        const orgId = request.params?.orgId;
        const userId = request.user?.userId;
        if (!orgId || !userId) {
            throw new NotFoundException(`Organization ${orgId ?? ''} not found`.trimEnd());
        }
        await this.membership.ensureRoleAdmin(orgId, userId);
        return true;
    }
}
