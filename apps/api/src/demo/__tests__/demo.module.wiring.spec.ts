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
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import {
    DemoGithubRepoRepository,
    UserRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { DEMO_REPO_LEDGER } from '@ever-works/agent/demo';
import { EverWorksGitProvider } from '@ever-works/agent/ever-works-providers';
import { GoalsService } from '@ever-works/agent/goals';
import { MissionsService } from '@ever-works/agent/missions';
import {
    AnonymousUserCleanupService,
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
import { DemoRepoLedgerService } from '../demo-repo-ledger.service';
import { DemoSandboxPurgeService } from '../demo-sandbox-purge.service';
import { DemoSandboxSweeperService } from '../demo-sandbox-sweeper.service';
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

/** The sandbox purge's: the Work delete path and the anonymous-user purge of `WorkModule`. */
const PURGE_DEPENDENCIES = [
    ['dataSource', DataSource],
    ['workLifecycle', WorkLifecycleService],
    ['anonymousCleanup', AnonymousUserCleanupService],
] as const;

/** The sweeper's: the expired sandboxes, the ledger, GitHub, the purge, the run lock. */
const SWEEPER_DEPENDENCIES = [
    ['users', UserRepository],
    ['ledger', DemoGithubRepoRepository],
    ['everWorksGit', EverWorksGitProvider],
    ['purger', DemoSandboxPurgeService],
    ['taskLock', DistributedTaskLockService],
] as const;

const REFUSED = new Set<unknown>(
    [...SEEDER_DEPENDENCIES, ...PURGE_DEPENDENCIES, ...SWEEPER_DEPENDENCIES].map(
        ([, type]) => type,
    ),
);

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

    it('names every constructor dependency of the sandbox purge and the sweeper', () => {
        expect(Reflect.getMetadata('design:paramtypes', DemoSandboxPurgeService)).toEqual(
            PURGE_DEPENDENCIES.map(([, type]) => type),
        );
        expect(Reflect.getMetadata('design:paramtypes', DemoSandboxSweeperService)).toEqual(
            SWEEPER_DEPENDENCIES.map(([, type]) => type),
        );
    });

    it("resolves the purge and the sweeper from DemoModule's own imports, every dependency the real service", () => {
        expect(moduleRef).toBeDefined();
        const purge = moduleRef!.get(DemoSandboxPurgeService, { strict: false });
        const sweeper = moduleRef!.get(DemoSandboxSweeperService, { strict: false });
        expect(purge).toBeInstanceOf(DemoSandboxPurgeService);
        expect(sweeper).toBeInstanceOf(DemoSandboxSweeperService);
        for (const [service, dependencies] of [
            [purge, PURGE_DEPENDENCIES],
            [sweeper, SWEEPER_DEPENDENCIES],
        ] as const) {
            const fields = service as unknown as Record<string, unknown>;
            for (const [field, type] of dependencies) {
                expect([field, fields[field] instanceof type]).toEqual([field, true]);
            }
        }
        // The sweeper's own provider records into the same ledger the module exports.
        const ledger = moduleRef!.get(DEMO_REPO_LEDGER, { strict: false });
        expect(ledger).toBeInstanceOf(DemoRepoLedgerService);
        expect(
            (sweeper as unknown as { everWorksGit: { ledger?: unknown } }).everWorksGit.ledger,
        ).toBe(ledger);
    });
});
