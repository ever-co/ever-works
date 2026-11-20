import { DynamicModule, Module, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AgentsModule as AgentAgentsModule } from '@ever-works/agent/agents';
import { config } from '@ever-works/agent/config';
import { DatabaseModule } from '@ever-works/agent/database';
import { DEMO_AI_QUOTA } from '@ever-works/agent/demo';
import { GoalsModule as AgentGoalsModule } from '@ever-works/agent/goals';
import { MissionsModule as AgentMissionsModule } from '@ever-works/agent/missions';
import { KnowledgeBaseModule, WorkModule } from '@ever-works/agent/services';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { AgentTeamsModule } from '@ever-works/agent/teams';
import { DemoAiQuotaService } from './demo-ai-quota.service';
import { CaptchaVerifierService } from '../auth/services/captcha-verifier.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DemoController } from './demo.controller';
import { DemoSandboxService } from './demo-sandbox.service';
import { DemoSandboxSeederService } from './seed/demo-sandbox-seeder.service';
import { DemoErrorFilter } from './demo-error.filter';
import { DemoRestrictionsGuard } from './demo-restrictions.guard';
import { assertDemoConfig } from './demo-boot-check';

/**
 * Platform demo mode (`DEMO=true`) — the API's demo wiring (docs/specs/features/platform-demo-mode
 * §5.2). `register()` reads `DEMO` once, at module build time:
 *
 * - **Off**: an empty module. No provider, filter, guard or route: the instance is untouched.
 * - **On**: `DemoSandboxService` + `POST /api/auth/demo`, `DemoAiQuotaService`, bound to `DEMO_AI_QUOTA` for `AiFacadeService` and
 *   `PluginValidationService`, the global `DemoErrorFilter`, and the global `DemoRestrictionsGuard`
 *   (the routes `DEMO_BLOCKED_ROUTES` names answer `DEMO_DISABLED`). The module is `global`
 *   because those consumers live in modules that import nothing from the demo — and an
 *   unbound `DEMO_AI_QUOTA` on a demo instance refuses every AI call (fail closed). The
 *   Trigger workers reach the same service by name over `remote/call`
 *   (`TriggerInternalController`'s `remoteMap`). `DemoSandboxSeederService` drives the
 *   Organization, Teams, Agents, Works, Missions, Goals, Tasks and knowledge services, so
 *   their modules are imported here.
 *
 * `onModuleInit` runs the boot check either way (`assertDemoConfig` returns at once when the
 * demo is off), so a misconfigured demo instance fails to start.
 */
@Module({})
export class DemoModule implements OnModuleInit {
    static register(): DynamicModule {
        if (!config.demo.isEnabled()) {
            return { module: DemoModule };
        }
        return {
            module: DemoModule,
            global: true,
            imports: [
                DatabaseModule,
                // The sandbox seeder's domain services. All of them are already in the API's
                // graph, so these are the same module instances, not new ones.
                OrganizationsModule,
                AgentTeamsModule,
                AgentAgentsModule,
                WorkModule,
                AgentMissionsModule,
                AgentGoalsModule,
                TasksDomainModule,
                KnowledgeBaseModule,
            ],
            controllers: [DemoController],
            providers: [
                DemoAiQuotaService,
                DemoSandboxService,
                // Stateless (env-driven); provided here so the module need not import AuthModule.
                CaptchaVerifierService,
                DemoSandboxSeederService,
                { provide: DEMO_AI_QUOTA, useExisting: DemoAiQuotaService },
                { provide: APP_FILTER, useClass: DemoErrorFilter },
                // Runs after the API root's own APP_GUARDs (`AuthSessionGuard` first): Nest
                // applies global guards in module-scan order, and the root is scanned first.
                { provide: APP_GUARD, useClass: DemoRestrictionsGuard },
            ],
            exports: [DemoAiQuotaService, DEMO_AI_QUOTA],
        };
    }

    onModuleInit(): void {
        assertDemoConfig();
    }
}
