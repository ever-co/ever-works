import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
    ChatCompletionOptions,
    ChatCompletionResponse,
    FacadeOptions,
    IAiProviderPlugin,
    PluginManifest,
} from '@ever-works/plugin';
import { AiFacadeService } from '../ai.facade';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type { PluginUsageService } from '../../usage/plugin-usage.service';
import type { BudgetGuardService } from '../../budgets/budget-guard.service';
import type { ModelRoutePlanner } from '../../model-routing/model-route-planner.port';
import {
    DemoFeatureDisabledError,
    DemoModelNotAllowedError,
    DemoModelUnavailableError,
    DemoQuotaExceededError,
    DemoRateLimitedError,
    type DemoAiQuotaPort,
} from '../../demo';

/**
 * Platform demo mode (`DEMO=true`) — the AI facade's money guard.
 *
 * On a demo instance every call goes to the `openrouter` plugin with a model
 * id ending in `:free` (whatever the caller, a route or an escalation asked
 * for), is counted against the demo's AI quota before it goes upstream, and
 * embeddings are skipped. With `DEMO` unset nothing of this applies.
 */

const FREE_SETTINGS = {
    apiKey: 'sk-or-demo',
    defaultModel: 'google/gemma-4-31b-it:free',
    simpleModel: 'inclusionai/ling-3.2-flash:free',
    mediumModel: 'nvidia/nemotron-3.5-super-vl:free',
    complexModel: 'deepseek/deepseek-r3:free',
};

const PAID_SETTINGS = {
    apiKey: 'sk-ant-operator',
    defaultModel: 'anthropic/claude-opus-paid',
};

function chatResponse(model: string): ChatCompletionResponse {
    return {
        id: 'r',
        created: 0,
        model,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: '{"name":"x"}' },
                finishReason: 'stop',
            },
        ],
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    } as ChatCompletionResponse;
}

function provider(id: string): IAiProviderPlugin {
    return {
        id,
        name: id,
        version: '1.0.0',
        category: 'ai-provider',
        capabilities: ['ai-provider'],
        providerType: id,
        providerName: `Provider ${id}`,
        settingsSchema: { type: 'object', properties: { apiKey: { type: 'string' } } },
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        isAvailable: jest.fn().mockResolvedValue(true),
        askJson: jest.fn(async (_prompt: string, opts: { model?: string }) => ({
            result: { name: 'x' },
            model: opts.model ?? 'unset',
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        })),
        createChatCompletion: jest.fn(async (opts: ChatCompletionOptions) =>
            chatResponse(opts.model ?? 'unset'),
        ),
        createStreamingChatCompletion: jest.fn(async function* (opts: ChatCompletionOptions) {
            yield {
                id: 'c',
                created: 0,
                model: opts.model ?? 'unset',
                choices: [{ index: 0, delta: { content: 'hi' }, finishReason: null }],
            };
        }),
        createEmbedding: jest.fn().mockResolvedValue({ model: 'e', embeddings: [[0.1]] }),
        transcribe: jest.fn().mockResolvedValue({ text: 'hi', model: 'whisper-x' }),
        listModels: jest.fn().mockResolvedValue([]),
        getModel: jest.fn().mockResolvedValue(null),
        getCapabilities: jest.fn().mockReturnValue({
            supportsStructuredOutput: true,
            supportsStreaming: true,
            supportsToolCalling: true,
            supportsVision: false,
            maxContextLength: 1000,
        }),
    } as unknown as IAiProviderPlugin;
}

function registered(instance: IAiProviderPlugin, isDefault = false): RegisteredPlugin {
    return {
        plugin: instance as never,
        manifest: {
            id: instance.id,
            name: instance.id,
            version: '1.0.0',
            category: 'ai-provider',
            description: 'test provider',
            capabilities: ['ai-provider'],
            ...(isDefault ? { defaultForCapabilities: ['ai-provider'] } : {}),
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        stateHistory: [],
        registeredAt: 0,
    };
}

const schema = z.object({ name: z.string() });
const USER: FacadeOptions = { userId: 'demo-user-1', workId: 'w1' };

describe('AiFacadeService — demo mode', () => {
    let openrouter: IAiProviderPlugin;
    let anthropic: IAiProviderPlugin;
    let registry: jest.Mocked<
        Pick<PluginRegistryService, 'get' | 'getByCapability' | 'isPluginEnabledForScope'>
    >;
    let settingsByPlugin: Record<string, Record<string, unknown>>;
    let settings: { getSettings: jest.Mock };
    let usage: { record: jest.Mock };
    let budget: { checkBudget: jest.Mock };
    let workPlugins: { findActiveByCapability: jest.Mock };
    let quota: { consume: jest.Mock };
    let planner: jest.Mocked<ModelRoutePlanner> | undefined;
    let errorLog: jest.SpyInstance;
    const originalFetch = global.fetch;
    const originalDemo = process.env.DEMO;

    const build = (withQuota = true) =>
        new AiFacadeService(
            registry as unknown as PluginRegistryService,
            settings as unknown as PluginSettingsService,
            workPlugins as unknown as WorkPluginRepository,
            usage as unknown as PluginUsageService,
            budget as unknown as BudgetGuardService,
            planner,
            withQuota ? (quota as DemoAiQuotaPort) : undefined,
        );

    const ask = (service: AiFacadeService, routing?: Record<string, unknown>, opts = USER) =>
        service.askJson('Describe {x}', schema, { variables: { x: 'y' }, routing }, opts);

    const chat = (
        service: AiFacadeService,
        options: Partial<ChatCompletionOptions> & Record<string, unknown> = {},
        opts: FacadeOptions = USER,
    ) =>
        service.createChatCompletion(
            { messages: [{ role: 'user', content: 'hello' }], ...options },
            opts,
        );

    const stream = async (
        service: AiFacadeService,
        options: Partial<ChatCompletionOptions> & Record<string, unknown> = {},
        opts: FacadeOptions = USER,
    ) => {
        const chunks = [];
        for await (const chunk of service.createStreamingChatCompletion(
            { messages: [{ role: 'user', content: 'hello' }], ...options },
            opts,
        )) {
            chunks.push(chunk);
        }
        return chunks;
    };

    const modelSentTo = (mock: unknown, index = 0) =>
        ((mock as jest.Mock).mock.calls[index][0] as { model?: string }).model;
    const askJsonModel = (index = 0) =>
        ((openrouter.askJson as jest.Mock).mock.calls[index][1] as { model?: string }).model;

    beforeEach(() => {
        process.env.DEMO = 'true';
        // No network: the model catalog lookup behind cost estimation fails fast.
        global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as never;
        errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

        openrouter = provider('openrouter');
        anthropic = provider('anthropic');
        const table: Record<string, RegisteredPlugin> = {
            // anthropic is the scope's default provider: demo mode must not use it.
            anthropic: registered(anthropic, true),
            openrouter: registered(openrouter),
        };
        registry = {
            get: jest.fn((id: string) => table[id]),
            getByCapability: jest.fn(() => [table.anthropic, table.openrouter]),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as never;
        settingsByPlugin = { openrouter: { ...FREE_SETTINGS }, anthropic: { ...PAID_SETTINGS } };
        settings = {
            getSettings: jest.fn(async (pluginId: string) => settingsByPlugin[pluginId] ?? {}),
        };
        usage = { record: jest.fn().mockResolvedValue(null) };
        budget = { checkBudget: jest.fn().mockResolvedValue(undefined) };
        workPlugins = { findActiveByCapability: jest.fn().mockResolvedValue(null) };
        quota = { consume: jest.fn().mockResolvedValue(undefined) };
        planner = undefined;
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        global.fetch = originalFetch;
        if (originalDemo === undefined) delete process.env.DEMO;
        else process.env.DEMO = originalDemo;
    });

    describe('free-model rewrite', () => {
        it("askJson: a paid modelOverride is replaced by the tier's free model", async () => {
            const result = await ask(build(), {
                modelOverride: 'openai/gpt-6.1-sol',
                complexity: 'complex',
            });

            expect(openrouter.askJson).toHaveBeenCalledTimes(1);
            expect(askJsonModel()).toBe(FREE_SETTINGS.complexModel);
            expect(result.provider).toBe('openrouter');
            expect(anthropic.askJson).not.toHaveBeenCalled();
        });

        it('askJson: a free modelOverride is kept', async () => {
            await ask(build(), { modelOverride: 'qwen/qwen-4:free', complexity: 'complex' });

            expect(askJsonModel()).toBe('qwen/qwen-4:free');
        });

        it('providerOverride: anthropic still resolves the openrouter plugin', async () => {
            const service = build();

            await ask(
                service,
                { providerOverride: 'anthropic' },
                {
                    ...USER,
                    providerOverride: 'anthropic',
                },
            );
            await chat(service, { model: 'claude-x' }, { ...USER, providerOverride: 'anthropic' });
            await stream(service, {}, { ...USER, providerOverride: 'anthropic' });

            expect(registry.get).not.toHaveBeenCalledWith('anthropic');
            expect(anthropic.askJson).not.toHaveBeenCalled();
            expect(anthropic.createChatCompletion).not.toHaveBeenCalled();
            expect(anthropic.createStreamingChatCompletion).not.toHaveBeenCalled();
            expect(askJsonModel()).toBe(FREE_SETTINGS.defaultModel);
            expect(modelSentTo(openrouter.createChatCompletion)).toBe(FREE_SETTINGS.defaultModel);
            expect(modelSentTo(openrouter.createStreamingChatCompletion)).toBe(
                FREE_SETTINGS.defaultModel,
            );
        });

        it('createChatCompletion({ model: openai/gpt-4o }) sends a free model', async () => {
            const response = await chat(build(), { model: 'openai/gpt-4o' });

            expect(modelSentTo(openrouter.createChatCompletion)).toBe(FREE_SETTINGS.defaultModel);
            expect(response.model).toBe(FREE_SETTINGS.defaultModel);
        });

        it("createChatCompletion: the call's complexity picks the tier", async () => {
            await chat(build(), { model: 'openai/gpt-4o', complexity: 'simple' });

            expect(modelSentTo(openrouter.createChatCompletion)).toBe(FREE_SETTINGS.simpleModel);
        });

        it('createStreamingChatCompletion: a paid model is replaced', async () => {
            const chunks = await stream(build(), { model: 'openai/gpt-4o', complexity: 'medium' });

            expect(modelSentTo(openrouter.createStreamingChatCompletion)).toBe(
                FREE_SETTINGS.mediumModel,
            );
            expect(chunks).toHaveLength(1);
        });

        it('a model-account route cannot reintroduce a paid provider or model', async () => {
            planner = {
                plan: jest.fn().mockResolvedValue({
                    workspaceKey: 'org:o1',
                    primarySource: 'workspace',
                    providerPluginId: 'anthropic',
                    modelId: 'anthropic/claude-opus-paid',
                    reasoningEffort: 'medium',
                    runTimeoutSeconds: 900,
                    accountsAvailable: false,
                }),
                selectAccount: jest.fn().mockResolvedValue(null),
                recordAnswer: jest.fn().mockResolvedValue(undefined),
                reportFailure: jest.fn().mockResolvedValue(undefined),
            };
            const service = build();

            await ask(service, { complexity: 'complex' });
            await chat(service, { model: 'qwen/qwen-4:free' });
            await stream(service);

            expect(askJsonModel()).toBe(FREE_SETTINGS.complexModel);
            expect(modelSentTo(openrouter.createChatCompletion)).toBe(FREE_SETTINGS.defaultModel);
            expect(modelSentTo(openrouter.createStreamingChatCompletion)).toBe(
                FREE_SETTINGS.defaultModel,
            );
            expect(anthropic.askJson).not.toHaveBeenCalled();
            expect(anthropic.createChatCompletion).not.toHaveBeenCalled();
        });

        it('fails closed when no free model is configured, before quota or provider', async () => {
            settingsByPlugin.openrouter = {
                apiKey: 'k',
                defaultModel: 'openai/gpt-6.1-sol',
                complexModel: 'openai/gpt-6.1-sol-pro',
            };
            const service = build();

            await expect(ask(service, { complexity: 'complex' })).rejects.toBeInstanceOf(
                DemoModelNotAllowedError,
            );
            await expect(chat(service, { model: 'x' })).rejects.toBeInstanceOf(
                DemoModelNotAllowedError,
            );
            await expect(stream(service)).rejects.toBeInstanceOf(DemoModelNotAllowedError);

            expect(openrouter.askJson).not.toHaveBeenCalled();
            expect(openrouter.createChatCompletion).not.toHaveBeenCalled();
            expect(openrouter.createStreamingChatCompletion).not.toHaveBeenCalled();
            expect(quota.consume).not.toHaveBeenCalled();
        });
    });

    describe('quota', () => {
        it('consumes once per call with facadeOptions.userId, before the budget gate', async () => {
            const order: string[] = [];
            quota.consume.mockImplementation(async () => {
                order.push('quota');
            });
            budget.checkBudget.mockImplementation(async () => {
                order.push('budget');
            });
            const service = build();

            await ask(service, { complexity: 'simple' });
            await chat(service);
            await stream(service);

            expect(quota.consume).toHaveBeenCalledTimes(3);
            expect(quota.consume.mock.calls).toEqual([[USER.userId], [USER.userId], [USER.userId]]);
            expect(order).toEqual(['quota', 'budget', 'quota', 'budget', 'quota', 'budget']);
        });

        it('a used-up quota rejects the call and the provider is never reached', async () => {
            const used = new DemoQuotaExceededError('sandbox');
            quota.consume.mockRejectedValue(used);
            const service = build();

            await expect(ask(service)).rejects.toBe(used);
            await expect(chat(service)).rejects.toBe(used);
            await expect(stream(service)).rejects.toBe(used);

            expect(openrouter.askJson).not.toHaveBeenCalled();
            expect(openrouter.createChatCompletion).not.toHaveBeenCalled();
            expect(openrouter.createStreamingChatCompletion).not.toHaveBeenCalled();
            expect(budget.checkBudget).not.toHaveBeenCalled();
        });

        it('askJson (background) waits out a busy minute and then succeeds', async () => {
            jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
            quota.consume
                .mockRejectedValueOnce(new DemoRateLimitedError(50))
                .mockResolvedValue(undefined);

            const pending = ask(build(), { complexity: 'simple' });
            await jest.advanceTimersByTimeAsync(49);
            expect(quota.consume).toHaveBeenCalledTimes(1);
            expect(openrouter.askJson).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(1);
            const result = await pending;

            expect(quota.consume).toHaveBeenCalledTimes(2);
            expect(openrouter.askJson).toHaveBeenCalledTimes(1);
            expect(result.result).toEqual({ name: 'x' });
        });

        it('createChatCompletion (interactive) rethrows a busy minute at once', async () => {
            const busy = new DemoRateLimitedError(50);
            quota.consume.mockRejectedValueOnce(busy).mockResolvedValue(undefined);

            await expect(chat(build())).rejects.toBe(busy);

            expect(quota.consume).toHaveBeenCalledTimes(1);
            expect(openrouter.createChatCompletion).not.toHaveBeenCalled();
        });

        it('createStreamingChatCompletion (interactive) rethrows a busy minute at once', async () => {
            const busy = new DemoRateLimitedError(50);
            quota.consume.mockRejectedValueOnce(busy).mockResolvedValue(undefined);

            await expect(stream(build())).rejects.toBe(busy);

            expect(quota.consume).toHaveBeenCalledTimes(1);
            expect(openrouter.createStreamingChatCompletion).not.toHaveBeenCalled();
        });

        it('still forces a free model when no quota port is bound', async () => {
            await chat(build(false), { model: 'openai/gpt-4o' });

            expect(modelSentTo(openrouter.createChatCompletion)).toBe(FREE_SETTINGS.defaultModel);
        });
    });

    describe('a configured free model gone from OpenRouter', () => {
        const gone = () => new Error('404 No endpoints found for google/gemma-4-31b-it:free.');

        it('askJson → DemoModelUnavailableError, logged with the model id', async () => {
            (openrouter.askJson as jest.Mock).mockRejectedValue(gone());

            const error = await ask(build()).catch((e) => e);

            expect(error).toBeInstanceOf(DemoModelUnavailableError);
            expect(error.message).toBe('The demo AI model is temporarily unavailable');
            expect(error.modelId).toBe(FREE_SETTINGS.defaultModel);
            expect(errorLog).toHaveBeenCalledWith(
                expect.stringContaining(FREE_SETTINGS.defaultModel),
            );
        });

        it('createChatCompletion → DemoModelUnavailableError', async () => {
            (openrouter.createChatCompletion as jest.Mock).mockRejectedValue(
                new Error('The model `google/gemma-4-31b-it:free` does not exist'),
            );

            await expect(chat(build())).rejects.toBeInstanceOf(DemoModelUnavailableError);
            expect(errorLog).toHaveBeenCalledWith(
                expect.stringContaining(FREE_SETTINGS.defaultModel),
            );
        });

        it('createStreamingChatCompletion → DemoModelUnavailableError', async () => {
            (openrouter.createStreamingChatCompletion as jest.Mock).mockImplementation(
                // eslint-disable-next-line require-yield
                async function* () {
                    throw new Error('Model not found');
                },
            );

            await expect(stream(build())).rejects.toBeInstanceOf(DemoModelUnavailableError);
        });

        it('any other provider error passes through unchanged', async () => {
            const limited = new Error('429 Rate limit exceeded upstream');
            (openrouter.createChatCompletion as jest.Mock).mockRejectedValue(limited);

            await expect(chat(build())).rejects.toBe(limited);
            expect(errorLog).not.toHaveBeenCalled();
        });
    });

    describe('escalation', () => {
        it('never escalates to a non-free model', async () => {
            settingsByPlugin.openrouter = {
                ...FREE_SETTINGS,
                mediumModel: 'openai/gpt-6.1-sol',
                complexModel: 'openai/gpt-6.1-sol-pro',
            };
            const failure = new Error('upstream refused');
            (openrouter.askJson as jest.Mock).mockRejectedValue(failure);

            await expect(ask(build(), { complexity: 'simple' })).rejects.toBe(failure);

            expect(openrouter.askJson).toHaveBeenCalledTimes(1);
            expect(askJsonModel()).toBe(FREE_SETTINGS.simpleModel);
        });

        it('escalates to the next free tier, counting that call against the quota', async () => {
            (openrouter.askJson as jest.Mock)
                .mockRejectedValueOnce(new Error('upstream refused'))
                .mockImplementation(async (_p: string, opts: { model?: string }) => ({
                    result: { name: 'escalated' },
                    model: opts.model,
                }));

            const result = await ask(build(), { complexity: 'simple' });

            expect(result.result).toEqual({ name: 'escalated' });
            expect(askJsonModel(0)).toBe(FREE_SETTINGS.simpleModel);
            expect(askJsonModel(1)).toBe(FREE_SETTINGS.mediumModel);
            expect(quota.consume).toHaveBeenCalledTimes(2);
        });
    });

    describe('embeddings', () => {
        it('embed → DemoFeatureDisabledError without resolving or calling a plugin', async () => {
            const error = await build()
                .embed({ input: 'hello' }, USER)
                .catch((e) => e);

            expect(error).toBeInstanceOf(DemoFeatureDisabledError);
            expect(error.feature).toBe('embeddings');
            expect(registry.get).not.toHaveBeenCalled();
            expect(registry.getByCapability).not.toHaveBeenCalled();
            expect(openrouter.createEmbedding).not.toHaveBeenCalled();
            expect(anthropic.createEmbedding).not.toHaveBeenCalled();
            expect(quota.consume).not.toHaveBeenCalled();
        });
    });

    describe('transcription', () => {
        const audio = { file: Buffer.from('audio'), filename: 'a.webm' };

        it('transcribe → DemoFeatureDisabledError without resolving or calling a plugin', async () => {
            const error = await build()
                .transcribe(audio, { ...USER, providerOverride: 'anthropic' })
                .catch((e) => e);

            expect(error).toBeInstanceOf(DemoFeatureDisabledError);
            expect(error.feature).toBe('transcription');
            expect(registry.get).not.toHaveBeenCalled();
            expect(registry.getByCapability).not.toHaveBeenCalled();
            expect(openrouter.transcribe).not.toHaveBeenCalled();
            expect(anthropic.transcribe).not.toHaveBeenCalled();
            expect(quota.consume).not.toHaveBeenCalled();
        });

        it('lists no voice provider, so clients hide dictation', async () => {
            await expect(build().listTranscriptionProviders(USER)).resolves.toEqual([]);
            expect(registry.getByCapability).not.toHaveBeenCalled();
        });
    });

    describe('testConnection', () => {
        const isAvailableSettings = (plugin: IAiProviderPlugin) =>
            (plugin.isAvailable as jest.Mock).mock.calls[0][0] as Record<string, unknown>;

        it('tests openrouter with free models only, counted once', async () => {
            settingsByPlugin.openrouter = {
                ...FREE_SETTINGS,
                mediumModel: 'openai/gpt-6.1-sol',
            };

            const result = await build().testConnection({
                ...USER,
                providerOverride: 'anthropic',
            });

            expect(result).toMatchObject({ success: true, provider: 'openrouter' });
            expect(anthropic.isAvailable).not.toHaveBeenCalled();
            const sent = isAvailableSettings(openrouter);
            expect(sent.defaultModel).toBe(FREE_SETTINGS.defaultModel);
            expect(sent).not.toHaveProperty('mediumModel');
            expect(quota.consume).toHaveBeenCalledTimes(1);
            expect(quota.consume).toHaveBeenCalledWith(USER.userId);
        });

        it('a paid default model is replaced by a free tier model', async () => {
            settingsByPlugin.openrouter = {
                apiKey: 'k',
                defaultModel: 'openai/gpt-6.1-sol',
                simpleModel: FREE_SETTINGS.simpleModel,
            };

            await build().testConnection(USER);

            expect(isAvailableSettings(openrouter).defaultModel).toBe(FREE_SETTINGS.simpleModel);
        });

        it('fails closed with no free model: nothing sent, nothing counted', async () => {
            settingsByPlugin.openrouter = { apiKey: 'k', defaultModel: 'openai/gpt-6.1-sol' };

            const result = await build().testConnection(USER);

            expect(result.success).toBe(false);
            expect(result.error).toBe(new DemoModelNotAllowedError('openai/gpt-6.1-sol').message);
            expect(openrouter.isAvailable).not.toHaveBeenCalled();
            expect(quota.consume).not.toHaveBeenCalled();
        });

        it('a used-up quota means no upstream test', async () => {
            quota.consume.mockRejectedValue(new DemoQuotaExceededError('day'));

            const result = await build().testConnection(USER);

            expect(result.success).toBe(false);
            expect(result.error).toBe(new DemoQuotaExceededError('day').message);
            expect(openrouter.isAvailable).not.toHaveBeenCalled();
        });
    });

    describe('with DEMO unset', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it('the call resolves, routes and is not counted exactly as before', async () => {
            const service = build();

            await ask(service, { modelOverride: 'openai/gpt-6.1-sol' });
            await chat(
                service,
                { model: 'openai/gpt-4o' },
                { ...USER, providerOverride: 'anthropic' },
            );
            await stream(service);
            const embedded = await service.embed({ input: 'hello' }, USER);

            // anthropic is the scope's default provider; nothing forces openrouter.
            expect(
                ((anthropic.askJson as jest.Mock).mock.calls[0][1] as { model?: string }).model,
            ).toBe('openai/gpt-6.1-sol');
            expect(modelSentTo(anthropic.createChatCompletion)).toBe('openai/gpt-4o');
            expect(modelSentTo(anthropic.createStreamingChatCompletion)).toBe(
                PAID_SETTINGS.defaultModel,
            );
            expect(embedded.embeddings).toEqual([[0.1]]);
            expect(openrouter.askJson).not.toHaveBeenCalled();
            expect(quota.consume).not.toHaveBeenCalled();
        });

        it('transcribe and testConnection use the resolved provider and its own settings', async () => {
            const service = build();

            const transcript = await service.transcribe(
                { file: Buffer.from('audio'), filename: 'a.webm' },
                USER,
            );
            const tested = await service.testConnection({
                ...USER,
                providerOverride: 'anthropic',
            });

            expect(transcript.text).toBe('hi');
            expect(anthropic.transcribe).toHaveBeenCalledTimes(1);
            expect(tested).toMatchObject({ success: true, provider: 'anthropic' });
            expect((anthropic.isAvailable as jest.Mock).mock.calls[0][0]).toEqual(PAID_SETTINGS);
            expect(openrouter.isAvailable).not.toHaveBeenCalled();
            expect(quota.consume).not.toHaveBeenCalled();
        });

        it('a provider "model not found" error is not rewritten', async () => {
            const gone = new Error('No endpoints found for x');
            (anthropic.createChatCompletion as jest.Mock).mockRejectedValue(gone);

            await expect(chat(build())).rejects.toBe(gone);
        });

        it('escalation may pick any configured model', async () => {
            settingsByPlugin.anthropic = {
                ...PAID_SETTINGS,
                simpleModel: 'anthropic/haiku-paid',
                mediumModel: 'anthropic/sonnet-paid',
            };
            (anthropic.askJson as jest.Mock)
                .mockRejectedValueOnce(new Error('refused'))
                .mockImplementation(async (_p: string, opts: { model?: string }) => ({
                    result: { name: 'x' },
                    model: opts.model,
                }));

            await ask(build(), { complexity: 'simple' });

            expect(
                ((anthropic.askJson as jest.Mock).mock.calls[1][1] as { model?: string }).model,
            ).toBe('anthropic/sonnet-paid');
        });
    });
});
