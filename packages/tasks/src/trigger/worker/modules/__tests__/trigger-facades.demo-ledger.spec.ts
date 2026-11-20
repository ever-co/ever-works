import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Module, type INestApplicationContext, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import superjson from 'superjson';
import { GitFacadeService } from '@ever-works/agent/facades';
import { DEMO_REPO_LEDGER, type DemoRepoLedgerPort } from '@ever-works/agent/demo';
import { TriggerFacadesModule } from '../trigger-facades.module';
import { TriggerInternalApiClient } from '../../services/trigger-internal-api.client';

/**
 * Platform demo mode — the worker's `DEMO_REPO_LEDGER` (ruling R22).
 *
 * Generation runs in Trigger workers on the demo, and there `GitFacadeService` (provided by
 * `TriggerFacadesModule`) creates the Work's website repository. On a demo instance it
 * refuses every repository create while the token is unbound, so THAT module must bind it, to
 * a remote proxy of the API's `DemoRepoLedgerService` (a worker owns no database). With `DEMO`
 * off it binds nothing.
 *
 * Like `trigger-facades.demo-quota.spec.ts`, this reads the REAL decorated provider off the
 * module and lets a real Nest container resolve it beside a stub API client.
 */

interface FactoryProviderEntry {
    provide?: unknown;
    useFactory?: (...deps: unknown[]) => unknown;
    inject?: unknown[];
}

function moduleProviders(): unknown[] {
    return (Reflect.getMetadata('providers', TriggerFacadesModule) as unknown[]) ?? [];
}

function ledgerProvider(): FactoryProviderEntry {
    const entry = moduleProviders().find(
        (candidate) => (candidate as FactoryProviderEntry)?.provide === DEMO_REPO_LEDGER,
    ) as FactoryProviderEntry | undefined;
    expect(entry, 'TriggerFacadesModule registers no DEMO_REPO_LEDGER provider').toBeDefined();
    return entry as FactoryProviderEntry;
}

/** Resolves the token as the facade does: optional, from the module that declares it. */
async function resolveInHarness(callRemote: ReturnType<typeof vi.fn>): Promise<{
    context: INestApplicationContext;
    ledger: DemoRepoLedgerPort | undefined;
}> {
    class Harness {}
    Module({
        providers: [
            ledgerProvider() as Provider,
            { provide: TriggerInternalApiClient, useValue: { callRemote } },
            {
                provide: 'LEDGER_CONSUMER',
                useFactory: (ledger?: DemoRepoLedgerPort) => ({ ledger }),
                inject: [{ token: DEMO_REPO_LEDGER, optional: true }],
            },
        ],
    })(Harness);

    const context = await NestFactory.createApplicationContext(Harness, { logger: false });
    return {
        context,
        ledger: context.get<{ ledger?: DemoRepoLedgerPort }>('LEDGER_CONSUMER').ledger,
    };
}

describe('TriggerFacadesModule — DEMO_REPO_LEDGER', () => {
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

    it('declares the token beside GitFacadeService, built from the API client', () => {
        const entry = ledgerProvider();

        expect(moduleProviders()).toContain(GitFacadeService);
        expect(typeof entry.useFactory).toBe('function');
        expect(entry.inject).toEqual([TriggerInternalApiClient]);
    });

    it('with DEMO on, resolves to a proxy of the API DemoRepoLedgerService', async () => {
        process.env.DEMO = 'true';
        const resolved = await resolveInHarness(callRemote);
        context = resolved.context;
        const entry = {
            sandboxUserId: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
            owner: 'ever-works-cloud',
            name: 'demo-0a1b2c3d-awesome-ai-coding-tools-website',
            githubId: null,
        };

        expect(resolved.ledger).toBeDefined();
        await resolved.ledger!.record(entry);

        expect(callRemote).toHaveBeenCalledTimes(1);
        const [name, method, args] = callRemote.mock.calls[0];
        expect(name).toBe('DemoRepoLedgerService');
        expect(method).toBe('record');
        expect(superjson.deserialize(args as never)).toEqual([entry]);
    });

    it('with DEMO off, binds nothing the facade could call', async () => {
        const resolved = await resolveInHarness(callRemote);
        context = resolved.context;

        expect(resolved.ledger).toBeUndefined();
        expect(callRemote).not.toHaveBeenCalled();
    });
});
