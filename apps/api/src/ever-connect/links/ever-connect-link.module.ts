import { Module, type Type } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { SessionOnlyGuard } from '../../auth/guards/session-only.guard';
import { OrganizationsModule } from '../../organizations/organizations.module';
import { EverConnectModule } from '../ever-connect.module';
import { isLinkCodesEnabled } from '../ever-connect.switches';
import { EverConnectLinkController } from './ever-connect-link.controller';
import { EverConnectLinkService } from './ever-connect-link.service';
import { OrganizationLinkAdminGuard } from './organization-link-admin.guard';

/**
 * Linking an Organization to its Ever organization with a link code. A module
 * of its own because it needs the Organization guards, which the Ever Connect
 * core has no reason to load; imported only with
 * `EVER_CONNECT_LINK_CODES_ENABLED=true` on an installation with Ever Connect
 * on ({@link everConnectLinkModuleImports}).
 */
@Module({
    imports: [DatabaseModule, EverConnectModule, OrganizationsModule],
    controllers: [EverConnectLinkController],
    providers: [SessionOnlyGuard, OrganizationLinkAdminGuard, EverConnectLinkService],
    exports: [EverConnectLinkService],
})
export class EverConnectLinkModule {}

/**
 * What `ApiModule` imports for this: the module when switched on; otherwise, by
 * default, NOTHING: every route answers 404 like any unknown address, and no
 * listener exists.
 */
export function everConnectLinkModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isLinkCodesEnabled(env) ? [EverConnectLinkModule] : [];
}
