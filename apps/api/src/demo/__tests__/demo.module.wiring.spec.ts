/**
 * The agent's `@src/notifications` imports resolve to the API's notifications files under api
 * Jest, which reach better-auth's ESM through this one file. Nothing here builds an auth runtime.
 */
jest.mock('../../auth/providers/auth-runtime.instance', () => ({
    createAuthRuntimeInstance: jest.fn(),
}));

import { GLOBAL_MODULE_METADATA } from '@nestjs/common/constants';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MailerService as MailerLibraryService } from '@nestjs-modules/mailer';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { OnboardingRoleSeedingService } from '@ever-works/agent/agents';
import { UserRepository, WorkRepository } from '@ever-works/agent/database';
import { GoalsService } from '@ever-works/agent/goals';
import { MissionsService } from '@ever-works/agent/missions';
import {
    KnowledgeBaseBufferExtractorService,
    KnowledgeBaseService,
    WorkLifecycleService,
} from '@ever-works/agent/services';
import { TaskChatService, TasksService } from '@ever-works/agent/tasks-domain';
import { TeamsService } from '@ever-works/agent/teams';
import { OrganizationService } from '../../organizations/organization.service';
import { ScopeContextService } from '../../scope/scope-context.service';
import { ScopeModule } from '../../scope/scope.module';
import { DemoModule } from '../demo.module';
import { DemoSandboxSeederService } from '../seed/demo-sandbox-seeder.service';

/**
 * Platform demo mode — `DemoModule.register()` with `DEMO` on, against its REAL imports
 * (`OrganizationsModule`, the agent Teams / Agents / Work / Missions / Goals / Tasks /
 * Knowledge modules, `DatabaseModule` on in-memory SQLite).
 *
 * `DemoModule` provides `DemoSandboxSeederService` itself, so every one of the seeder's
 * dependencies must come from what `DemoModule` imports — or from a global module of the
 * API root: only `ScopeModule` (`@Global()`, imported by `ApiModule`), for
 * `ScopeContextService`. The container below gets exactly that: `ScopeModule`, an event
 * emitter (also an API-root import), and `DemoModule.register()`.
 *
 * The rest of the graph needs things only the full API root provides (plugin registry,
 * config, mailer, …). Those come from `useMocker` as inert stubs — EXCEPT the seeder's
 * dependencies, which the mocker refuses: a dependency `DemoModule` cannot reach fails the
 * compile with Nest's own "can't resolve dependencies" error instead of being stubbed.
 */

/** The seeder's constructor dependencies, in parameter order, by field name. */
const SEEDER_DEPENDENCIES = [
    ['organizations', OrganizationService],
    ['scopeContext', ScopeContextService],
    ['users', UserRepository],
    ['works', WorkRepository],
    ['teams', TeamsService],
    ['starterKit', OnboardingRoleSeedingService],
    ['workLifecycle', WorkLifecycleService],
    ['missions', MissionsService],
    ['goals', GoalsService],
    ['tasks', TasksService],
    ['taskChat', TaskChatService],
    ['knowledge', KnowledgeBaseService],
    // The recorded examples' plain rows; from `DatabaseModule`'s TypeORM connection.
    ['dataSource', DataSource],
] as const;

const REFUSED = new Set<unknown>(SEEDER_DEPENDENCIES.map(([, type]) => type));

/** An object that answers every method with `undefined` (never thenable, no lifecycle hooks). */
function inertStub(): object {
    return new Proxy(
        {},
        {
            get: (_target, prop) =>
                typeof prop === 'symbol' || prop === 'then' || /^(on|before)[A-Z]/.test(prop)
                    ? undefined
                    : () => undefined,
        },
    );
}

const ENV_KEYS = ['DEMO', 'EVER_WORKS_PROJECT_WORKS_ENABLED'] as const;

describe('DemoModule wiring (DEMO on, real domain modules)', () => {
    const saved: Record<string, string | undefined> = {};
    let moduleRef: TestingModule | undefined;

    beforeAll(() => {
        for (const key of ENV_KEYS) saved[key] = process.env[key];
        process.env.DEMO = 'true';
        process.env.EVER_WORKS_PROJECT_WORKS_ENABLED = 'true';
    });

    afterAll(async () => {
        await moduleRef?.close();
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('names every constructor dependency of the seeder', () => {
        const paramTypes = Reflect.getMetadata('design:paramtypes', DemoSandboxSeederService);
        expect(paramTypes).toEqual(SEEDER_DEPENDENCIES.map(([, type]) => type));
    });

    it('gets ScopeContextService only from the global ScopeModule the API root imports', () => {
        expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, ScopeModule)).toBe(true);
    });

    it("resolves the seeder from DemoModule's own imports, every dependency the real service", async () => {
        moduleRef = await Test.createTestingModule({
            imports: [ScopeModule, EventEmitterModule.forRoot(), DemoModule.register()],
        })
            .useMocker((token) => (REFUSED.has(token) ? undefined : inertStub()))
            // Its constructor builds a turndown converter, whose CommonJS default export is not
            // constructible under api Jest; it is not one of the seeder's dependencies.
            .overrideProvider(KnowledgeBaseBufferExtractorService)
            .useValue(inertStub())
            // Builds an SMTP transport from options the API root config supplies.
            .overrideProvider(MailerLibraryService)
            .useValue(inertStub())
            .compile();

        const seeder = moduleRef.get(DemoSandboxSeederService, { strict: false });
        expect(seeder).toBeInstanceOf(DemoSandboxSeederService);
        const fields = seeder as unknown as Record<string, unknown>;
        for (const [field, type] of SEEDER_DEPENDENCIES) {
            expect([field, fields[field] instanceof type]).toEqual([field, true]);
        }
    });
});
