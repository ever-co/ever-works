import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GotenbergPlugin, normalizeBaseUrl, GOTENBERG_SCREENSHOT_ROUTE } from '../gotenberg.plugin.js';
import type { PluginContext } from '@ever-works/plugin';
import packageJson from '../../package.json' with { type: 'json' };

const BASE_URL = 'http://gotenberg.ever-works-app-dev.svc:3000';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function imageResponse(bytes: Buffer = PNG_BYTES, status = 200): Response {
	return new Response(new Uint8Array(bytes), { status, headers: { 'Content-Type': 'image/png' } });
}

function textResponse(body: string, status: number): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function makeContext(settings: Record<string, unknown> = {}): PluginContext {
	return {
		pluginId: 'gotenberg',
		logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
		cache: {} as any,
		http: {} as any,
		env: {} as any,
		envVars: {} as any,
		services: {} as any,
		getSettings: vi.fn().mockResolvedValue(settings),
		getResolvedSettings: vi.fn().mockResolvedValue({}),
		onEvent: vi.fn(),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn(),
		hasCustomCapability: vi.fn(),
		listCustomCapabilities: vi.fn()
	} as unknown as PluginContext;
}

/** The multipart fields of the n-th fetch call, as a plain object. */
function formFields(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
	const body = fetchMock.mock.calls[call][1].body as FormData;
	const fields: Record<string, string> = {};
	for (const [key, value] of body.entries()) fields[key] = String(value);
	return fields;
}

describe('GotenbergPlugin', () => {
	let plugin: GotenbergPlugin;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		plugin = new GotenbergPlugin();
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('identity and manifest', () => {
		it('is a screenshot plugin', () => {
			expect(plugin.id).toBe('gotenberg');
			expect(plugin.category).toBe('screenshot');
			expect(plugin.capabilities).toEqual(['screenshot']);
			expect(plugin.providerName).toBe('Gotenberg');
		});

		it('is the auto-enabled system default for the screenshot capability', () => {
			const manifest = plugin.getManifest();
			expect(manifest.defaultForCapabilities).toEqual(['screenshot']);
			expect(manifest.systemPlugin).toBe(true);
			expect(manifest.autoEnable).toBe(true);
			expect(manifest.builtIn).toBe(true);
		});

		it('declares the same default in package.json, which the registry reads before the class loads', () => {
			const declared = packageJson.everworks.plugin;
			expect(declared.id).toBe(plugin.id);
			expect(declared.defaultForCapabilities).toEqual(['screenshot']);
			expect(declared.systemPlugin).toBe(true);
			expect(declared.autoEnable).toBe(true);
			expect(declared.envVars.map((v) => v.name)).toEqual([
				'PLUGIN_GOTENBERG_BASE_URL',
				'PLUGIN_GOTENBERG_USERNAME',
				'PLUGIN_GOTENBERG_TOKEN'
			]);
		});

		it('charges nothing per screenshot', () => {
			expect(plugin.getPricing().costPerCallCents).toBe(0);
		});
	});

	describe('settings schema', () => {
		const properties = () => plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;

		it('binds the base URL and token to environment variables', () => {
			expect(properties().baseUrl['x-envVar']).toBe('PLUGIN_GOTENBERG_BASE_URL');
			expect(properties().token['x-envVar']).toBe('PLUGIN_GOTENBERG_TOKEN');
			expect(properties().username['x-envVar']).toBe('PLUGIN_GOTENBERG_USERNAME');
		});

		it('keeps the base URL operator-only: an x-envVar field without x-secret is refused from user and Work writes', () => {
			expect(properties().baseUrl['x-secret']).toBeUndefined();
			expect(properties().baseUrl['x-adminOnly']).toBe(true);
		});

		it('treats the token as a secret', () => {
			expect(properties().token['x-secret']).toBe(true);
		});

		it('requires nothing, so an instance without Gotenberg never has generation refused for it', () => {
			expect(plugin.settingsSchema.required ?? []).toEqual([]);
		});
	});

	describe('normalizeBaseUrl', () => {
		it('strips trailing slashes, query and hash', () => {
			expect(normalizeBaseUrl('http://gotenberg:3000/')).toBe('http://gotenberg:3000');
			expect(normalizeBaseUrl(' https://shots.example.com/gotenberg/?x=1#y ')).toBe(
				'https://shots.example.com/gotenberg'
			);
		});

		it('refuses missing, relative, non-http and credentialed URLs', () => {
			expect(normalizeBaseUrl(undefined)).toBeNull();
			expect(normalizeBaseUrl('')).toBeNull();
			expect(normalizeBaseUrl('gotenberg:3000')).toBeNull();
			expect(normalizeBaseUrl('/forms')).toBeNull();
			expect(normalizeBaseUrl('file:///etc/passwd')).toBeNull();
			expect(normalizeBaseUrl('http://user:secret@gotenberg:3000')).toBeNull();
		});
	});

	describe('capture', () => {
		it('posts the URL to the screenshot route and returns the image bytes', async () => {
			fetchMock.mockResolvedValue(imageResponse());

			const result = await plugin.capture({
				url: 'https://example.com',
				settings: { baseUrl: `${BASE_URL}/` }
			});

			expect(result.success).toBe(true);
			expect(result.imageBuffer?.equals(PNG_BYTES)).toBe(true);
			expect(result.imageBase64).toBe(PNG_BYTES.toString('base64'));
			expect(result.fileSize).toBe(PNG_BYTES.length);
			expect(result.width).toBe(1280);
			expect(result.height).toBe(800);
			// Gotenberg answers bytes; the facade, not the plugin, gives them a public URL.
			expect(result.imageUrl).toBeUndefined();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(`${BASE_URL}${GOTENBERG_SCREENSHOT_ROUTE}`);
			expect(init.method).toBe('POST');
			expect(init.redirect).toBe('error');
			expect(init.headers.Authorization).toBeUndefined();
			expect(formFields(fetchMock)).toEqual({
				url: 'https://example.com',
				width: '1280',
				height: '800',
				format: 'png',
				clip: 'true',
				emulatedMediaType: 'screen'
			});
		});

		it('maps options onto Gotenberg fields', async () => {
			fetchMock.mockResolvedValue(imageResponse());

			await plugin.capture({
				url: 'https://example.com/page',
				viewportWidth: 1440,
				viewportHeight: 900,
				format: 'jpg',
				fullPage: true,
				delay: 1500,
				deviceScaleFactor: 2,
				waitForSelector: '#app',
				userAgent: 'EverWorksBot/1.0',
				headers: { 'Accept-Language': 'en' },
				cookies: [
					{ name: 'consent', value: 'yes', domain: 'example.com' },
					{ name: 'nodomain', value: 'dropped' }
				],
				settings: { baseUrl: BASE_URL, quality: 70 }
			});

			const fields = formFields(fetchMock);
			expect(fields).toMatchObject({
				width: '1440',
				height: '900',
				format: 'jpeg',
				quality: '70',
				clip: 'false',
				deviceScaleFactor: '2',
				waitDelay: '1500ms',
				waitForSelector: '#app',
				userAgent: 'EverWorksBot/1.0',
				extraHttpHeaders: JSON.stringify({ 'Accept-Language': 'en' })
			});
			expect(JSON.parse(fields.cookies)).toEqual([{ name: 'consent', value: 'yes', domain: 'example.com' }]);
		});

		it('uses the settings defaults when the call gives none', async () => {
			fetchMock.mockResolvedValue(imageResponse());

			await plugin.capture({
				url: 'https://example.com',
				settings: {
					baseUrl: BASE_URL,
					viewportWidth: 1024,
					viewportHeight: '768',
					format: 'webp',
					fullPage: 'true'
				}
			});

			expect(formFields(fetchMock)).toMatchObject({
				width: '1024',
				height: '768',
				format: 'webp',
				quality: '80',
				clip: 'false'
			});
		});

		it('sends the token as the basic-auth password', async () => {
			fetchMock.mockResolvedValue(imageResponse());

			await plugin.capture({ url: 'https://example.com', settings: { baseUrl: BASE_URL, token: 's3cret' } });
			expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
				`Basic ${Buffer.from('gotenberg:s3cret').toString('base64')}`
			);

			await plugin.capture({
				url: 'https://example.com',
				settings: { baseUrl: BASE_URL, username: 'works', token: 's3cret' }
			});
			expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
				`Basic ${Buffer.from('works:s3cret').toString('base64')}`
			);
		});

		it('fails without calling anything when no base URL is configured', async () => {
			const result = await plugin.capture({ url: 'https://example.com', settings: {} });

			expect(result.success).toBe(false);
			expect(result.error).toContain('PLUGIN_GOTENBERG_BASE_URL');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it.each([
			'http://169.254.169.254/latest/meta-data/',
			'http://127.0.0.1:3100/api/health',
			'http://10.0.0.5/',
			'file:///etc/passwd',
			'javascript:alert(1)'
		])('blocks the unsafe target %s before calling Gotenberg', async (url) => {
			const result = await plugin.capture({ url, settings: { baseUrl: BASE_URL } });

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSRF guard blocked');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("reports Gotenberg's error status and body", async () => {
			fetchMock.mockResolvedValue(textResponse('Invalid form data: form field "width" is invalid', 400));
			const context = makeContext();
			await plugin.onLoad(context);

			const result = await plugin.capture({ url: 'https://example.com', settings: { baseUrl: BASE_URL } });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Gotenberg answered HTTP 400: Invalid form data: form field "width" is invalid');
			expect(context.logger.error).toHaveBeenCalled();
		});

		it('fails on an empty image', async () => {
			fetchMock.mockResolvedValue(imageResponse(Buffer.alloc(0)));

			const result = await plugin.capture({ url: 'https://example.com', settings: { baseUrl: BASE_URL } });

			expect(result).toEqual({ success: false, error: 'Gotenberg returned an empty image' });
		});

		it('reports a timeout in plain words', async () => {
			const timeout = new Error('The operation was aborted due to timeout');
			timeout.name = 'TimeoutError';
			fetchMock.mockRejectedValue(timeout);

			const result = await plugin.capture({
				url: 'https://example.com',
				settings: { baseUrl: BASE_URL, timeoutMs: 5000 }
			});

			expect(result).toEqual({ success: false, error: 'Gotenberg did not answer within 5000 ms' });
		});

		it('never echoes the token in an error', async () => {
			fetchMock.mockRejectedValue(new Error('connect failed for s3cret-token'));

			const result = await plugin.capture({
				url: 'https://example.com',
				settings: { baseUrl: BASE_URL, token: 's3cret-token' }
			});

			expect(result.error).toBe('connect failed for ***');
		});
	});

	describe('isAvailable', () => {
		it('is false before onLoad', async () => {
			expect(await plugin.isAvailable()).toBe(false);
		});

		it('follows whether a usable base URL is configured', async () => {
			await plugin.onLoad(makeContext({ baseUrl: BASE_URL }));
			expect(await plugin.isAvailable()).toBe(true);

			await plugin.onLoad(makeContext({ baseUrl: 'not a url' }));
			expect(await plugin.isAvailable()).toBe(false);

			await plugin.onLoad(makeContext({}));
			expect(await plugin.isAvailable()).toBe(false);
		});
	});

	describe('validateConnection', () => {
		it('needs a base URL', async () => {
			const result = await plugin.validateConnection({});
			expect(result.success).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('checks /health, then /version with the credentials', async () => {
			fetchMock
				.mockResolvedValueOnce(new Response('{"status":"up"}', { status: 200 }))
				.mockResolvedValueOnce(new Response('9.9.0', { status: 200 }));

			const result = await plugin.validateConnection({ baseUrl: BASE_URL, token: 'pw' });

			expect(result).toEqual({ success: true, message: 'Gotenberg 9.9.0 is reachable.' });
			expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/health`);
			expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/version`);
			expect(fetchMock.mock.calls[1][1].headers.Authorization).toMatch(/^Basic /);
		});

		it('reports refused credentials', async () => {
			fetchMock
				.mockResolvedValueOnce(new Response('{"status":"up"}', { status: 200 }))
				.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

			const result = await plugin.validateConnection({ baseUrl: BASE_URL, token: 'wrong' });

			expect(result.success).toBe(false);
			expect(result.message).toContain('401');
		});

		it('reports an unhealthy server', async () => {
			fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));

			const result = await plugin.validateConnection({ baseUrl: BASE_URL });

			expect(result).toEqual({ success: false, message: 'Gotenberg health check failed (HTTP 503).' });
		});

		it('reports an unreachable server', async () => {
			fetchMock.mockRejectedValue(new TypeError('fetch failed'));

			const result = await plugin.validateConnection({ baseUrl: BASE_URL });

			expect(result.success).toBe(false);
			expect(result.message).toContain('fetch failed');
		});
	});

	describe('validateCredentials', () => {
		it('needs onLoad', async () => {
			expect(await plugin.validateCredentials()).toEqual({ valid: false, message: 'Plugin not initialized' });
		});

		it('uses the stored settings', async () => {
			fetchMock
				.mockResolvedValueOnce(new Response('{"status":"up"}', { status: 200 }))
				.mockResolvedValueOnce(new Response('9.9.0', { status: 200 }));
			await plugin.onLoad(makeContext({ baseUrl: BASE_URL }));

			expect(await plugin.validateCredentials()).toEqual({
				valid: true,
				message: 'Gotenberg 9.9.0 is reachable.'
			});
		});
	});

	describe('lifecycle', () => {
		it('reports healthy and unloads', async () => {
			await plugin.onLoad(makeContext());
			expect((await plugin.healthCheck()).status).toBe('healthy');
			await plugin.onUnload();
			expect(await plugin.isAvailable()).toBe(false);
		});

		it('lists formats and limits', () => {
			expect(plugin.getSupportedFormats()).toEqual(['png', 'jpg', 'jpeg', 'webp']);
			expect(plugin.getMaxDimensions()).toEqual({ width: 3840, height: 2160 });
		});
	});
});
