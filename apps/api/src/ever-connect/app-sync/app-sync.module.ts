import { Module, type Type } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { EverConnectModule } from '../ever-connect.module';
import { isAppSyncEnabled } from '../ever-connect.switches';
import { AppSyncListener } from './app-sync.listener';
import { AppSyncService } from './app-sync.service';

/**
 * The apps mirror (`app_sync`): the identifiers and status of a linked
 * Organization's Works and deployments, sent to Ever Platform. A module of its
 * own so that, switched off, none of its listeners exists; imported only with
 * `EVER_CONNECT_APP_SYNC_ENABLED=true` on an installation with Ever Connect on
 * ({@link everConnectAppSyncModuleImports}).
 */
@Module({
    imports: [DatabaseModule, EverConnectModule],
    providers: [AppSyncService, AppSyncListener],
    exports: [AppSyncService],
})
export class EverConnectAppSyncModule {}

/**
 * What `ApiModule` imports for this: the module when switched on; otherwise, by
 * default, NOTHING: no listener, no outbox row, no request.
 */
export function everConnectAppSyncModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isAppSyncEnabled(env) ? [EverConnectAppSyncModule] : [];
}
