import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    ScreenshotCaptureOptions,
    ScreenshotCaptureResult,
    ScreenshotFormat,
    ScreenshotResult,
    SmartImageOptions,
    SmartImageResult,
    IScreenshotPlugin,
    IScreenshotFacade,
    FacadeOptions,
    IPlugin,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { BudgetGuardService } from '../budgets/budget-guard.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { UsageOutcome } from '@src/entities/_types';
import { BaseFacadeService, FacadeError } from './base.facade';
import { ScreenshotImageUrlSigner, screenshotContentType } from './screenshot-image-url';

export class ScreenshotFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'ScreenshotFacadeError';
    }
}

/** The capture `getSmartImage` asks for: a viewport-sized PNG, ads blocked. */
const SMART_IMAGE_CAPTURE = {
    viewportWidth: 1280,
    viewportHeight: 800,
    format: 'png',
    fullPage: false,
    blockAds: true,
    blockCookieBanners: true,
    cache: true,
} as const satisfies Omit<ScreenshotCaptureOptions, 'url'>;

/** The image bytes a signed screenshot URL renders to. */
export interface SignedScreenshotImageResult {
    readonly image: Buffer;
    readonly contentType: string;
}

/**
 * The public image route sits behind a CDN, but a query string makes every
 * request a CDN miss, so the same signed URL could be made to re-render over
 * and over. Each API process keeps recent renders (and recent failures, for
 * less time) and shares one render among concurrent requests for a URL.
 */
const RENDER_CACHE_TTL_MS = 10 * 60_000;
const RENDER_FAILURE_TTL_MS = 60_000;
const RENDER_CACHE_MAX_ENTRIES = 64;
const RENDER_CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface CachedRender {
    readonly result: SignedScreenshotImageResult | null;
    readonly expiresAt: number;
}

@Injectable()
export class ScreenshotFacadeService extends BaseFacadeService implements IScreenshotFacade {
    protected readonly logger = new Logger(ScreenshotFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.SCREENSHOT;

    /**
     * Mints and checks the public URLs of screenshots whose provider returns
     * bytes only (self-hosted Gotenberg). Built from the environment unless a
     * test passes one.
     */
    private readonly imageUrls: ScreenshotImageUrlSigner;
    private warnedSigningDisabled = false;

    /** Recent signed renders by segment, oldest first (see RENDER_CACHE_*). */
    private readonly renderCache = new Map<string, CachedRender>();
    private renderCacheBytes = 0;
    private readonly rendersInFlight = new Map<
        string,
        Promise<SignedScreenshotImageResult | null>
    >();

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly pluginUsageService?: PluginUsageService,
        @Optional() private readonly budgetGuard?: BudgetGuardService,
        @Optional() imageUrlSigner?: ScreenshotImageUrlSigner,
    ) {
        super(registry, settingsService, workPluginRepository);
        this.imageUrls = imageUrlSigner ?? ScreenshotImageUrlSigner.fromEnv();
    }

    async capture(
        options: ScreenshotCaptureOptions,
        facadeOptions: FacadeOptions,
    ): Promise<ScreenshotCaptureResult> {
        const { result } = await this.captureWithProvider(options, facadeOptions);

        return {
            success: result.success,
            imageUrl: result.imageUrl,
            cacheUrl: result.cacheUrl,
            imageBuffer: result.imageBuffer,
            error: result.error,
        };
    }

    /**
     * The image a Work item shows for `options.url`.
     *
     * A provider that hands back its own URL (ScreenshotOne, Urlbox) gives that
     * URL. A provider that hands back bytes only (Gotenberg) gets a signed URL
     * on this API, served by `renderSignedImage`; without
     * `SCREENSHOT_IMAGE_BASE_URL` such a capture yields no image, as before.
     */
    async getSmartImage(
        options: SmartImageOptions,
        facadeOptions: FacadeOptions,
    ): Promise<SmartImageResult> {
        const { pluginId, result } = await this.captureWithProvider(
            { url: options.url, ...SMART_IMAGE_CAPTURE },
            facadeOptions,
        );

        let primaryImage = result.cacheUrl || result.imageUrl;
        if (!primaryImage && result.success && result.imageBuffer) {
            primaryImage =
                this.signedImageUrl(pluginId, {
                    url: options.url,
                    ...SMART_IMAGE_CAPTURE,
                }) ?? undefined;
        }

        return {
            primaryImage,
            source: 'screenshot',
        };
    }

    async getScreenshotUrl(
        options: ScreenshotCaptureOptions,
        facadeOptions: FacadeOptions,
    ): Promise<string | null> {
        const plugin = await this.resolvePlugin<IScreenshotPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );

        if (plugin.getScreenshotUrl) {
            const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
            return plugin.getScreenshotUrl({ ...options, settings });
        }

        // A bytes-only provider has no URL of its own: hand out a signed URL
        // that renders on first request (never for an unsafe target).
        return this.signedImageUrl(plugin.id, options);
    }

    /**
     * Render the screenshot a signed URL names (`{payload}.{signature}.{ext}`),
     * for the public image route. `null` for a segment this platform did not
     * sign, a provider that is no longer a usable, globally enabled screenshot
     * plugin, or a capture that failed — the route answers 404 for all of them.
     *
     * There is no user or Work here: the provider runs with its global
     * (operator) settings, and nothing is charged to anyone. Only a provider
     * enabled without a user — a system plugin such as Gotenberg — resolves.
     *
     * The target is checked again (`isSafeWebhookUrl`) whatever the provider
     * does, so a signing bug alone cannot open a private address. Renders are
     * cached per process for 10 minutes (failures for 1), and concurrent
     * requests for one URL share a render: a query string defeats the CDN,
     * not this.
     */
    async renderSignedImage(segment: string): Promise<SignedScreenshotImageResult | null> {
        const signed = this.imageUrls.verify(segment);
        if (!signed || !isSafeWebhookUrl(signed.url)) return null;

        const cached = this.renderCache.get(segment);
        if (cached && cached.expiresAt > Date.now()) {
            // Most recently used last.
            this.renderCache.delete(segment);
            this.renderCache.set(segment, cached);
            return cached.result;
        }

        const inFlight = this.rendersInFlight.get(segment);
        if (inFlight) return inFlight;

        const render = this.renderVerified(signed)
            .catch(() => null)
            .then((result) => {
                this.rememberRender(segment, result);
                return result;
            })
            .finally(() => this.rendersInFlight.delete(segment));
        this.rendersInFlight.set(segment, render);
        return render;
    }

    private async renderVerified(
        signed: NonNullable<ReturnType<ScreenshotImageUrlSigner['verify']>>,
    ): Promise<SignedScreenshotImageResult | null> {
        let plugin: IScreenshotPlugin;
        try {
            plugin = await this.resolvePlugin<IScreenshotPlugin>(signed.pluginId);
        } catch {
            return null;
        }

        // Global (operator) settings: no user or Work scope applies here.
        const settings = this.settingsService
            ? await this.settingsService.getSettings(plugin.id, { includeSecrets: true })
            : {};
        let result: ScreenshotResult;
        try {
            result = await plugin.capture({
                url: signed.url,
                viewportWidth: signed.viewportWidth,
                viewportHeight: signed.viewportHeight,
                format: signed.format,
                fullPage: signed.fullPage,
                blockAds: true,
                blockCookieBanners: true,
                cache: true,
                settings,
            });
        } catch (error) {
            this.logger.warn(
                `Signed screenshot render via ${plugin.id} threw: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }

        if (!result.success || !result.imageBuffer || result.imageBuffer.length === 0) {
            this.logger.warn(
                `Signed screenshot render via ${plugin.id} failed: ${result.error ?? 'no image returned'}`,
            );
            return null;
        }

        return {
            image: result.imageBuffer,
            contentType: screenshotContentType(signed.format),
        };
    }

    /** Keep a render (or a failure, briefly) within the entry and byte limits. */
    private rememberRender(segment: string, result: SignedScreenshotImageResult | null): void {
        this.forgetRender(segment);
        const size = result?.image.length ?? 0;
        if (size > RENDER_CACHE_MAX_BYTES) return;

        const ttl = result ? RENDER_CACHE_TTL_MS : RENDER_FAILURE_TTL_MS;
        this.renderCache.set(segment, { result, expiresAt: Date.now() + ttl });
        this.renderCacheBytes += size;

        for (const oldest of this.renderCache.keys()) {
            if (
                this.renderCache.size <= RENDER_CACHE_MAX_ENTRIES &&
                this.renderCacheBytes <= RENDER_CACHE_MAX_BYTES
            ) {
                break;
            }
            this.forgetRender(oldest);
        }
    }

    private forgetRender(segment: string): void {
        const entry = this.renderCache.get(segment);
        if (!entry) return;
        this.renderCacheBytes -= entry.result?.image.length ?? 0;
        this.renderCache.delete(segment);
    }

    /**
     * The usual resolution (override > Work's active provider > default >
     * first enabled), except that an operator's SYSTEM default that is not set
     * up on this instance — the Gotenberg plugin without
     * PLUGIN_GOTENBERG_BASE_URL — gives way to the next provider the user
     * enabled (e.g. their own ScreenshotOne). An explicit provider choice
     * always stands.
     */
    protected override async resolvePlugin<T extends IPlugin>(
        providerOverride?: string,
        userId?: string,
        workId?: string,
        agentProviderOverride?: string,
    ): Promise<T> {
        const plugin = await super.resolvePlugin<T>(
            providerOverride,
            userId,
            workId,
            agentProviderOverride,
        );
        if (providerOverride || agentProviderOverride) return plugin;
        if (!this.registry.get(plugin.id)?.manifest.systemPlugin) return plugin;
        if (await this.reportsAvailable(plugin)) return plugin;

        const fallback = (await this.getEnabledPlugins(workId as string, userId as string)).find(
            (candidate) => candidate.plugin.id !== plugin.id,
        );
        if (!fallback) return plugin;

        this.logger.debug(
            `Screenshot provider "${plugin.id}" is not set up here; using "${fallback.plugin.id}"`,
        );
        return super.resolvePlugin<T>(fallback.plugin.id, userId, workId);
    }

    private async reportsAvailable(plugin: IPlugin): Promise<boolean> {
        const isAvailable = (plugin as Partial<IScreenshotPlugin>).isAvailable;
        if (typeof isAvailable !== 'function') return true;
        try {
            return await isAvailable.call(plugin);
        } catch {
            return false;
        }
    }

    isAvailable(): boolean {
        return this.isConfigured();
    }

    /**
     * Resolve the provider, check the budget, capture, and record usage.
     * Returns the provider's id with the result so a caller can mint its
     * signed URL.
     */
    private async captureWithProvider(
        options: ScreenshotCaptureOptions,
        facadeOptions: FacadeOptions,
    ): Promise<{ pluginId: string; result: ScreenshotResult }> {
        const plugin = await this.resolvePlugin<IScreenshotPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );

        if (this.budgetGuard && facadeOptions.workId && facadeOptions.userId) {
            await this.budgetGuard.checkBudget(
                facadeOptions.workId,
                facadeOptions.userId,
                PluginUsageCapability.SCREENSHOT,
                plugin.id,
            );
        }

        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);

        const result = await plugin.capture({
            url: options.url,
            viewportWidth: options.viewportWidth,
            viewportHeight: options.viewportHeight,
            format: options.format,
            fullPage: options.fullPage,
            delay: options.delay,
            blockAds: options.blockAds,
            blockTrackers: options.blockTrackers,
            blockCookieBanners: options.blockCookieBanners,
            cache: options.cache,
            cacheTtl: options.cacheTtl,
            settings,
        });

        if (result.success) {
            const pricing = (await plugin.getPricing?.()) ?? null;
            await this.pluginUsageService?.record({
                workId: facadeOptions.workId,
                userId: facadeOptions.userId,
                // Phase 15.6 — Agent/Task attribution propagation.
                agentId: facadeOptions.agentId,
                taskId: facadeOptions.taskId,
                // Wave 9 M2 — per-run cost attribution.
                runId: facadeOptions.runId,
                // AW-17 — the Mission of the run's Task.
                missionId: facadeOptions.missionId,
                pluginId: plugin.id,
                capability: PluginUsageCapability.SCREENSHOT,
                units: 1,
                costCents: pricing?.costPerCallCents ?? 0,
                currency: pricing?.currency,
                metadata: {
                    operation: 'capture',
                    url: options.url,
                    fullPage: options.fullPage ?? false,
                },
            });
        } else {
            // AW-17 — a capture the provider reported as failed is still a
            // call on the receipt, zero-rated. The provider's error text is
            // never copied onto the row.
            await this.pluginUsageService?.record({
                workId: facadeOptions.workId,
                userId: facadeOptions.userId,
                agentId: facadeOptions.agentId,
                taskId: facadeOptions.taskId,
                runId: facadeOptions.runId,
                missionId: facadeOptions.missionId,
                pluginId: plugin.id,
                capability: PluginUsageCapability.SCREENSHOT,
                units: 1,
                costCents: 0,
                outcome: UsageOutcome.FAILED,
                metadata: { operation: 'capture', url: options.url, failed: true },
            });
        }

        return { pluginId: plugin.id, result };
    }

    /**
     * A signed public URL for this capture, or `null` when signing is off or
     * the target is not a public HTTP(S) URL: no URL is ever minted for a
     * private, loopback, link-local or non-HTTP(S) target, whatever the
     * provider did with it.
     */
    private signedImageUrl(pluginId: string, options: ScreenshotCaptureOptions): string | null {
        if (!isSafeWebhookUrl(options.url)) {
            return null;
        }
        if (!this.imageUrls.isEnabled()) {
            if (!this.warnedSigningDisabled) {
                this.warnedSigningDisabled = true;
                this.logger.warn(
                    `Screenshot provider "${pluginId}" returns image bytes only; set SCREENSHOT_IMAGE_BASE_URL ` +
                        '(and PLATFORM_ENCRYPTION_KEY or SCREENSHOT_IMAGE_SIGNING_SECRET) so captured images get a public URL.',
                );
            }
            return null;
        }

        const format: ScreenshotFormat = options.format ?? 'png';
        return this.imageUrls.createUrl({
            pluginId,
            url: options.url,
            viewportWidth: options.viewportWidth ?? SMART_IMAGE_CAPTURE.viewportWidth,
            viewportHeight: options.viewportHeight ?? SMART_IMAGE_CAPTURE.viewportHeight,
            format,
            fullPage: options.fullPage ?? false,
        });
    }
}
