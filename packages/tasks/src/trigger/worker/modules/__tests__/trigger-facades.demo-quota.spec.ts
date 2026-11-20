import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Module, type INestApplicationContext, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import superjson from 'superjson';
import { AiFacadeService } from '@ever-works/agent/facades';
import { DEMO_AI_QUOTA, type DemoAiQuotaPort } from '@ever-works/agent/demo';
import { TriggerFacadesModule } from '../trigger-facades.module';
import { TriggerInternalApiClient } from '../../services/trigger-internal-api.client';

/**
 * Platform demo mode — the worker's `DEMO_AI_QUOTA`.
 *
 * On a demo instance `AiFacadeService` refuses every AI call when the token is
 * unbound (ruling R10), and in a Trigger worker the facade is provided by
 * `TriggerFacadesModule`. So THAT module must bind the token, to a remote proxy of
 * the API's `DemoAiQuotaService` (a worker owns no database). With `DEMO` off it
 * binds nothing the facade could call.
 *
 * Booting the whole module pulls the plugin registry and every facade's graph, so,
 * like `trigger-internal.module.spec.ts`, this reads the REAL decorated provider off
 * the module and lets a real Nest container resolve it beside a stub API client.
 */

interface FactoryProviderEntry {
    provide?: unknown;
    useFactory?: (...deps: unknown[]) => unknown;
    inject?: unknown[];
}

function moduleProviders(): unknown[] {
    return (Reflect.getMetadata('providers', TriggerFacadesModule) as unknown[]) ?? [];
}

function quotaProvider(): FactoryProviderEntry {
    const entry = moduleProviders().find(
        (candidate) => (candidate as FactoryProviderEntry)?.provide === DEMO_AI_QUOTA,
    ) as FactoryProviderEntry | undefined;
    expect(entry, 'TriggerFacadesModule registers no DEMO_AI_QUOTA provider').toBeDefined();
    return entry as FactoryProviderEntry;
}

/** Resolves the token as the facade does: optional, from the module that declares it. */
async function resolveInHarness(callRemote: ReturnType<typeof vi.fn>): Promise<{
    context: INestApplicationContext;
    quota: DemoAiQuotaPort | undefined;
}> {
    class Harness {}
    Module({
        providers: [
            quotaProvider() as Provider,
            { provide: TriggerInternalApiClient, useValue: { callRemote } },
            {
                provide: 'QUOTA_CONSUMER',
                useFactory: (quota?: DemoAiQuotaPort) => ({ quota }),
                inject: [{ token: DEMO_AI_QUOTA, optional: true }],
            },
        ],
    })(Harness);

    const context = await NestFactory.createApplicationContext(Harness, { logger: false });
    return { context, quota: context.get<{ quota?: DemoAiQuotaPort }>('QUOTA_CONSUMER').quota };
}

describe('TriggerFacadesModule — DEMO_AI_QUOTA', () => {
    const savedDemo = process.env.DEMO;
    let context: INestApplicationContext | undefined;
    let callRemote: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        delete process.env.DEMO;
        callRemote = vi.fn(async () => undefined);
    });

    afterEach(async () => {
        await context?.close();
        context = undefined;
        if (savedDemo === undefined) delete process.env.DEMO;
        else process.env.DEMO = savedDemo;
    });

    it('declares the token beside AiFacadeService, built from the API client', () => {
        const entry = quotaProvider();

        expect(moduleProviders()).toContain(AiFacadeService);
        expect(typeof entry.useFactory).toBe('function');
        expect(entry.inject).toEqual([TriggerInternalApiClient]);
    });

    it('with DEMO on, resolves to a proxy of the API DemoAiQuotaService', async () => {
        process.env.DEMO = 'true';
        const resolved = await resolveInHarness(callRemote);
        context = resolved.context;

        expect(resolved.quota).toBeDefined();
        await resolved.quota!.consume('user-1');

        expect(callRemote).toHaveBeenCalledTimes(1);
        const [name, method, args] = callRemote.mock.calls[0];
        expect(name).toBe('DemoAiQuotaService');
        expect(method).toBe('consume');
        expect(superjson.deserialize(args as never)).toEqual(['user-1']);
    });

    it('with DEMO off, binds nothing the facade could call', async () => {
        const resolved = await resolveInHarness(callRemote);
        context = resolved.context;

        expect(resolved.quota).toBeUndefined();
        expect(callRemote).not.toHaveBeenCalled();
    });
});
