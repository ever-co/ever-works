import { Module, type Type } from '@nestjs/common';
import { AppDeployRequestModule } from '@ever-works/agent/app-runtime';
import { AppWorksModule as AgentAppWorksModule } from '@ever-works/agent/app-works';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { IntegrationsApiFoundationModule } from '@ever-works/agent/integrations-api';
import { WorkModule } from '@ever-works/agent/services';
import { DelegatedPrincipalGuard } from '../../auth/guards/delegated-principal.guard';
import { OrganizationsModule } from '../../organizations/organizations.module';
import { AppsCatalogManifestService } from '../../works/apps-catalog-manifest.service';
import { EverConnectModule } from '../ever-connect.module';
import { isAppsWriteEnabled } from '../ever-connect.switches';
import { EverConnectAppsController } from './ever-connect-apps.controller';
import { EverConnectAppsService } from './ever-connect-apps.service';

/**
 * Creating an App, and starting a deployment of one, for a person another Ever
 * app acts for. A module of its own because it composes the Organization, Work,
 * App and deploy services, which the Ever Connect core has no reason to load;
 * imported only with `EVER_CONNECT_APPS_WRITE_ENABLED=true` on an installation
 * with Ever Connect on ({@link everConnectAppsModuleImports}).
 *
 * It brings no rule of its own about Apps: the Work services
 * (`WorkModule`), the App source inspection (`AppWorksModule`) and the deploy
 * request (`AppDeployRequestModule`) are the same static modules the session
 * routes use, so both read one answer. The Apps catalog reader is provided here
 * as well as in the API's Works module: it holds nothing but a cache of the
 * catalog's public listing. The `Idempotency-Key` store is the one of the
 * integration API, keyed here by the person.
 */
@Module({
    imports: [
        DatabaseModule,
        EverConnectModule,
        OrganizationsModule,
        FacadesModule,
        WorkModule,
        AgentAppWorksModule,
        AppDeployRequestModule,
        IntegrationsApiFoundationModule,
    ],
    controllers: [EverConnectAppsController],
    providers: [DelegatedPrincipalGuard, AppsCatalogManifestService, EverConnectAppsService],
})
export class EverConnectAppsModule {}

/**
 * What `ApiModule` imports for this: the module when switched on; otherwise, by
 * default, NOTHING: every route answers 404 like any unknown address, and no
 * listener or timer exists.
 */
export function everConnectAppsModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isAppsWriteEnabled(env) ? [EverConnectAppsModule] : [];
}
