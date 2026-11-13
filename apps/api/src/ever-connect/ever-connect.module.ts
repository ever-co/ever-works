import { Module, type Type } from '@nestjs/common';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { DatabaseModule } from '@ever-works/agent/database';
import { EverInstanceModule } from '@ever-works/agent/ever-instance';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { SessionOnlyGuard } from '../auth/guards/session-only.guard';
import { EVER_CONNECT_CONFIG, readEverConnectConfig } from './ever-connect.config';
import { EverConnectAdminController } from './ever-connect-admin.controller';
import { EverConnectExtensions } from './ever-connect-extensions';
import { EverConnectFeedService } from './ever-connect-feed.service';
import { EverConnectIntegrationService } from './ever-connect-integration.service';
import { EverConnectKeyService } from './ever-connect-key.service';
import { EverConnectLeaseService } from './ever-connect-lease.service';
import { EverConnectOutboxService, EverConnectOutboxWorker } from './ever-connect-outbox.service';
import { EverConnectRunner } from './ever-connect.runner';
import { EverConnectEntitlementService } from './entitlements/ever-connect-entitlement.service';
import { EverConnectHeartbeatService } from './heartbeat/ever-connect-heartbeat.service';
import { EverConnectService } from './ever-connect.service';
import {
    EVER_CONNECT_PLATFORM,
    EVER_CONNECT_REPORT_QUEUE,
    EVER_ID_LOGIN_INTEGRATION,
} from './identity/ever-connect-identity.ports';
import { EverIdClientSettings } from './identity/ever-id-client.settings';
import { EverIdLoginHandler } from './identity/ever-id-login.handler';
import { PersonLinkReporter } from './identity/person-link.reporter';
import { PersonRequestsHandler } from './identity/person-requests.handler';
import { InstallApprovalService } from './installs/install-approval.service';
import { InstallRequestService } from './installs/install-request.service';
import { InstallRequestsController } from './installs/install-requests.controller';
import { InstallRequestsIntegration } from './installs/install-requests.integration';
import { InstallStatusReporter } from './installs/install-status-reporter.service';
import { PluginInstallerBridge } from './installs/plugin-installer.bridge';
import { IntegrationHandlerRegistry } from './integrations/integration-handler.registry';
import {
    EVER_CONNECT_ADDRESS_CHECK,
    EverConnectWellKnownController,
    NoEverConnectAddressCheck,
} from './well-known.controller';

/**
 * Ever Connect: an installation's connection to Ever Platform.
 *
 * - The connection ({@link EverConnectService}): connect with an `EVC-…` code
 *   (from the operator, or once from `EVER_CONNECT_CODE`), disconnect, and the
 *   SDK client that authenticates with the installation's own token (signed
 *   with the connect key, kept in memory).
 * - Integration states ({@link EverConnectIntegrationService}), as Ever Platform
 *   reports them, with the administrator's accept for installation-wide ones.
 * - The feed ({@link EverConnectFeedService}) and the report outbox
 *   ({@link EverConnectOutboxWorker}), run by {@link EverConnectRunner} on the
 *   replica holding the Ever Connect lease.
 * - Sign in with Ever ID ({@link EverIdLoginHandler}): the installation's own
 *   sign-in client, offered to the Ever ID sign-in plugin; which accounts are
 *   linked to an Ever ID ({@link PersonLinkReporter}); answers to people's
 *   deletion and export requests ({@link PersonRequestsHandler}).
 * - `GET /.well-known/ever-connect`: the address statement during a check
 *   (none is ever pending yet: 404).
 * - Install requests from apps.ever.co (`marketplace_installs`,
 *   {@link InstallRequestsIntegration}): a request on the feed is kept and
 *   shown to the platform admins; it installs nothing until one of them
 *   approves it in their own session, which runs the dynamic plugin installer
 *   ({@link InstallApprovalService}); the outcome is reported to Ever Platform
 *   ({@link InstallStatusReporter}).
 *
 * - Switched on separately, each off by default (`ever-connect.switches.ts`):
 *   the heartbeat ({@link EverConnectHeartbeatService}) and the entitlement
 *   documents ({@link EverConnectEntitlementService}) here; linking an
 *   Organization with a link code and the apps mirror in modules of their own
 *   (`links/`, `app-sync/`), which join the feed and the worker's round through
 *   {@link EverConnectExtensions}.
 *
 * Imported only with `EVER_CONNECT_ENABLED=true` ({@link everConnectModuleImports}).
 */
@Module({
    imports: [DatabaseModule, ActivityLogModule, EverInstanceModule],
    controllers: [
        EverConnectAdminController,
        EverConnectWellKnownController,
        InstallRequestsController,
    ],
    providers: [
        { provide: EVER_CONNECT_CONFIG, useFactory: () => readEverConnectConfig(process.env) },
        IsPlatformAdminGuard,
        SessionOnlyGuard,
        EverConnectKeyService,
        EverConnectService,
        EverConnectExtensions,
        EverConnectIntegrationService,
        EverConnectLeaseService,
        EverConnectOutboxService,
        EverConnectOutboxWorker,
        EverConnectFeedService,
        EverConnectRunner,
        { provide: EVER_CONNECT_PLATFORM, useExisting: EverConnectService },
        { provide: EVER_ID_LOGIN_INTEGRATION, useExisting: EverConnectIntegrationService },
        { provide: EVER_CONNECT_REPORT_QUEUE, useExisting: EverConnectOutboxService },
        { provide: EVER_CONNECT_ADDRESS_CHECK, useClass: NoEverConnectAddressCheck },
        EverIdClientSettings,
        PersonLinkReporter,
        EverIdLoginHandler,
        PersonRequestsHandler,
        IntegrationHandlerRegistry,
        PluginInstallerBridge,
        InstallRequestService,
        InstallStatusReporter,
        InstallApprovalService,
        InstallRequestsIntegration,
        // Each does nothing unless its own switch is on (`ever-connect.switches.ts`).
        EverConnectHeartbeatService,
        EverConnectEntitlementService,
    ],
    exports: [
        EverConnectService,
        EverIdLoginHandler,
        PersonRequestsHandler,
        EverConnectLeaseService,
        EVER_CONNECT_CONFIG,
        EverConnectExtensions,
        EverConnectIntegrationService,
        EverConnectEntitlementService,
        IntegrationHandlerRegistry,
    ],
})
export class EverConnectModule {}

/** Whether the Ever Connect module is switched on: `EVER_CONNECT_ENABLED=true`, nothing else. */
export function isEverConnectEnabled(
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    return env.EVER_CONNECT_ENABLED?.trim().toLowerCase() === 'true';
}

/**
 * What `ApiModule` imports for Ever Connect: `[EverConnectModule]` when
 * `EVER_CONNECT_ENABLED=true`; otherwise — by default — NOTHING: no route
 * (`/api/ever-connect/*` and `/.well-known/ever-connect` answer 404 like any
 * unknown address), no listener, no timer, no client object.
 */
export function everConnectModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isEverConnectEnabled(env) ? [EverConnectModule] : [];
}
