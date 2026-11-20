import { EventEmitter2 } from '@nestjs/event-emitter';
import type { IPlugin, JsonSchema, PluginManifest } from '@ever-works/plugin';
import { GeneratorFormSchemaService } from '../generator-form-schema.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import { SettingsSchemaValidatorService } from '@src/plugins/services/settings-schema-validator.service';
import {
    resolvePluginEnabled,
    type PluginRegistryService,
    type RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
import type { PluginRepository } from '@src/plugins/repositories/plugin.repository';
import type { UserPluginRepository } from '@src/plugins/repositories/user-plugin.repository';
import type { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';

/**
 * The quick-create gate (`validateRequiredProvidersForPipeline` at USER scope, before the Work
 * exists) must count keys set at PLATFORM level: the operator's `x-envVar` environment value,
 * with no admin, user or work row. That is how app.ever.works serves the home-page prompt: an
 * anonymous visitor with no plugin settings of their own, backed by the platform's keys. If the
 * gate only saw the user's own settings, every anonymous quick-create would be refused.
 *
 * Real `PluginSettingsService` (empty admin/user/work rows), real `resolvePluginEnabled` for a
 * fresh user (no user/work plugin rows: system/auto-enabled plugins count as enabled), and the
 * production plugin shapes: OpenRouter (ai), Tavily (search), local-content-extractor.
 */

const ENV_AI = 'EW_QC_GATE_SPEC_OPENROUTER_API_KEY';
const ENV_SEARCH = 'EW_QC_GATE_SPEC_TAVILY_API_KEY';

const AI_SCHEMA: JsonSchema = {
    type: 'object',
    properties: {
        apiKey: { type: 'string', 'x-secret': true, 'x-envVar': ENV_AI },
        defaultModel: { type: 'string', default: 'openai/gpt-5-nano' },
    },
    required: ['apiKey', 'defaultModel'],
} as JsonSchema;

const SEARCH_SCHEMA: JsonSchema = {
    type: 'object',
    properties: {
        apiKey: { type: 'string', 'x-secret': true, 'x-envVar': ENV_SEARCH, 'x-scope': 'user' },
    },
    required: ['apiKey'],
} as JsonSchema;

function registered(
    id: string,
    capabilities: string[],
    settingsSchema: JsonSchema,
    manifest: Partial<PluginManifest>,
): RegisteredPlugin {
    const plugin = {
        id,
        name: id,
        version: '1.0.0',
        category: 'provider',
        capabilities,
        settingsSchema,
    } as unknown as IPlugin;
    return {
        plugin,
        manifest: {
            id,
            name: id,
            version: '1.0.0',
            description: '',
            ...manifest,
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        registeredAt: Date.now(),
        stateHistory: [],
    };
}

const PLUGINS: RegisteredPlugin[] = [
    registered(
        'agent-pipeline',
        ['pipeline', 'form-schema-provider'],
        { type: 'object', properties: {} } as JsonSchema,
        { defaultForCapabilities: ['pipeline'], autoEnable: true, systemPlugin: true },
    ),
    registered('openrouter', ['ai-provider'], AI_SCHEMA, {
        defaultForCapabilities: ['ai-provider'],
        autoEnable: true,
        systemPlugin: true,
    }),
    registered('tavily', ['search', 'content-extractor'], SEARCH_SCHEMA, {
        defaultForCapabilities: ['search'],
        autoEnable: true,
        systemPlugin: true,
    }),
    registered(
        'local-content-extractor',
        ['content-extractor'],
        { type: 'object', properties: {} } as JsonSchema,
        { defaultForCapabilities: ['content-extractor'], autoEnable: true, systemPlugin: true },
    ),
];

function build(): GeneratorFormSchemaService {
    const byId = new Map(PLUGINS.map((p) => [p.plugin.id, p]));
    const registry = {
        get: jest.fn((id: string) => byId.get(id)),
        getByCapability: jest.fn((cap: string) =>
            PLUGINS.filter((p) => (p.plugin.capabilities as string[]).includes(cap)),
        ),
        // A fresh anonymous visitor: no user or work plugin rows.
        isPluginEnabledForScope: jest.fn(async (id: string, workId?: string) => {
            const p = byId.get(id);
            return resolvePluginEnabled({
                systemPlugin: p?.manifest.systemPlugin,
                autoEnable: p?.manifest.autoEnable,
                userPlugin: null,
                workPlugin: null,
                hasWorkContext: !!workId,
            });
        }),
    } as unknown as PluginRegistryService;

    const settings = new PluginSettingsService(
        registry,
        // No admin row for any plugin (production's `plugins.settings` are `{}`).
        { findByPluginId: jest.fn(async () => null) } as unknown as PluginRepository,
        { findByUserAndPlugin: jest.fn(async () => null) } as unknown as UserPluginRepository,
        { findByWorkAndPlugin: jest.fn(async () => null) } as unknown as WorkPluginRepository,
        new EventEmitter2(),
        new SettingsSchemaValidatorService(),
    );
    return new GeneratorFormSchemaService(registry, undefined, settings);
}

const SELECTION = {
    pipeline: 'agent-pipeline',
    ai: 'openrouter',
    search: 'tavily',
    contentExtractor: 'local-content-extractor',
};

describe('validateRequiredProvidersForPipeline at user scope — platform-level keys', () => {
    const saved = { ai: process.env[ENV_AI], search: process.env[ENV_SEARCH] };

    afterEach(() => {
        for (const [name, value] of [
            [ENV_AI, saved.ai],
            [ENV_SEARCH, saved.search],
        ] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    it('passes an anonymous user whose only keys are the platform environment values', async () => {
        process.env[ENV_AI] = 'sk-or-v1-platform-key';
        process.env[ENV_SEARCH] = 'tvly-platform-key';

        await expect(
            build().validateRequiredProvidersForPipeline('agent-pipeline', SELECTION, {
                userId: 'anon-1',
            }),
        ).resolves.toBeUndefined();
    });

    it('refuses, naming each required provider, when the platform key is an empty string', async () => {
        // Production's state until 2026-11-20: PLUGIN_TAVILY_API_KEY set but empty.
        process.env[ENV_AI] = 'sk-or-v1-platform-key';
        process.env[ENV_SEARCH] = '';

        await expect(
            build().validateRequiredProvidersForPipeline('agent-pipeline', SELECTION, {
                userId: 'anon-1',
            }),
        ).rejects.toMatchObject({
            response: {
                providerErrors: { search: expect.stringContaining('tavily') },
            },
        });
    });

    it('refuses a keyless install on both the AI and the search provider', async () => {
        delete process.env[ENV_AI];
        delete process.env[ENV_SEARCH];

        await expect(
            build().validateRequiredProvidersForPipeline('agent-pipeline', SELECTION, {
                userId: 'anon-1',
            }),
        ).rejects.toMatchObject({
            response: {
                providerErrors: {
                    ai: expect.stringContaining('openrouter'),
                    search: expect.stringContaining('tavily'),
                },
            },
        });
    });
});
