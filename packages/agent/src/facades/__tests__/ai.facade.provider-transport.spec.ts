import { Test, TestingModule } from '@nestjs/testing';
import { z } from 'zod';
import { AiFacadeService } from '../ai.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    AiProviderTransport,
    ChatCompletionResponse,
    IAiProviderPlugin,
    PluginManifest,
} from '@ever-works/plugin';

/**
 * Local AI completions — the AI facade's two additions for a provider whose
 * endpoint is the CALLER's (the fleet local AI plugin):
 *
 *   - every provider call carries who it is made for (`scope`), and
 *   - `getProviderConfig` hands on the provider's own transport (`fetch`,
 *     with its placeholder origin and token) to the clients that build their
 *     own model from it — and nothing changes for a provider without one.
 */

const USER = { userId: 'user-1', workId: 'work-1' };

function plugin(transport: AiProviderTransport | null | undefined): IAiProviderPlugin {
    const answer: ChatCompletionResponse = {
        id: 'r1',
        created: 1,
        model: 'flashnext',
        choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' },
        ],
    };
    return {
        id: 'fleet-local-ai',
        name: 'Local AI',
        version: '1.0.0',
        category: 'ai-provider',
        capabilities: ['ai-provider'],
        settingsSchema: { type: 'object', properties: {} },
        providerType: 'fleet-local-ai',
        providerName: 'Local AI on your computers',
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        isAvailable: jest.fn().mockResolvedValue(true),
        createChatCompletion: jest.fn().mockResolvedValue(answer),
        createStreamingChatCompletion: jest.fn().mockReturnValue((async function* () {})()),
        askJson: jest.fn().mockResolvedValue({ result: { name: 'x' }, model: 'flashnext' }),
        listModels: jest.fn().mockResolvedValue([]),
        getModel: jest.fn().mockResolvedValue(null),
        getCapabilities: jest.fn().mockReturnValue({
            supportsStructuredOutput: true,
            supportsStreaming: true,
            supportsToolCalling: true,
            supportsVision: false,
            maxContextLength: 32768,
        }),
        ...(transport !== undefined
            ? { createTransport: jest.fn().mockResolvedValue(transport) }
            : {}),
    };
}

async function facadeFor(target: IAiProviderPlugin, settings: Record<string, unknown> = {}) {
    const registered = {
        plugin: target,
        manifest: {
            id: target.id,
            name: target.name,
            version: target.version,
            category: target.category,
            capabilities: target.capabilities,
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: Date.now(),
    } as unknown as RegisteredPlugin;
    const module: TestingModule = await Test.createTestingModule({
        providers: [
            AiFacadeService,
            {
                provide: PluginRegistryService,
                useValue: {
                    get: jest.fn().mockReturnValue(registered),
                    getByCapability: jest.fn().mockReturnValue([registered]),
                    isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                },
            },
            {
                provide: PluginSettingsService,
                useValue: { getSettings: jest.fn().mockResolvedValue(settings) },
            },
        ],
    }).compile();
    return module.get(AiFacadeService);
}

describe('AiFacadeService — provider transport', () => {
    it('hands on the provider transport: its origin, its token and its fetch replace the settings', async () => {
        const fetch = jest.fn();
        const target = plugin({
            baseUrl: 'https://fleet-local-ai.invalid/v1',
            apiKey: 'fleet-local-ai',
            fetch,
        });
        const facade = await facadeFor(target, {
            baseUrl: 'https://ignored.example/v1',
            apiKey: 'sk-test-ignored',
            defaultModel: 'flashnext',
        });

        const config = await facade.getProviderConfig({
            ...USER,
            providerOverride: 'fleet-local-ai',
        });

        expect(config).toMatchObject({
            providerId: 'fleet-local-ai',
            baseUrl: 'https://fleet-local-ai.invalid/v1',
            apiKey: 'fleet-local-ai',
            defaultModel: 'flashnext',
        });
        expect(config.fetch).toBe(fetch);
        expect(target.createTransport).toHaveBeenCalledWith(
            { userId: 'user-1', workId: 'work-1' },
            expect.objectContaining({ defaultModel: 'flashnext' }),
        );
    });

    it('changes nothing for a provider without a transport (or one that declines)', async () => {
        for (const transport of [undefined, null]) {
            const facade = await facadeFor(plugin(transport), {
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'sk-test-or',
            });
            const config = await facade.getProviderConfig({
                ...USER,
                providerOverride: 'fleet-local-ai',
            });
            expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
            expect(config.apiKey).toBe('sk-test-or');
            expect(config).not.toHaveProperty('fetch');
        }
    });
});

describe('AiFacadeService — the call scope', () => {
    it('tells the provider who each call is for', async () => {
        const target = plugin(undefined);
        const facade = await facadeFor(target, { defaultModel: 'flashnext' });
        const options = { ...USER, providerOverride: 'fleet-local-ai' };

        await facade.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }, options);
        for await (const _chunk of facade.createStreamingChatCompletion(
            { messages: [{ role: 'user', content: 'hi' }] },
            options,
        )) {
            // drain
        }
        await facade.askJson('Name a thing', z.object({ name: z.string() }), undefined, options);
        await facade.testConnection(options);
        await facade.getAvailableModels(options);

        expect(target.createChatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ scope: { userId: 'user-1', workId: 'work-1' } }),
        );
        expect(target.createStreamingChatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ scope: { userId: 'user-1', workId: 'work-1' } }),
        );
        expect(target.askJson).toHaveBeenCalledWith(
            'Name a thing',
            expect.objectContaining({ scope: { userId: 'user-1', workId: 'work-1' } }),
        );
        expect(target.isAvailable).toHaveBeenCalledWith(expect.anything(), {
            userId: 'user-1',
            workId: 'work-1',
        });
        expect(target.listModels).toHaveBeenCalledWith(expect.anything(), {
            userId: 'user-1',
            workId: 'work-1',
        });
    });
});
