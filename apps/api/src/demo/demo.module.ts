import { DynamicModule, Module, OnModuleInit } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { config } from '@ever-works/agent/config';
import { DatabaseModule } from '@ever-works/agent/database';
import { DEMO_AI_QUOTA } from '@ever-works/agent/demo';
import { DemoAiQuotaService } from './demo-ai-quota.service';
import { CaptchaVerifierService } from '../auth/services/captcha-verifier.service';
import { DemoController } from './demo.controller';
import { DemoSandboxService } from './demo-sandbox.service';
import { DemoSandboxSeederService } from './seed/demo-sandbox-seeder.service';
import { DemoErrorFilter } from './demo-error.filter';
import { assertDemoConfig } from './demo-boot-check';

/**
 * Platform demo mode (`DEMO=true`) — the API's demo wiring (docs/specs/features/platform-demo-mode
 * §5.2). `register()` reads `DEMO` once, at module build time:
 *
 * - **Off**: an empty module. No provider, no filter, no route: the instance is untouched.
 * - **On**: `DemoSandboxService` + `POST /api/auth/demo`, `DemoAiQuotaService`, bound to `DEMO_AI_QUOTA` for `AiFacadeService` and
 *   `PluginValidationService`, and the global `DemoErrorFilter`. The module is `global`
 *   because those consumers live in modules that import nothing from the demo — and an
 *   unbound `DEMO_AI_QUOTA` on a demo instance refuses every AI call (fail closed). The
 *   Trigger workers reach the same service by name over `remote/call`
 *   (`TriggerInternalController`'s `remoteMap`).
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
            imports: [DatabaseModule],
            controllers: [DemoController],
            providers: [
                DemoAiQuotaService,
                DemoSandboxService,
                // Stateless (env-driven); provided here so the module need not import AuthModule.
                CaptchaVerifierService,
                DemoSandboxSeederService,
                { provide: DEMO_AI_QUOTA, useExisting: DemoAiQuotaService },
                { provide: APP_FILTER, useClass: DemoErrorFilter },
            ],
            exports: [DemoAiQuotaService, DEMO_AI_QUOTA],
        };
    }

    onModuleInit(): void {
        assertDemoConfig();
    }
}
