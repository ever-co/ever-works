import { Module, type Type } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { OrganizationsModule } from '../../organizations/organizations.module';
import { EverConnectModule } from '../ever-connect.module';
import { isMembershipSyncEnabled } from '../ever-connect.switches';
import { EverConnectMembershipResyncService } from './membership-resync.service';
import { EverConnectMembershipSyncService } from './membership-sync.service';

/**
 * The membership sync: the membership changes Ever Platform sends for a linked
 * organization, applied to its Organization here
 * ({@link EverConnectMembershipSyncService}), and the resync that reads the
 * current members again after the feed lost changes
 * ({@link EverConnectMembershipResyncService}). A module of its own because it
 * needs the Organization's membership code, which the Ever Connect core has no
 * reason to load; imported only with `EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED=true`
 * on an installation with Ever Connect on
 * ({@link everConnectMembershipSyncModuleImports}).
 */
@Module({
    imports: [DatabaseModule, EverConnectModule, OrganizationsModule],
    providers: [EverConnectMembershipSyncService, EverConnectMembershipResyncService],
})
export class EverConnectMembershipSyncModule {}

/**
 * What `ApiModule` imports for this: the module when switched on; otherwise, by
 * default, NOTHING: the feed reads past membership changes and no membership
 * changes.
 */
export function everConnectMembershipSyncModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isMembershipSyncEnabled(env) ? [EverConnectMembershipSyncModule] : [];
}
