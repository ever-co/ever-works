jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginOperationsService: class {},
    PluginRegistryService: class {},
    PluginSettingsService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {},
    ActivityStatus: { COMPLETED: 'COMPLETED' },
}));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { PluginsController } from '../plugins.controller';
import type { PluginOperationsService } from '@ever-works/agent/plugins';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { PluginValidationService } from '../plugin-validation.service';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

/**
 * Platform demo mode — the model and pipeline choices the UI offers.
 *
 * `GET /api/plugins/:id/models` lists only `:free` models on a demo instance (the
 * AI facade already forces a free model on every call; this keeps the picker
 * from offering one it would replace). `GET /api/plugins` hides every pipeline
 * but `standard-pipeline` (the settings default-pipeline picker and the Agents
 * runtime list read it). With the demo off both answer exactly what the
 * service answers.
 */
describe('PluginsController — demo choices', () => {
    const ORIGINAL_ENV = { ...process.env };
    const auth = { userId: 'user-1' } as AuthenticatedUser;

    const models = [
        { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)' },
        { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol' },
        { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron (free)' },
        { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
    ];

    const plugins = [
        { pluginId: 'openrouter', category: 'ai-gateway', capabilities: ['ai-provider'] },
        { pluginId: 'standard-pipeline', category: 'pipeline', capabilities: ['pipeline'] },
        { pluginId: 'agent-pipeline', category: 'pipeline', capabilities: ['pipeline'] },
        { pluginId: 'claude-code', category: 'pipeline', capabilities: ['pipeline'] },
        { pluginId: 'tavily', category: 'search', capabilities: ['search'] },
    ];

    let pluginsService: { listPluginModels: jest.Mock; listPlugins: jest.Mock };
    let listResponse: { plugins: typeof plugins; total: number };
    let controller: PluginsController;

    beforeEach(() => {
        listResponse = {
            plugins,
            total: plugins.length,
        };
        pluginsService = {
            listPluginModels: jest.fn().mockResolvedValue(models),
            listPlugins: jest.fn().mockResolvedValue(listResponse),
        };
        controller = new PluginsController(
            pluginsService as unknown as PluginOperationsService,
            {} as WorkOwnershipService,
            {} as PluginValidationService,
            {} as ActivityLogService,
        );
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('with the demo on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
        });

        it('GET /api/plugins/openrouter/models lists only :free ids', async () => {
            const result = await controller.listPluginModels(auth, 'openrouter');

            expect(pluginsService.listPluginModels).toHaveBeenCalledWith('openrouter', 'user-1');
            expect(result.map((m: { id: string }) => m.id)).toEqual([
                'google/gemma-4-31b-it:free',
                'nvidia/nemotron-3.5-super-vl:free',
            ]);
        });

        it('lists nothing for a provider with no free model', async () => {
            pluginsService.listPluginModels.mockResolvedValue([
                { id: 'claude-opus-5-5' },
                { id: 'claude-sonnet-5' },
            ]);

            await expect(controller.listPluginModels(auth, 'anthropic')).resolves.toEqual([]);
        });

        it('GET /api/plugins hides every pipeline but standard-pipeline', async () => {
            const result = await controller.listPlugins(auth);

            expect(result.plugins.map((p) => p.pluginId)).toEqual([
                'openrouter',
                'standard-pipeline',
                'tavily',
            ]);
            expect(result.total).toBe(3);
        });

        it('GET /api/plugins?category=pipeline offers standard-pipeline only', async () => {
            pluginsService.listPlugins.mockResolvedValue({
                plugins: plugins.filter((p) => p.category === 'pipeline'),
                total: 3,
            });

            const result = await controller.listPlugins(auth, 'pipeline');

            expect(pluginsService.listPlugins).toHaveBeenCalledWith('user-1', 'pipeline');
            expect(result.plugins.map((p) => p.pluginId)).toEqual(['standard-pipeline']);
            expect(result.total).toBe(1);
        });
    });

    describe('with the demo off', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it('GET /api/plugins/openrouter/models lists every model', async () => {
            await expect(controller.listPluginModels(auth, 'openrouter')).resolves.toBe(models);
        });

        it('GET /api/plugins lists every pipeline', async () => {
            await expect(controller.listPlugins(auth)).resolves.toBe(listResponse);
        });
    });
});
