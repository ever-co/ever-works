import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { IPlugin, PluginContext } from '@ever-works/plugin';
import { AgentMemoryFacadeService } from '../agent-memory.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { buildAgentMemoryTools } from '../../services/agent-memory-tools';
import { resolveMemoryRecall } from '../../services/memory-recall';
// The REAL first-party plugins, from source — not mocks.
import { MemantoPlugin } from '../../../../plugins/memanto/src/memanto.plugin';
import { AgentmemoryPlugin } from '../../../../plugins/agentmemory/src/agentmemory.plugin';

/**
 * Memanto as the default agent-memory provider — platform wiring, end to end.
 *
 * 1. Default resolution (always runs), from the real manifests: Memanto is
 *    auto-enabled and the default, so once a Memanto server is configured it
 *    wins over agentmemory; with no Memanto server configured the facade
 *    skips it (`isConfigured`) and the agentmemory provider keeps serving.
 * 2. Agent path (runs when `MEMANTO_CONTRACT_URL` points at a real Memanto
 *    server): an Agent's `memory_save` / `memory_search` tools and the
 *    run-start recall injection all go tools → facade → default resolution
 *    → MemantoPlugin → Memanto HTTP, and what one run saves the next recalls.
 */

function registered(plugin: IPlugin): RegisteredPlugin {
    const manifest = (plugin as { getManifest(): RegisteredPlugin['manifest'] }).getManifest();
    return {
        plugin,
        manifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: Date.now(),
    } as RegisteredPlugin;
}

async function makeFacade(plugins: IPlugin[], settings: Record<string, unknown> = {}) {
    const entries = plugins.map(registered);
    const module = await Test.createTestingModule({
        providers: [
            AgentMemoryFacadeService,
            {
                provide: PluginRegistryService,
                useValue: {
                    get: jest.fn((id: string) => entries.find((e) => e.plugin.id === id)),
                    getByCapability: jest.fn().mockReturnValue(entries),
                    isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                },
            },
            {
                provide: PluginSettingsService,
                useValue: { getSettings: jest.fn().mockResolvedValue(settings) },
            },
        ],
    }).compile();
    return module.get(AgentMemoryFacadeService);
}

const context = {
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
} as unknown as PluginContext;

describe('agent-memory default provider = Memanto', () => {
    const configured = { baseUrl: 'http://memanto.ever-works.svc.cluster.local:8000' };

    afterEach(() => {
        delete process.env.MEMANTO_BASE_URL;
    });

    it('resolves Memanto once a Memanto server is configured (agentmemory listed first)', async () => {
        const facade = await makeFacade([new AgentmemoryPlugin(), new MemantoPlugin()], configured);
        await expect(facade.getDefaultProvider(undefined, 'user-1')).resolves.toEqual({
            id: 'memanto',
            name: 'memanto',
        });
        const providers = await facade.getAvailableProvidersForUser('user-1');
        expect(providers.map((p) => [p.id, p.isDefault])).toEqual([
            ['memanto', true],
            ['agentmemory', false],
        ]);
    });

    it('turns Memanto on platform-wide from MEMANTO_BASE_URL alone (no per-user settings)', async () => {
        process.env.MEMANTO_BASE_URL = 'http://memanto.ever-works.svc.cluster.local:8000';
        const facade = await makeFacade([new AgentmemoryPlugin(), new MemantoPlugin()]);
        await expect(facade.getDefaultProvider(undefined, 'user-1')).resolves.toEqual({
            id: 'memanto',
            name: 'memanto',
        });
    });

    it('skips an auto-enabled but unconfigured Memanto and keeps agentmemory serving', async () => {
        const facade = await makeFacade([new AgentmemoryPlugin(), new MemantoPlugin()]);
        await expect(facade.getDefaultProvider(undefined, 'user-1')).resolves.toEqual({
            id: 'agentmemory',
            name: 'agentmemory',
        });
    });

    it('still serves agentmemory when it is the only agent-memory plugin enabled', async () => {
        const facade = await makeFacade([new AgentmemoryPlugin()]);
        await expect(facade.getDefaultProvider(undefined, 'user-1')).resolves.toEqual({
            id: 'agentmemory',
            name: 'agentmemory',
        });
    });
});

const liveUrl = process.env.MEMANTO_CONTRACT_URL;
const liveKey = process.env.MEMANTO_CONTRACT_KEY;
(liveUrl ? describe : describe.skip)('Agent memory through Memanto (live server)', () => {
    it('memory tools and recall injection reach Memanto through the default resolution', async () => {
        const memanto = new MemantoPlugin();
        await memanto.onLoad(context);
        const facade = await makeFacade([new AgentmemoryPlugin(), memanto], {
            baseUrl: liveUrl,
            apiKey: liveKey,
            agentPrefix: `ewit${randomUUID().slice(0, 8)}`,
        });
        const agent = {
            id: 'agent-ops',
            userId: 'user-1',
            name: 'Ops Agent',
            workId: `work-${randomUUID().slice(0, 8)}`,
            memoryRecallEnabled: true,
        };
        const tools = buildAgentMemoryTools({ agent, facade, runId: 'run-1' });
        const save = tools.find((t) => t.name === 'memory_save')!;
        const search = tools.find((t) => t.name === 'memory_search')!;

        // Run 1 — the Agent keeps a durable fact.
        const saved = (await save.invoke({
            content: 'The billing service must be deployed before the API on every release.',
            tags: ['deploy', 'decision'],
        })) as { saved: boolean; id: string };
        expect(saved.saved).toBe(true);
        expect(saved.id).toMatch(/^ewit[0-9a-f]{8}-work-/);

        // Run 2 — it looks the fact up mid-run…
        const found = (await search.invoke({ query: 'what must be deployed before the API' })) as {
            results: Array<{ id: string; content: string; tags?: string[] }>;
        };
        const hit = found.results.find((r) => r.id === saved.id);
        expect(hit?.content).toContain('billing service');
        expect(hit?.tags).toEqual(['deploy', 'decision']);

        // …and the run-start recall injection serves it from the same store.
        const recall = await resolveMemoryRecall(
            facade,
            { query: 'release order for billing and API', projectId: agent.workId },
            { userId: agent.userId, workId: agent.workId },
        );
        expect(recall.status).toBe('injected');
        expect(recall.providerId).toBe('memanto');
        expect(recall.block).toContain('<agent_memory>');
        expect(recall.block).toContain('billing service must be deployed before the API');
    });
});
