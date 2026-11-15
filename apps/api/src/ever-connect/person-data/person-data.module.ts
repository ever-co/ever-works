import { Module, type Type } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { SessionOnlyGuard } from '../../auth/guards/session-only.guard';
import { EverConnectModule } from '../ever-connect.module';
import { isPersonExportEnabled } from '../ever-connect.switches';
import { PersonDataExportBuilder } from './person-data-export.builder';
import { PersonDataExportController } from './person-data-export.controller';
import { PersonDataParticipantService } from './person-data.participant';

/**
 * Ever Works' part in people's export requests from Ever Platform
 * ({@link PersonDataParticipantService}). A module of its own so that, switched
 * off, nothing of it exists: imported only with
 * `EVER_CONNECT_PERSON_EXPORT_ENABLED=true` on an installation with Ever Connect
 * on ({@link everConnectPersonDataModuleImports}).
 */
@Module({
    imports: [DatabaseModule, EverConnectModule],
    controllers: [PersonDataExportController],
    providers: [SessionOnlyGuard, PersonDataExportBuilder, PersonDataParticipantService],
    exports: [PersonDataParticipantService],
})
export class EverConnectPersonDataModule {}

/**
 * What `ApiModule` imports for this: the module when switched on; otherwise, by
 * default, NOTHING: no route, no participant, and the answers to people's
 * requests stay what they were.
 */
export function everConnectPersonDataModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isPersonExportEnabled(env) ? [EverConnectPersonDataModule] : [];
}
