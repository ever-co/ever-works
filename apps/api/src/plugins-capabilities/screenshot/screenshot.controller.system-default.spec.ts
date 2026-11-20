jest.mock('@ever-works/agent/facades', () => ({
    ScreenshotFacadeService: class {},
    NoProviderError: class NoProviderError extends Error {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class {},
    PluginSettingsService: class {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { ScreenshotController } from './screenshot.controller';
import type { ScreenshotFacadeService } from '@ever-works/agent/facades';
import type { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

/**
 * The self-hosted Gotenberg default is a SYSTEM plugin with no required
 * setting; its own `isAvailable()` (is PLUGIN_GOTENBERG_BASE_URL set?) decides
 * whether it counts as configured. Where it is not set up, the provider a user
 * enabled is reported as active, as the facade will use it.
 */
describe('ScreenshotController — system default provider', () => {
    const auth: AuthenticatedUser = { userId: 'user-1' } as any;
    let pluginRegistry: {
        getEnabledPluginsScoped: jest.Mock;
        getDefaultForCapabilityScoped: jest.Mock;
    };
    let screenshotFacade: { capture: jest.Mock; getScreenshotUrl: jest.Mock };
    let controller: ScreenshotController;

    const gotenberg = (available: boolean | Error) => ({
        plugin: {
            id: 'gotenberg',
            name: 'Gotenberg',
            settingsSchema: { type: 'object', properties: {} },
            isAvailable: jest.fn(() =>
                available instanceof Error ? Promise.reject(available) : Promise.resolve(available),
            ),
        },
        manifest: { defaultForCapabilities: ['screenshot'], systemPlugin: true },
    });

    const screenshotone = () => ({
        plugin: {
            id: 'screenshotone',
            name: 'ScreenshotOne',
            settingsSchema: { type: 'object', required: ['accessKey'], properties: {} },
            // Global settings only: must NOT decide for a BYOK plugin.
            isAvailable: jest.fn().mockResolvedValue(false),
        },
        manifest: { systemPlugin: false },
    });

    beforeEach(() => {
        pluginRegistry = {
            getEnabledPluginsScoped: jest.fn(),
            getDefaultForCapabilityScoped: jest.fn(),
        };
        screenshotFacade = { capture: jest.fn(), getScreenshotUrl: jest.fn() };
        controller = new ScreenshotController(
            screenshotFacade as unknown as ScreenshotFacadeService,
            pluginRegistry as unknown as PluginRegistryService,
            {
                getSettings: jest.fn().mockResolvedValue({ accessKey: 'user-key' }),
            } as unknown as PluginSettingsService,
            { ensureCanView: jest.fn() } as unknown as WorkOwnershipService,
        );
    });

    it('reports the system default as configured and active when it is set up', async () => {
        const g = gotenberg(true);
        pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([g]);
        pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(g);

        const result = await controller.checkAvailability(auth);

        expect(result.available).toBe(true);
        expect(result.providers).toEqual([
            expect.objectContaining({ id: 'gotenberg', configured: true, isDefault: true }),
        ]);
        expect(result.activeProvider?.id).toBe('gotenberg');
    });

    it('reports it as not configured where it is not set up, so nothing claims to be available', async () => {
        const g = gotenberg(false);
        pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([g]);
        pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(g);

        const result = await controller.checkAvailability(auth);

        expect(result.available).toBe(false);
        expect(result.providers).toEqual([
            expect.objectContaining({ id: 'gotenberg', configured: false, isDefault: true }),
        ]);
        // Nothing else to use: the default stays named, so the operator sees what to set up.
        expect(result.activeProvider?.id).toBe('gotenberg');
        await expect(
            controller.capture(auth, { url: 'https://example.com' } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(screenshotFacade.capture).not.toHaveBeenCalled();
    });

    it("names the user's own provider as active when the system default is not set up", async () => {
        const g = gotenberg(false);
        const s = screenshotone();
        pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([g, s]);
        pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(g);

        const result = await controller.checkAvailability(auth);

        expect(result.available).toBe(true);
        expect(result.providers.map((p) => [p.id, p.configured])).toEqual([
            ['gotenberg', false],
            ['screenshotone', true],
        ]);
        expect(result.activeProvider?.id).toBe('screenshotone');
        // A bring-your-own-key plugin is judged by its resolved settings, not isAvailable().
        expect(s.plugin.isAvailable).not.toHaveBeenCalled();
    });

    it('keeps the system default active over a user provider when it is set up', async () => {
        const g = gotenberg(true);
        pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([g, screenshotone()]);
        pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(g);

        const result = await controller.checkAvailability(auth);

        expect(result.activeProvider?.id).toBe('gotenberg');
    });

    it('treats a throwing availability check as not set up', async () => {
        const g = gotenberg(new Error('boom'));
        pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([g]);
        pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(g);

        const result = await controller.checkAvailability(auth);

        expect(result.providers[0].configured).toBe(false);
    });
});
