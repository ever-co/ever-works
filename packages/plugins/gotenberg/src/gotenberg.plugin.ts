import type {
	IPlugin,
	IScreenshotPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	PluginSettings,
	ScreenshotOptions,
	ScreenshotResult,
	ScreenshotFormat,
	ScreenshotValidationResult,
	ConnectionValidationResult
} from '@ever-works/plugin';

// Security (SSRF): shared lexical guard rejecting non-HTTP(S) schemes and
// literal private/loopback/link-local/cloud-metadata IPs. Imported directly
// from the helper subpath because the plugin barrel intentionally does not
// re-export it (it pulls in node:net / node:dns).
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

/** Gotenberg's URL screenshot route (Gotenberg 8 and 9). */
export const GOTENBERG_SCREENSHOT_ROUTE = '/forms/chromium/screenshot/url';

/** Username Gotenberg's basic auth expects when none is configured. */
export const DEFAULT_GOTENBERG_USERNAME = 'gotenberg';

const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 800;
const DEFAULT_FORMAT: ScreenshotFormat = 'png';
const DEFAULT_QUALITY = 80;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest error body copied into a failure message. */
const MAX_ERROR_BODY_CHARS = 300;

interface GotenbergSettings {
	readonly baseUrl?: string;
	readonly username?: string;
	readonly token?: string;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
	readonly format: ScreenshotFormat;
	readonly quality: number;
	readonly fullPage: boolean;
	readonly deviceScaleFactor: number;
	readonly timeoutMs: number;
}

/**
 * Gotenberg answers `jpeg`, never `jpg`, and refuses anything else with a 400.
 */
function toGotenbergFormat(format: ScreenshotFormat): 'png' | 'jpeg' | 'webp' {
	if (format === 'jpg' || format === 'jpeg') return 'jpeg';
	return format;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	if (value === 'false') return false;
	return undefined;
}

function asFormat(value: unknown): ScreenshotFormat | undefined {
	return value === 'png' || value === 'jpg' || value === 'jpeg' || value === 'webp' ? value : undefined;
}

/**
 * The configured Gotenberg origin + optional path prefix, without a trailing
 * slash, or `null` when it is missing or not an absolute http(s) URL. A URL
 * carrying credentials (`http://user:pass@host`) is refused too: the token
 * setting is where credentials go, and `fetch` rejects userinfo anyway.
 */
export function normalizeBaseUrl(raw: unknown): string | null {
	const text = asString(raw);
	if (!text) return null;
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	if (parsed.username || parsed.password) return null;
	parsed.search = '';
	parsed.hash = '';
	return parsed.toString().replace(/\/+$/, '');
}

/**
 * Gotenberg Plugin — the default, self-hosted screenshot provider.
 *
 * Captures website screenshots through a [Gotenberg](https://gotenberg.dev)
 * server (MIT, Chromium-based), which the platform operator runs next to the
 * API (in the Ever Works cluster: one per environment). There is no SaaS
 * account and no per-screenshot cost.
 *
 * Settings resolution:
 * - `baseUrl` — operator config only, from `PLUGIN_GOTENBERG_BASE_URL`
 *   (an `x-envVar` field without `x-secret` is never accepted from a user or
 *   Work write, so nobody can point the API's server-side requests elsewhere).
 * - `token` — optional basic-auth password (`PLUGIN_GOTENBERG_TOKEN`) for a
 *   Gotenberg started with `--api-enable-basic-auth`; `username` defaults to
 *   `gotenberg` (`PLUGIN_GOTENBERG_USERNAME`).
 *
 * Without a base URL the plugin is simply unavailable: no field is
 * `required`, so an instance that runs no Gotenberg never sees generation
 * refused because "the default screenshot provider is not configured" — the
 * image-capture step just finds no image.
 *
 * Gotenberg answers image bytes, not a public URL, so `capture()` returns
 * `imageBuffer` without `imageUrl`. The screenshot facade turns such a
 * result into a signed, cacheable URL on the platform's own API when that is
 * configured (`SCREENSHOT_IMAGE_BASE_URL`).
 */
export class GotenbergPlugin implements IPlugin, IScreenshotPlugin {
	readonly id = 'gotenberg';
	readonly name = 'Gotenberg';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'screenshot';
	readonly capabilities: readonly string[] = ['screenshot'];

	/** Provider name for facade identification */
	readonly providerName = 'Gotenberg';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			baseUrl: {
				type: 'string',
				title: 'Gotenberg URL',
				description:
					'Base URL of your Gotenberg server, e.g. http://gotenberg:3000. Set by the operator through PLUGIN_GOTENBERG_BASE_URL.',
				format: 'uri',
				'x-envVar': 'PLUGIN_GOTENBERG_BASE_URL',
				'x-adminOnly': true
			},
			username: {
				type: 'string',
				title: 'Basic Auth Username',
				description: 'Username for a Gotenberg started with --api-enable-basic-auth. Defaults to "gotenberg".',
				default: DEFAULT_GOTENBERG_USERNAME,
				'x-envVar': 'PLUGIN_GOTENBERG_USERNAME',
				'x-adminOnly': true
			},
			token: {
				type: 'string',
				title: 'Basic Auth Password',
				description:
					'Optional password (GOTENBERG_API_BASIC_AUTH_PASSWORD on the server). Leave empty when the server runs without authentication.',
				'x-secret': true,
				'x-envVar': 'PLUGIN_GOTENBERG_TOKEN',
				'x-adminOnly': true
			},
			viewportWidth: {
				type: 'number',
				title: 'Viewport Width',
				description: 'Default viewport width in pixels',
				default: DEFAULT_VIEWPORT_WIDTH,
				minimum: 320,
				maximum: 3840
			},
			viewportHeight: {
				type: 'number',
				title: 'Viewport Height',
				description: 'Default viewport height in pixels',
				default: DEFAULT_VIEWPORT_HEIGHT,
				minimum: 200,
				maximum: 2160
			},
			format: {
				type: 'string',
				title: 'Image Format',
				description: 'Default output image format',
				enum: ['png', 'jpg', 'jpeg', 'webp'],
				default: DEFAULT_FORMAT
			},
			quality: {
				type: 'number',
				title: 'Image Quality',
				description: 'Quality for JPEG and WebP output (1-100). PNG ignores it.',
				default: DEFAULT_QUALITY,
				minimum: 1,
				maximum: 100
			},
			fullPage: {
				type: 'boolean',
				title: 'Full Page',
				description: 'Capture the full scrollable page by default instead of the viewport only',
				default: false
			},
			deviceScaleFactor: {
				type: 'number',
				title: 'Device Scale Factor',
				description: 'Device scale factor (1 = normal, 2 = retina)',
				default: 1,
				minimum: 0.5,
				maximum: 3
			},
			timeoutMs: {
				type: 'number',
				title: 'Request Timeout (ms)',
				description: 'How long to wait for Gotenberg to answer one screenshot',
				default: DEFAULT_TIMEOUT_MS,
				minimum: 1000,
				maximum: 120000,
				'x-adminOnly': true
			}
		}
	};

	/**
	 * Operator-run infrastructure: one server for the whole platform, set up
	 * by the operator, never by a user.
	 */
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	private context?: PluginContext;

	// ============================================================================
	// IScreenshotPlugin
	// ============================================================================

	async capture(options: ScreenshotOptions): Promise<ScreenshotResult> {
		const settings = this.mergeSettings(options.settings);

		// Security (SSRF): `options.url` is attacker-controllable (Work source
		// URLs, LLM-generated item URLs) and Gotenberg renders it in a real
		// browser. Refuse non-HTTP(S) schemes and literal private / loopback /
		// link-local / cloud-metadata targets here; the server's
		// --chromium-deny-private-ips (which resolves and pins every
		// destination) and its NetworkPolicy cover hostnames that resolve to
		// such addresses.
		if (!isSafeWebhookUrl(options.url)) {
			return {
				success: false,
				error: `URL host is not safe to capture (SSRF guard blocked: ${options.url})`
			};
		}

		if (!settings.baseUrl) {
			return {
				success: false,
				error: 'Gotenberg is not configured. Set PLUGIN_GOTENBERG_BASE_URL to the Gotenberg server URL.'
			};
		}

		const format = options.format ?? settings.format;
		const width = options.viewportWidth ?? settings.viewportWidth;
		const height = options.viewportHeight ?? settings.viewportHeight;

		try {
			const response = await fetch(`${settings.baseUrl}${GOTENBERG_SCREENSHOT_ROUTE}`, {
				method: 'POST',
				headers: this.buildHeaders(settings),
				body: this.buildForm(options, settings, { format, width, height }),
				signal: AbortSignal.timeout(settings.timeoutMs),
				// Never follow a redirect to another host with our credentials.
				redirect: 'error'
			});

			if (!response.ok) {
				throw new Error(await this.describeFailure(response));
			}

			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.length === 0) {
				throw new Error('Gotenberg returned an empty image');
			}

			return {
				success: true,
				imageBuffer: buffer,
				imageBase64: buffer.toString('base64'),
				width,
				height,
				fileSize: buffer.length
			};
		} catch (error) {
			const errorMessage = this.errorMessage(error, settings);
			this.context?.logger.error(`Gotenberg capture failed: ${errorMessage}`);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Available when a Gotenberg URL is configured. Whether the server answers
	 * is `validateConnection`'s job; this check must stay cheap.
	 */
	async isAvailable(): Promise<boolean> {
		if (!this.context) return false;
		const settings = await this.context.getSettings();
		return normalizeBaseUrl(settings?.baseUrl) !== null;
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const resolved = this.mergeSettings(settings);
		if (!resolved.baseUrl) {
			return {
				success: false,
				message: 'Gotenberg URL is not configured (PLUGIN_GOTENBERG_BASE_URL).'
			};
		}

		try {
			// `/health` needs no credentials; `/version` does when basic auth is
			// on, so asking it also proves the token.
			const health = await fetch(`${resolved.baseUrl}/health`, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(Math.min(resolved.timeoutMs, 10_000)),
				redirect: 'error'
			});
			if (!health.ok) {
				return { success: false, message: `Gotenberg health check failed (HTTP ${health.status}).` };
			}

			const version = await fetch(`${resolved.baseUrl}/version`, {
				headers: this.buildHeaders(resolved),
				signal: AbortSignal.timeout(Math.min(resolved.timeoutMs, 10_000)),
				redirect: 'error'
			});
			if (version.status === 401) {
				return { success: false, message: 'Gotenberg refused the credentials (HTTP 401).' };
			}
			if (!version.ok) {
				return { success: false, message: `Gotenberg version check failed (HTTP ${version.status}).` };
			}

			const versionText = (await version.text()).trim().slice(0, 40);
			return {
				success: true,
				message: versionText ? `Gotenberg ${versionText} is reachable.` : 'Gotenberg is reachable.'
			};
		} catch (error) {
			return {
				success: false,
				message: `Gotenberg connection failed: ${this.errorMessage(error, resolved)}`
			};
		}
	}

	async validateCredentials(): Promise<ScreenshotValidationResult> {
		if (!this.context) {
			return { valid: false, message: 'Plugin not initialized' };
		}
		const result = await this.validateConnection(await this.context.getSettings());
		return { valid: result.success, message: result.message };
	}

	getSupportedFormats(): readonly ScreenshotFormat[] {
		return ['png', 'jpg', 'jpeg', 'webp'] as const;
	}

	getMaxDimensions(): { width: number; height: number } {
		return { width: 3840, height: 2160 };
	}

	/** Self-hosted: no per-screenshot charge. */
	getPricing(): { costPerCallCents: number; currency: string; note: string } {
		return {
			costPerCallCents: 0,
			currency: 'usd',
			note: 'Self-hosted Gotenberg: no per-screenshot cost.'
		};
	}

	// ============================================================================
	// Helpers
	// ============================================================================

	private buildHeaders(settings: GotenbergSettings): Record<string, string> {
		const headers: Record<string, string> = {};
		if (settings.token) {
			const credentials = `${settings.username ?? DEFAULT_GOTENBERG_USERNAME}:${settings.token}`;
			headers.Authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
		}
		return headers;
	}

	private buildForm(
		options: ScreenshotOptions,
		settings: GotenbergSettings,
		resolved: { format: ScreenshotFormat; width: number; height: number }
	): FormData {
		const form = new FormData();
		const gotenbergFormat = toGotenbergFormat(resolved.format);
		const fullPage = options.fullPage ?? settings.fullPage;

		form.append('url', options.url);
		form.append('width', String(Math.round(resolved.width)));
		form.append('height', String(Math.round(resolved.height)));
		form.append('format', gotenbergFormat);
		// `clip` keeps the shot to the viewport; without it Gotenberg captures
		// the whole scrollable page.
		form.append('clip', fullPage ? 'false' : 'true');
		form.append('emulatedMediaType', 'screen');

		if (gotenbergFormat !== 'png') {
			form.append('quality', String(Math.round(settings.quality)));
		}

		const deviceScaleFactor = options.deviceScaleFactor ?? settings.deviceScaleFactor;
		if (deviceScaleFactor !== 1) {
			form.append('deviceScaleFactor', String(deviceScaleFactor));
		}

		if (options.delay !== undefined && options.delay > 0) {
			form.append('waitDelay', `${Math.round(options.delay)}ms`);
		}

		if (options.waitForSelector) {
			form.append('waitForSelector', options.waitForSelector);
		}

		if (options.userAgent) {
			form.append('userAgent', options.userAgent);
		}

		if (options.headers && Object.keys(options.headers).length > 0) {
			form.append('extraHttpHeaders', JSON.stringify(options.headers));
		}

		if (options.cookies && options.cookies.length > 0) {
			const cookies = options.cookies
				.filter((cookie) => cookie.domain)
				.map((cookie) => ({
					name: cookie.name,
					value: cookie.value,
					domain: cookie.domain,
					path: cookie.path,
					httpOnly: cookie.httpOnly,
					secure: cookie.secure
				}));
			if (cookies.length > 0) {
				form.append('cookies', JSON.stringify(cookies));
			}
		}

		// Ad, tracker and cookie-banner blocking (`blockAds`, `blockTrackers`,
		// `blockCookieBanners`) and provider-side caching (`cache`) are
		// ScreenshotOne features Gotenberg does not have; they are ignored.
		return form;
	}

	private async describeFailure(response: Response): Promise<string> {
		let body = '';
		try {
			body = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_BODY_CHARS);
		} catch {
			// The status alone is enough.
		}
		return body
			? `Gotenberg answered HTTP ${response.status}: ${body}`
			: `Gotenberg answered HTTP ${response.status}`;
	}

	private errorMessage(error: unknown, settings: GotenbergSettings): string {
		if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
			return `Gotenberg did not answer within ${settings.timeoutMs} ms`;
		}
		const message = error instanceof Error ? error.message : String(error);
		// Never echo the password, should a lower layer ever include it.
		return settings.token ? message.split(settings.token).join('***') : message;
	}

	private mergeSettings(settings?: PluginSettings | Record<string, unknown>): GotenbergSettings {
		const s = (settings ?? {}) as Record<string, unknown>;
		return {
			baseUrl: normalizeBaseUrl(s.baseUrl) ?? undefined,
			username: asString(s.username),
			token: asString(s.token),
			viewportWidth: asNumber(s.viewportWidth) ?? DEFAULT_VIEWPORT_WIDTH,
			viewportHeight: asNumber(s.viewportHeight) ?? DEFAULT_VIEWPORT_HEIGHT,
			format: asFormat(s.format) ?? DEFAULT_FORMAT,
			quality: asNumber(s.quality) ?? DEFAULT_QUALITY,
			fullPage: asBoolean(s.fullPage) ?? false,
			deviceScaleFactor: asNumber(s.deviceScaleFactor) ?? 1,
			timeoutMs: asNumber(s.timeoutMs) ?? DEFAULT_TIMEOUT_MS
		};
	}

	// ============================================================================
	// IPlugin lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Gotenberg Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		// The facade passes resolved settings on each call; a real probe of
		// the server is `validateConnection`.
		return {
			status: 'healthy',
			message: 'Gotenberg plugin is ready (PLUGIN_GOTENBERG_BASE_URL required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Capture website screenshots with a self-hosted Gotenberg server (open source, no per-shot cost)',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			defaultForCapabilities: ['screenshot'],
			readme: [
				'## What does Gotenberg do?',
				'',
				'[Gotenberg](https://gotenberg.dev) is an open-source (MIT) document and screenshot server built on Chromium. Ever Works uses its screenshot route to capture preview images of the pages your work items link to.',
				'',
				'## Why is it the default?',
				'',
				'- **Self-hosted** — the server runs next to the Ever Works API, so no third-party account is needed',
				'- **No per-screenshot cost** — captures are free; ScreenshotOne and Urlbox stay available as paid, opt-in alternatives',
				'- **Same output** — PNG, JPEG or WebP at the viewport size you choose, viewport-only or full page',
				'',
				'## How it works in Ever Works',
				'',
				'During work generation, the screenshot facade sends each item that has a source URL to Gotenberg. Gotenberg returns the image, and Ever Works serves it from a signed, cacheable URL on its own API.',
				'',
				'## Setting it up (operators)',
				'',
				'1. Run Gotenberg (`gotenberg/gotenberg:9-chromium`), ideally with `--chromium-deny-private-ips` and `--api-enable-basic-auth`',
				'2. Set `PLUGIN_GOTENBERG_BASE_URL` (and `PLUGIN_GOTENBERG_TOKEN` when basic auth is on) on the API and its workers',
				'3. Set `SCREENSHOT_IMAGE_BASE_URL` to the public API origin so captured images get public URLs'
			].join('\n'),
			homepage: 'https://gotenberg.dev',
			icon: {
				type: 'lucide',
				value: 'Camera',
				backgroundColor: '#0f766e'
			}
		};
	}
}

export default GotenbergPlugin;
