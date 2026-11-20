import { Module } from '@nestjs/common';
import {
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    PromptFacadeService,
    CodeEditFacadeService,
} from '@ever-works/agent/facades';
import {
    AuthAccountRepository,
    WorkRepository,
    GitHubAppInstallationRepository,
} from '@ever-works/agent/database';
import { config } from '@ever-works/agent/config';
import { DEMO_AI_QUOTA, DEMO_REPO_LEDGER } from '@ever-works/agent/demo';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';

const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    PromptFacadeService,
    CodeEditFacadeService,
];

/**
 * Facades module for Trigger.dev context.
 *
 * Repositories that the facades depend on are proxied to the API
 * (`createRemoteProxy`). `AuthAccountRepository.isAccessTokenExpired`
 * runs locally because it has no DB side and is called in hot paths.
 *
 * `WorkRepository` and `GitHubAppInstallationRepository` are required by
 * `GitFacadeService` (`findById` + `findByInstallationId` for GitHub App
 * installation token lookups). They must be provided IN THIS module so
 * the DI container can resolve them when GitFacadeService is instantiated
 * here — providing them only in the outer `TriggerWorkerModule` doesn't
 * satisfy the scope.
 */
@Module({
    imports: [TriggerInternalModule],
    providers: [
        ...FACADES,
        {
            provide: AuthAccountRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AuthAccountRepository', {
                    isAccessTokenExpired(account: { accessTokenExpiresAt?: Date | string | null }) {
                        if (!account.accessTokenExpiresAt) return false;
                        return new Date() > new Date(account.accessTokenExpiresAt);
                    },
                }),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: WorkRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: GitHubAppInstallationRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'GitHubAppInstallationRepository'),
            inject: [TriggerInternalApiClient],
        },
        // Platform demo mode — `AiFacadeService` (above) counts every AI call against the
        // demo quota and, on a demo instance, refuses all of them while this token is
        // unbound. A worker owns no database, so the counters are the API's
        // `DemoAiQuotaService`, reached by name; its refusals come back as `DemoError`s
        // (`../demo-remote-error.ts`). With `DEMO` off the factory binds nothing.
        {
            provide: DEMO_AI_QUOTA,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                config.demo.isEnabled()
                    ? createRemoteProxy(apiClient, 'DemoAiQuotaService')
                    : undefined,
            inject: [TriggerInternalApiClient],
        },
        // Platform demo mode — `GitFacadeService` (above) records every repository it creates
        // on a demo instance in the demo repository ledger (the website repository generation
        // makes here), and refuses to create one while this token is unbound: an unledgered
        // repository could never be swept. The ledger is the API's `DemoRepoLedgerService`,
        // reached by name (its `record` only). With `DEMO` off the factory binds nothing.
        {
            provide: DEMO_REPO_LEDGER,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                config.demo.isEnabled()
                    ? createRemoteProxy(apiClient, 'DemoRepoLedgerService')
                    : undefined,
            inject: [TriggerInternalApiClient],
        },
    ],
    exports: FACADES,
})
export class TriggerFacadesModule {}
