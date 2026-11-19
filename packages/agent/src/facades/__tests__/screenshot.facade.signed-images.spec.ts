import { ScreenshotFacadeService } from '../screenshot.facade';
import { ScreenshotImageUrlSigner } from '../screenshot-image-url';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { IScreenshotPlugin, PluginManifest, ScreenshotResult } from '@ever-works/plugin';

/**
 * Screenshot providers that answer image BYTES (self-hosted Gotenberg) get
 * signed, public image URLs on the platform's API instead of no image.
 */
describe('ScreenshotFacadeService — signed images for bytes-only providers', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const facadeOptions = { userId: 'user-1', workId: 'work-1' };

    let signer: ScreenshotImageUrlSigner;
    let registry: jest.Mocked<
        Pick<PluginRegistryService, 'get' | 'getByCapability' | 'isPluginEnabledForScope'>
    >;
    let settingsService: jest.Mocked<Pick<PluginSettingsService, 'getSettings'>>;
    let plugin: jest.Mocked<IScreenshotPlugin>;
    let registered: RegisteredPlugin;

    function makePlugin(id: string, result: ScreenshotResult): jest.Mocked<IScreenshotPlugin> {
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
            capture: jest.fn().mockResolvedValue(result),
            isAvailable: jest.fn().mockResolvedValue(true),
        } as unknown as jest.Mocked<IScreenshotPlugin>;
    }

    function register(
        p: IScreenshotPlugin,
        manifest: Partial<PluginManifest> = {},
    ): RegisteredPlugin {
        return {
            plugin: p as any,
            manifest: {
                id: p.id,
                name: p.name,
                version: '1.0.0',
                description: '',
                category: 'screenshot',
                capabilities: ['screenshot'],
                systemPlugin: true,
                autoEnable: true,
                defaultForCapabilities: ['screenshot'],
                ...manifest,
            } as PluginManifest,
            state: 'loaded',
            builtIn: true,
            stateHistory: [],
            registeredAt: Date.now(),
        };
    }

    function makeService(withSigner: ScreenshotImageUrlSigner = signer): ScreenshotFacadeService {
        return new ScreenshotFacadeService(
            registry as unknown as PluginRegistryService,
            settingsService as unknown as PluginSettingsService,
            undefined,
            undefined,
            undefined,
            withSigner,
        );
    }

    /** The `{payload}.{signature}.{ext}` segment of a minted URL. */
    const segmentOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

    beforeEach(() => {
        signer = new ScreenshotImageUrlSigner('https://api.ever.works', 'platform-secret');
        plugin = makePlugin('gotenberg', {
            success: true,
            imageBuffer: PNG,
            imageBase64: PNG.toString('base64'),
        });
        registered = register(plugin);
        registry = {
            get: jest.fn((id: string) => (id === 'gotenberg' ? registered : undefined)),
            getByCapability: jest.fn().mockReturnValue([registered]),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as any;
        settingsService = {
            getSettings: jest.fn().mockResolvedValue({ baseUrl: 'http://gotenberg:3000' }),
        } as any;
    });

    describe('getSmartImage', () => {
        it('gives a bytes-only capture a signed URL that renders the same capture', async () => {
            const service = makeService();

            const result = await service.getSmartImage(
                { url: 'https://example.com' },
                facadeOptions,
            );

            expect(result.source).toBe('screenshot');
            expect(result.primaryImage).toMatch(
                /^https:\/\/api\.ever\.works\/api\/screenshot\/image\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.png$/,
            );
            expect(signer.verify(segmentOf(result.primaryImage!))).toEqual({
                pluginId: 'gotenberg',
                url: 'https://example.com',
                viewportWidth: 1280,
                viewportHeight: 800,
                format: 'png',
                fullPage: false,
            });
        });

        it("keeps a provider's own URL when it gives one", async () => {
            plugin.capture.mockResolvedValue({
                success: true,
                imageUrl: 'https://api.screenshotone.com/take?url=x',
                imageBuffer: PNG,
            });

            const result = await makeService().getSmartImage(
                { url: 'https://example.com' },
                facadeOptions,
            );

            expect(result.primaryImage).toBe('https://api.screenshotone.com/take?url=x');
        });

        it('gives no image when the capture failed', async () => {
            plugin.capture.mockResolvedValue({
                success: false,
                error: 'Gotenberg answered HTTP 409',
            });

            const result = await makeService().getSmartImage(
                { url: 'https://example.com' },
                facadeOptions,
            );

            expect(result.primaryImage).toBeUndefined();
        });

        it('never mints a URL for an unsafe target, even when a provider returned bytes for it', async () => {
            const result = await makeService().getSmartImage(
                { url: 'http://169.254.169.254/latest/meta-data/' },
                facadeOptions,
            );

            expect(result.primaryImage).toBeUndefined();
        });

        it('gives no image, as before, when signing is not configured', async () => {
            const service = makeService(new ScreenshotImageUrlSigner(undefined, undefined));

            const result = await service.getSmartImage(
                { url: 'https://example.com' },
                facadeOptions,
            );

            expect(result.primaryImage).toBeUndefined();
        });
    });

    describe('getScreenshotUrl', () => {
        it('mints a signed URL for a provider without URLs of its own', async () => {
            const url = await makeService().getScreenshotUrl(
                {
                    url: 'https://example.com',
                    format: 'webp',
                    viewportWidth: 1024,
                    viewportHeight: 768,
                },
                facadeOptions,
            );

            expect(url).toMatch(/\.webp$/);
            expect(signer.verify(segmentOf(url!))).toMatchObject({
                pluginId: 'gotenberg',
                format: 'webp',
                viewportWidth: 1024,
                viewportHeight: 768,
            });
            expect(plugin.capture).not.toHaveBeenCalled();
        });

        it('mints nothing for an unsafe target', async () => {
            const url = await makeService().getScreenshotUrl(
                { url: 'http://169.254.169.254/latest/meta-data/' },
                facadeOptions,
            );

            expect(url).toBeNull();
        });
    });

    describe('renderSignedImage', () => {
        it('renders a signed URL with the global settings, no user and no Work', async () => {
            const service = makeService();
            const minted = signer.createUrl({
                pluginId: 'gotenberg',
                url: 'https://example.com',
                viewportWidth: 1280,
                viewportHeight: 800,
                format: 'png',
                fullPage: false,
            })!;

            const rendered = await service.renderSignedImage(segmentOf(minted));

            expect(rendered).toEqual({ image: PNG, contentType: 'image/png' });
            expect(settingsService.getSettings).toHaveBeenCalledWith('gotenberg', {
                includeSecrets: true,
            });
            expect(plugin.capture).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://example.com',
                    viewportWidth: 1280,
                    viewportHeight: 800,
                    format: 'png',
                    fullPage: false,
                    settings: { baseUrl: 'http://gotenberg:3000' },
                }),
            );
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'gotenberg',
                undefined,
                undefined,
            );
        });

        it('renders nothing for a segment it did not sign', async () => {
            const other = new ScreenshotImageUrlSigner('https://api.ever.works', 'someone-else');
            const forged = other.createUrl({
                pluginId: 'gotenberg',
                url: 'https://attacker.example',
                viewportWidth: 1280,
                viewportHeight: 800,
                format: 'png',
                fullPage: false,
            })!;

            expect(await makeService().renderSignedImage(segmentOf(forged))).toBeNull();
            expect(await makeService().renderSignedImage('garbage')).toBeNull();
            expect(plugin.capture).not.toHaveBeenCalled();
        });

        it('renders nothing when the signed provider is not globally enabled', async () => {
            registry.isPluginEnabledForScope.mockResolvedValue(false);
            const minted = signer.createUrl({
                pluginId: 'gotenberg',
                url: 'https://example.com',
                viewportWidth: 1280,
                viewportHeight: 800,
                format: 'png',
                fullPage: false,
            })!;

            expect(await makeService().renderSignedImage(segmentOf(minted))).toBeNull();
            expect(plugin.capture).not.toHaveBeenCalled();
        });

        it('renders nothing for an unknown provider', async () => {
            const minted = signer.createUrl({
                pluginId: 'nope',
                url: 'https://example.com',
                viewportWidth: 1280,
                viewportHeight: 800,
                format: 'png',
                fullPage: false,
            })!;

            expect(await makeService().renderSignedImage(segmentOf(minted))).toBeNull();
        });

        it('refuses a correctly signed unsafe target before any provider sees it', async () => {
            const minted = signer.createUrl({
                pluginId: 'gotenberg',
                url: 'http://169.254.169.254/latest/meta-data/',
                viewportWidth: 1280,
                viewportHeight: 800,
                format: 'png',
                fullPage: false,
            })!;

            expect(await makeService().renderSignedImage(segmentOf(minted))).toBeNull();
            expect(plugin.capture).not.toHaveBeenCalled();
        });

        describe('render cache', () => {
            const mint = (url: string) =>
                segmentOf(
                    signer.createUrl({
                        pluginId: 'gotenberg',
                        url,
                        viewportWidth: 1280,
                        viewportHeight: 800,
                        format: 'png',
                        fullPage: false,
                    })!,
                );

            afterEach(() => jest.restoreAllMocks());

            it('serves a repeated request from the cache, so a cache-busting query cannot force renders', async () => {
                const service = makeService();
                const segment = mint('https://example.com');

                const first = await service.renderSignedImage(segment);
                const second = await service.renderSignedImage(segment);

                expect(second).toEqual(first);
                expect(plugin.capture).toHaveBeenCalledTimes(1);
            });

            it('shares one render among concurrent requests', async () => {
                let finish!: (r: ScreenshotResult) => void;
                plugin.capture.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
                const service = makeService();
                const segment = mint('https://example.com');

                const both = Promise.all([
                    service.renderSignedImage(segment),
                    service.renderSignedImage(segment),
                ]);
                // Let both requests reach the in-flight render before it ends.
                await new Promise((resolve) => setImmediate(resolve));
                finish({ success: true, imageBuffer: PNG });

                const [a, b] = await both;
                expect(a).toEqual({ image: PNG, contentType: 'image/png' });
                expect(b).toBe(a);
                expect(plugin.capture).toHaveBeenCalledTimes(1);
            });

            it('remembers a failure for a minute, then tries again', async () => {
                const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
                plugin.capture.mockResolvedValue({ success: false, error: 'site down' });
                const service = makeService();
                const segment = mint('https://example.com');

                expect(await service.renderSignedImage(segment)).toBeNull();
                expect(await service.renderSignedImage(segment)).toBeNull();
                expect(plugin.capture).toHaveBeenCalledTimes(1);

                now.mockReturnValue(1_000_000 + 61_000);
                plugin.capture.mockResolvedValue({ success: true, imageBuffer: PNG });
                expect(await service.renderSignedImage(segment)).toEqual({
                    image: PNG,
                    contentType: 'image/png',
                });
                expect(plugin.capture).toHaveBeenCalledTimes(2);
            });

            it('re-renders after ten minutes', async () => {
                const now = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
                const service = makeService();
                const segment = mint('https://example.com');

                await service.renderSignedImage(segment);
                now.mockReturnValue(5_000_000 + 9 * 60_000);
                await service.renderSignedImage(segment);
                expect(plugin.capture).toHaveBeenCalledTimes(1);

                now.mockReturnValue(5_000_000 + 11 * 60_000);
                await service.renderSignedImage(segment);
                expect(plugin.capture).toHaveBeenCalledTimes(2);
            });

            it('keeps at most 64 renders, dropping the least recently used', async () => {
                const service = makeService();
                const segments = Array.from({ length: 65 }, (_, i) =>
                    mint(`https://example.com/${i}`),
                );

                for (const segment of segments) await service.renderSignedImage(segment);
                expect(plugin.capture).toHaveBeenCalledTimes(65);

                // The newest is still cached; the oldest was dropped.
                await service.renderSignedImage(segments[64]);
                expect(plugin.capture).toHaveBeenCalledTimes(65);
                await service.renderSignedImage(segments[0]);
                expect(plugin.capture).toHaveBeenCalledTimes(66);
            });
        });

        it('renders nothing when the capture fails or throws', async () => {
            const minted = segmentOf(
                signer.createUrl({
                    pluginId: 'gotenberg',
                    url: 'https://example.com',
                    viewportWidth: 1280,
                    viewportHeight: 800,
                    format: 'webp',
                    fullPage: true,
                })!,
            );

            plugin.capture.mockResolvedValueOnce({ success: false, error: 'boom' });
            expect(await makeService().renderSignedImage(minted)).toBeNull();

            plugin.capture.mockResolvedValueOnce({ success: true, imageBuffer: Buffer.alloc(0) });
            expect(await makeService().renderSignedImage(minted)).toBeNull();

            plugin.capture.mockRejectedValueOnce(new Error('socket hang up'));
            expect(await makeService().renderSignedImage(minted)).toBeNull();
        });
    });
});
