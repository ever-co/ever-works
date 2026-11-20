import { ScreenshotFacadeService } from '../screenshot.facade';
import { ScreenshotImageUrlSigner } from '../screenshot-image-url';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { IScreenshotPlugin, PluginManifest } from '@ever-works/plugin';

/**
 * The operator's system default (Gotenberg) is not set up on every instance.
 * Where it is not, the provider a user enabled themselves (ScreenshotOne) must
 * still be used, instead of the default answering "not configured".
 */
describe('ScreenshotFacadeService — an unconfigured system default gives way', () => {
    const facadeOptions = { userId: 'user-1', workId: 'work-1' };

    let gotenberg: jest.Mocked<IScreenshotPlugin>;
    let screenshotone: jest.Mocked<IScreenshotPlugin>;
    let entries: Record<string, RegisteredPlugin>;
    let registry: jest.Mocked<
        Pick<PluginRegistryService, 'get' | 'getByCapability' | 'isPluginEnabledForScope'>
    >;

    function makePlugin(id: string, available: boolean): jest.Mocked<IScreenshotPlugin> {
        return {
            id,
            name: id,
            version: '1.0.0',
            category: 'screenshot',
            capabilities: ['screenshot'],
            settingsSchema: { type: 'object', properties: {} },
            providerName: id,
            onLoad: jest.fn(),
            onUnload: jest.fn(),
            capture: jest.fn().mockResolvedValue({
                success: true,
                imageUrl: `https://img.example/${id}.png`,
            }),
            isAvailable: jest.fn().mockResolvedValue(available),
        } as unknown as jest.Mocked<IScreenshotPlugin>;
    }

    function register(p: IScreenshotPlugin, manifest: Partial<PluginManifest>): RegisteredPlugin {
        return {
            plugin: p as any,
            manifest: {
                id: p.id,
                name: p.name,
                version: '1.0.0',
                description: '',
                category: 'screenshot',
                capabilities: ['screenshot'],
                ...manifest,
            } as PluginManifest,
            state: 'loaded',
            builtIn: false,
            stateHistory: [],
            registeredAt: Date.now(),
        };
    }

    function makeService(): ScreenshotFacadeService {
        return new ScreenshotFacadeService(
            registry as unknown as PluginRegistryService,
            { getSettings: jest.fn().mockResolvedValue({}) } as unknown as PluginSettingsService,
            undefined,
            undefined,
            undefined,
            new ScreenshotImageUrlSigner(undefined, undefined),
        );
    }

    function setUp(gotenbergAvailable: boolean, screenshotoneEnabled = true): void {
        gotenberg = makePlugin('gotenberg', gotenbergAvailable);
        screenshotone = makePlugin('screenshotone', true);
        entries = {
            gotenberg: register(gotenberg, {
                systemPlugin: true,
                autoEnable: true,
                defaultForCapabilities: ['screenshot'],
            }),
            screenshotone: register(screenshotone, { systemPlugin: false }),
        };
        registry = {
            get: jest.fn((id: string) => entries[id]),
            getByCapability: jest.fn(() => Object.values(entries)),
            isPluginEnabledForScope: jest.fn(
                async (id: string) => id === 'gotenberg' || screenshotoneEnabled,
            ),
        } as any;
    }

    it('uses the system default when it is set up', async () => {
        setUp(true);

        const result = await makeService().capture({ url: 'https://example.com' }, facadeOptions);

        expect(result.imageUrl).toBe('https://img.example/gotenberg.png');
        expect(screenshotone.capture).not.toHaveBeenCalled();
    });

    it("falls back to the user's own enabled provider when the system default is not set up", async () => {
        setUp(false);

        const result = await makeService().capture({ url: 'https://example.com' }, facadeOptions);

        expect(result.imageUrl).toBe('https://img.example/screenshotone.png');
        expect(gotenberg.capture).not.toHaveBeenCalled();
    });

    it('keeps the system default when nothing else is enabled (its own error explains what to set)', async () => {
        setUp(false, false);

        await makeService().capture({ url: 'https://example.com' }, facadeOptions);

        expect(gotenberg.capture).toHaveBeenCalled();
    });

    it('never second-guesses an explicit provider choice', async () => {
        setUp(false);

        await makeService().capture(
            { url: 'https://example.com' },
            { ...facadeOptions, providerOverride: 'gotenberg' },
        );

        expect(gotenberg.capture).toHaveBeenCalled();
        expect(screenshotone.capture).not.toHaveBeenCalled();
    });

    it('treats a throwing availability check as not set up', async () => {
        setUp(true);
        gotenberg.isAvailable.mockRejectedValue(new Error('boom'));

        const result = await makeService().capture({ url: 'https://example.com' }, facadeOptions);

        expect(result.imageUrl).toBe('https://img.example/screenshotone.png');
    });

    it('does not consult availability for a non-system provider', async () => {
        setUp(true);
        delete (entries as Record<string, RegisteredPlugin>).gotenberg;
        screenshotone.isAvailable.mockResolvedValue(false);

        const result = await makeService().capture({ url: 'https://example.com' }, facadeOptions);

        expect(result.imageUrl).toBe('https://img.example/screenshotone.png');
        expect(screenshotone.isAvailable).not.toHaveBeenCalled();
    });
});
