jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class {},
    PluginSettingsService: class {},
    pluginLoadFailure: jest.requireActual(
        '../../../../packages/agent/src/plugins/services/plugin-operation.util',
    ).pluginLoadFailure,
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class {},
}));

import { PluginValidationService } from './plugin-validation.service';
import type { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import type { GitFacadeService } from '@ever-works/agent/facades';
import {
    DemoFeatureDisabledError,
    DemoModelNotAllowedError,
    DemoQuotaExceededError,
    type DemoAiQuotaPort,
} from '@ever-works/agent/demo';

/**
 * Platform demo mode (`DEMO=true`) — an AI provider's connection check
 * (`BaseAiProvider.validateConnection`) sends a one-line completion to every
 * tier model in its settings. On a demo instance only `openrouter` may be
 * checked, only its `:free` models are sent, and each one is counted against
 * the demo AI quota. Other plugins, and every plugin with `DEMO` unset, are
 * checked exactly as before.
 */
describe('PluginValidationService — demo mode', () => {
    const originalDemo = process.env.DEMO;
    let pluginRegistry: { get: jest.Mock };
    let pluginSettings: { getSettings: jest.Mock };
    let quota: { consume: jest.Mock };
    let validateConnection: jest.Mock;
    let service: PluginValidationService;

    const registered = (id: string, capabilities: string[]) => ({
        state: 'loaded',
        plugin: { id, name: id, capabilities, validateConnection },
    });

    beforeEach(() => {
        process.env.DEMO = 'true';
        validateConnection = jest.fn().mockResolvedValue({ success: true, message: 'ok' });
        pluginRegistry = { get: jest.fn() };
        pluginSettings = {
            getSettings: jest.fn().mockResolvedValue({
                apiKey: 'sk-or',
                defaultModel: 'google/gemma-4-31b-it:free',
                simpleModel: 'openai/gpt-6.1-mini',
                complexModel: 'deepseek/deepseek-r3:free',
            }),
        };
        quota = { consume: jest.fn().mockResolvedValue(undefined) };
        service = new PluginValidationService(
            pluginRegistry as unknown as PluginRegistryService,
            pluginSettings as unknown as PluginSettingsService,
            {} as GitFacadeService,
            quota as DemoAiQuotaPort,
        );
        jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalDemo === undefined) delete process.env.DEMO;
        else process.env.DEMO = originalDemo;
    });

    it('checks openrouter with its free models only, counting each one', async () => {
        pluginRegistry.get.mockReturnValue(registered('openrouter', ['ai-provider']));

        await service.validateUserPluginConnection('openrouter', 'u-1');

        expect(validateConnection).toHaveBeenCalledWith({
            apiKey: 'sk-or',
            defaultModel: 'google/gemma-4-31b-it:free',
            complexModel: 'deepseek/deepseek-r3:free',
        });
        expect(quota.consume.mock.calls).toEqual([['u-1'], ['u-1']]);
    });

    it('refuses to check another AI provider: nothing is sent', async () => {
        pluginRegistry.get.mockReturnValue(registered('anthropic', ['ai-provider']));

        await expect(
            service.validateUserPluginConnection('anthropic', 'u-1'),
        ).rejects.toBeInstanceOf(DemoFeatureDisabledError);
        await expect(service.tryValidateConnection('anthropic', 'u-1')).resolves.toBeNull();

        expect(validateConnection).not.toHaveBeenCalled();
        expect(quota.consume).not.toHaveBeenCalled();
    });

    it('fails closed when openrouter has no free model', async () => {
        pluginRegistry.get.mockReturnValue(registered('openrouter', ['ai-provider']));
        pluginSettings.getSettings.mockResolvedValue({
            apiKey: 'sk-or',
            defaultModel: 'openai/gpt-6.1-sol',
        });

        await expect(
            service.validateUserPluginConnection('openrouter', 'u-1'),
        ).rejects.toBeInstanceOf(DemoModelNotAllowedError);

        expect(validateConnection).not.toHaveBeenCalled();
        expect(quota.consume).not.toHaveBeenCalled();
    });

    it('a used-up quota means no check is sent', async () => {
        pluginRegistry.get.mockReturnValue(registered('openrouter', ['ai-provider']));
        quota.consume.mockRejectedValue(new DemoQuotaExceededError('sandbox'));

        await expect(
            service.validateUserPluginConnection('openrouter', 'u-1'),
        ).rejects.toBeInstanceOf(DemoQuotaExceededError);

        expect(validateConnection).not.toHaveBeenCalled();
    });

    it('fails closed when no quota port is bound: nothing is sent, the gap is logged once', async () => {
        const unbound = new PluginValidationService(
            pluginRegistry as unknown as PluginRegistryService,
            pluginSettings as unknown as PluginSettingsService,
            {} as GitFacadeService,
        );
        const errorLog = jest.spyOn(unbound['logger'], 'error').mockImplementation(() => undefined);
        jest.spyOn(unbound['logger'], 'warn').mockImplementation(() => undefined);
        pluginRegistry.get.mockReturnValue(registered('openrouter', ['ai-provider']));

        const error = await unbound
            .validateUserPluginConnection('openrouter', 'u-1')
            .catch((e) => e);
        await expect(unbound.tryValidateConnection('openrouter', 'u-1')).resolves.toBeNull();

        expect(error).toBeInstanceOf(DemoFeatureDisabledError);
        expect(error.feature).toBe('ai (quota not configured)');
        expect(validateConnection).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('DEMO_AI_QUOTA'));
    });

    it('a plugin that is not an AI provider is checked as before', async () => {
        pluginRegistry.get.mockReturnValue(registered('tavily', ['search']));
        pluginSettings.getSettings.mockResolvedValue({ apiKey: 'tv' });

        await service.validateUserPluginConnection('tavily', 'u-1');

        expect(validateConnection).toHaveBeenCalledWith({ apiKey: 'tv' });
        expect(quota.consume).not.toHaveBeenCalled();
    });

    it('with DEMO unset, any AI provider is checked with its own settings', async () => {
        delete process.env.DEMO;
        pluginRegistry.get.mockReturnValue(registered('anthropic', ['ai-provider']));

        await service.validateUserPluginConnection('anthropic', 'u-1');

        expect(validateConnection).toHaveBeenCalledWith({
            apiKey: 'sk-or',
            defaultModel: 'google/gemma-4-31b-it:free',
            simpleModel: 'openai/gpt-6.1-mini',
            complexModel: 'deepseek/deepseek-r3:free',
        });
        expect(quota.consume).not.toHaveBeenCalled();
    });
});
