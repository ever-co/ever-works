import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
    DatabaseModule,
    DemoUsageCounterRepository,
    ENTITIES,
    UserRepository,
} from '@ever-works/agent/database';
import { DemoUsageCounter, User } from '@ever-works/agent/entities';
import { DEMO_AI_QUOTA, type DemoAiQuotaPort } from '@ever-works/agent/demo';
import { DemoModule } from '../demo.module';
import { DemoAiQuotaService } from '../demo-ai-quota.service';
import { DemoController } from '../demo.controller';
import { DemoErrorFilter } from '../demo-error.filter';

/**
 * Platform demo mode — `DemoModule.register()` against a REAL Nest container.
 *
 * On a demo instance the AI facade refuses every call unless `DEMO_AI_QUOTA`
 * is bound (ruling R10), and the facade is constructed in modules that import
 * nothing from the demo. So the binding must be GLOBAL: a consumer in an
 * unrelated module, injecting the token exactly as `AiFacadeService` does,
 * has to receive the DB-backed service. With `DEMO` off the module is empty.
 */

/** Injects the token the way `AiFacadeService` and `PluginValidationService` do. */
@Injectable()
class QuotaConsumer {
    constructor(@Optional() @Inject(DEMO_AI_QUOTA) readonly quota?: DemoAiQuotaPort) {}
}

/** A module that imports nothing from the demo, like the agent `FacadesModule`. */
@Module({ providers: [QuotaConsumer] })
class UnrelatedModule {}

/** `DatabaseModule`, reduced to the two repositories the quota reads, on in-memory SQLite. */
@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        }),
        TypeOrmModule.forFeature([DemoUsageCounter, User]),
    ],
    providers: [DemoUsageCounterRepository, UserRepository],
    exports: [DemoUsageCounterRepository, UserRepository],
})
class InMemoryDatabaseModule {}

const ENV_KEYS = [
    'DEMO',
    'DEMO_GITHUB_ORG',
    'STORAGE_EVER_WORKS_GIT_ENABLED',
    'EVER_WORKS_CUSTOMERS_GITHUB_ORG',
];

describe('DemoModule', () => {
    const saved: Record<string, string | undefined> = {};
    let moduleRef: TestingModule | undefined;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(async () => {
        await moduleRef?.close();
        moduleRef = undefined;
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    async function compile(): Promise<TestingModule> {
        moduleRef = await Test.createTestingModule({
            imports: [DemoModule.register(), UnrelatedModule],
        })
            .overrideModule(DatabaseModule)
            .useModule(InMemoryDatabaseModule)
            .compile();
        return moduleRef;
    }

    describe('with DEMO off', () => {
        it('registers nothing: no provider, no filter, not global', () => {
            const dynamic = DemoModule.register();

            expect(dynamic.module).toBe(DemoModule);
            expect(dynamic.providers ?? []).toEqual([]);
            expect(dynamic.imports ?? []).toEqual([]);
            expect(dynamic.exports ?? []).toEqual([]);
            expect(dynamic.controllers ?? []).toEqual([]);
            expect(dynamic.global).not.toBe(true);
        });

        it('leaves DEMO_AI_QUOTA unbound for every consumer', async () => {
            const ref = await compile();
            await ref.init();

            expect(ref.get(QuotaConsumer, { strict: false }).quota).toBeUndefined();
        });
    });

    describe('with DEMO on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
        });

        it('binds DEMO_AI_QUOTA globally to the DB-backed service', async () => {
            const ref = await compile();
            await ref.init();

            const service = ref.get(DemoAiQuotaService, { strict: false });
            expect(service).toBeInstanceOf(DemoAiQuotaService);
            expect(ref.get(DEMO_AI_QUOTA, { strict: false })).toBe(service);
            // A module that imports nothing from the demo still receives it.
            expect(ref.get(QuotaConsumer, { strict: false }).quota).toBe(service);
        });

        it('counts a call in the real usage-counter table', async () => {
            const ref = await compile();
            await ref.init();
            const users = ref.get<Repository<User>>(getRepositoryToken(User), { strict: false });
            const sandbox = await users.save(
                users.create({
                    username: 'demo-0a1b2c3d',
                    slug: 'demo-0a1b2c3d',
                    isAnonymous: true,
                    registrationProvider: 'demo',
                    anonymousExpiresAt: new Date('2026-11-21T08:00:00.000Z'),
                } as Partial<User>),
            );

            await ref
                .get(DemoAiQuotaService, { strict: false })
                .consume(sandbox.id, new Date('2026-11-20T08:30:10.000Z'));

            const rows = await ref
                .get<Repository<DemoUsageCounter>>(getRepositoryToken(DemoUsageCounter), {
                    strict: false,
                })
                .find({ order: { key: 'ASC' } });
            expect(rows.map((row) => [row.key, row.count])).toEqual([
                ['ai:day:2026-11-20', 1],
                ['ai:min:2026-11-20T08:30', 1],
                [`ai:sandbox:${sandbox.id}`, 1],
            ]);
        });

        it('registers DemoErrorFilter as a global filter', () => {
            const providers = DemoModule.register().providers ?? [];

            expect(providers).toContainEqual({ provide: APP_FILTER, useClass: DemoErrorFilter });
        });

        it('registers the POST /api/auth/demo controller', () => {
            expect(DemoModule.register().controllers).toEqual([DemoController]);
        });

        it('refuses to start when the demo org does not match the git org', async () => {
            process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
            process.env.DEMO_GITHUB_ORG = 'ever-works-demo';
            process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = 'ever-works-cloud';
            const ref = await compile();

            await expect(ref.init()).rejects.toThrow(/DEMO_GITHUB_ORG/);
            // `close()` awaits the failed initialisation and rethrows it; that is expected here.
            moduleRef = undefined;
            await ref.close().catch(() => undefined);
        });
    });
});
