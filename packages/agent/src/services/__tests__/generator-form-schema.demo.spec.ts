import { GeneratorFormSchemaService } from '../generator-form-schema.service';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
import type { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import type { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import type { IFormSchemaProvider, IPlugin, PluginManifest } from '@ever-works/plugin';

/**
 * Platform demo mode — the generator form's pipeline picker (`providers.pipeline`
 * of `GET /api/works/:id/generator-form`) offers only `standard-pipeline`, and the
 * pipeline the form resolves (`resolvedPipelineId`, which the form then submits)
 * is `standard-pipeline` even when the Work's own setting names another one, and
 * a global default the user enforces is not applied when it names a hidden one.
 */

function pipelinePlugin(id: string): IPlugin & IFormSchemaProvider {
    return {
        id,
        name: id,
        version: '1.0.0',
        category: 'pipeline',
        capabilities: ['pipeline', 'form-schema-provider'],
        settingsSchema: { type: 'object', properties: {} },
        getFormFields: () => [],
        getFormGroups: () => [],
        validateFormInput: () => ({ valid: true }),
    } as unknown as IPlugin & IFormSchemaProvider;
}

function registered(plugin: IPlugin, manifest: Partial<PluginManifest> = {}): RegisteredPlugin {
    return {
        plugin,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: '',
            ...manifest,
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        registeredAt: Date.now(),
        stateHistory: [],
    };
}

describe('GeneratorFormSchemaService — demo pipeline picker', () => {
    const ORIGINAL_ENV = { ...process.env };

    const standard = registered(pipelinePlugin('standard-pipeline'), {
        defaultForCapabilities: ['pipeline'],
    });
    const agent = registered(pipelinePlugin('agent-pipeline'));
    const claudeCode = registered(pipelinePlugin('claude-code'));
    const all = [agent, claudeCode, standard];

    let service: GeneratorFormSchemaService;

    beforeEach(() => {
        const registry = {
            get: jest.fn((id: string) => all.find((r) => r.plugin.id === id)),
            getByCapability: jest.fn((cap: string) =>
                cap === 'pipeline' || cap === 'form-schema-provider' ? all : [],
            ),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as unknown as PluginRegistryService;
        // The Work's own pipeline setting names agent-pipeline.
        const workPlugins = {
            findActiveByCapability: jest.fn(async (_workId: string, capability: string) =>
                capability === 'pipeline' ? { pluginId: 'agent-pipeline' } : null,
            ),
        } as unknown as WorkPluginRepository;
        // ...and the user's global default enforces agent-pipeline too.
        const pluginSettings = {
            getUserGlobalPipelineDefault: jest
                .fn()
                .mockResolvedValue({ pluginId: 'agent-pipeline', enforce: true }),
        } as unknown as PluginSettingsService;
        service = new GeneratorFormSchemaService(registry, workPlugins, pluginSettings);
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('with the demo on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
        });

        it('offers only standard-pipeline', async () => {
            const schema = await service.getFormSchema(undefined, { workId: 'w1', userId: 'u1' });

            expect(schema.providers.pipeline.map((p) => p.id)).toEqual(['standard-pipeline']);
        });

        it('resolves standard-pipeline over the Work’s agent-pipeline setting', async () => {
            const schema = await service.getFormSchema(undefined, { workId: 'w1', userId: 'u1' });

            expect(schema.resolvedPipelineId).toBe('standard-pipeline');
        });

        it('resolves standard-pipeline when another pipeline is asked for', async () => {
            const schema = await service.getFormSchema('agent-pipeline', {
                workId: 'w1',
                userId: 'u1',
            });

            expect(schema.resolvedPipelineId).toBe('standard-pipeline');
        });

        it('does not enforce a pipeline the picker hides', async () => {
            const schema = await service.getFormSchema(undefined, { workId: 'w1', userId: 'u1' });

            expect(schema.enforcedPipelineId).toBeUndefined();
        });
    });

    describe('with the demo off', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it('offers every pipeline and follows the Work’s setting', async () => {
            const schema = await service.getFormSchema(undefined, { workId: 'w1', userId: 'u1' });

            expect(schema.providers.pipeline.map((p) => p.id).sort()).toEqual([
                'agent-pipeline',
                'claude-code',
                'standard-pipeline',
            ]);
            expect(schema.resolvedPipelineId).toBe('agent-pipeline');
            expect(schema.enforcedPipelineId).toBe('agent-pipeline');
        });
    });
});
