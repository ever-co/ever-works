import { Module, type Type } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { AccountDeletionModule } from '../../account-deletion/account-deletion.module';
import { EverConnectModule } from '../ever-connect.module';
import { isPersonDeletionEnabled } from '../ever-connect.switches';
import { PersonDeletionParticipantService } from './person-deletion.participant';

/**
 * Ever Works' part in people's deletion requests from Ever Platform
 * ({@link PersonDeletionParticipantService}), through the account deletion of
 * Settings → Danger Zone. A module of its own, apart from the export, so that
 * nothing can delete an account unless this switch is on: imported only with
 * `EVER_CONNECT_PERSON_DELETION_ENABLED=true` on an installation with Ever
 * Connect on ({@link everConnectPersonDeletionModuleImports}).
 */
@Module({
    imports: [DatabaseModule, EverConnectModule, AccountDeletionModule],
    providers: [PersonDeletionParticipantService],
})
export class EverConnectPersonDeletionModule {}

/**
 * What `ApiModule` imports for this: the module when switched on; otherwise, by
 * default, NOTHING, and a deletion request removes the connected identities
 * only, as it always did.
 */
export function everConnectPersonDeletionModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isPersonDeletionEnabled(env) ? [EverConnectPersonDeletionModule] : [];
}
