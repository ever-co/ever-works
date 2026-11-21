import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';
import { CloudflareWorkersPlugin } from '../cloudflare-workers.plugin';
import { CloudflareApiClient } from '../cloudflare-api.service';

const ACCOUNT = 'a'.repeat(32);
const PLATFORM_ACCOUNT = 'b'.repeat(32);
const API = 'https://api.cloudflare.com/client/v4';

const json = (status: number, body: unknown): Response =>
	({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	}) as unknown as Response;

type Route = (url: URL, init: RequestInit) => Response | undefined;

/** A fetch mock answering by method + path; unmatched calls fail the test loudly. */
function mockFetch(...routes: Route[]) {
	return vi.fn(async (input: string, init: RequestInit = {}) => {
		const url = new URL(input);
		for (const route of routes) {
			const response = route(url, init);
			if (response) return response;
		}
		throw new Error(`unexpected ${init.method ?? 'GET'} ${url.pathname}${url.search}`);
	});
}

const on =
	(method: string, path: string, response: Response | ((url: URL, init: RequestInit) => Response)): Route =>
	(url, init) =>
		(init.method ?? 'GET') === method && url.pathname === `/client/v4${path}`
			? typeof response === 'function'
				? response(url, init)
				: response
			: undefined;

function pluginWith(fetchImpl: ReturnType<typeof mockFetch>) {
	return new CloudflareWorkersPlugin(
		new CloudflareApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 })
	);
}

describe('CloudflareWorkersPlugin', () => {
	beforeEach(() => {
		vi.stubEnv('CLOUDFLARE_DEPLOY_API_TOKEN', '');
		vi.stubEnv('CLOUDFLARE_DEPLOY_ACCOUNT_ID', '');
		vi.stubEnv('CLOUDFLARE_DEPLOY_ZONE_NAME', '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('metadata', () => {
		const plugin = new CloudflareWorkersPlugin();

		it('is the `cloudflare` deployment provider', () => {
			expect(plugin.id).toBe('cloudflare');
			expect(plugin.providerName).toBe('cloudflare');
			expect(plugin.category).toBe('deployment');
			expect(plugin.capabilities).toEqual(['deployment']);
			expect(plugin.configurationMode).toBe('hybrid');
		});

		it('is auto-enabled, user-only and NOT the default deployment provider', () => {
			const manifest = plugin.getManifest();
			expect(manifest.autoEnable).toBe(true);
			expect(manifest.visibility).toBe('user-only');
			expect(manifest.defaultForCapabilities).toBeUndefined();
			expect(manifest.icon).toEqual({ type: 'lucide', value: 'Cloud', backgroundColor: '#F38020' });
		});

		it('declares the settings with their scopes and env fallbacks', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(plugin.settingsSchema.required).toEqual(['apiToken']);
			expect(props.apiToken).toMatchObject({
				'x-secret': true,
				'x-scope': 'user',
				'x-envVar': 'CLOUDFLARE_DEPLOY_API_TOKEN'
			});
			expect(props.accountId['x-scope']).toBe('user');
			// A member-writable field must not carry a non-secret x-envVar (the settings service would
			// reject every write to it).
			expect(props.accountId['x-envVar']).toBeUndefined();
			expect(props.zoneName).toMatchObject({ default: 'ever.works', 'x-scope': 'user' });
			expect(props.workerPrefix).toMatchObject({ default: 'ew-', 'x-scope': 'user' });
			expect(props.platformAccountId).toMatchObject({
				'x-envVar': 'CLOUDFLARE_DEPLOY_ACCOUNT_ID',
				'x-adminOnly': true
			});
			expect(props.platformZoneName).toMatchObject({
				'x-envVar': 'CLOUDFLARE_DEPLOY_ZONE_NAME',
				'x-adminOnly': true
			});
		});

		it('dispatches deploy_cloudflare.yaml', () => {
			expect(plugin.getWorkflowFilenames()).toEqual(['deploy_cloudflare.yaml']);
		});

		it('returns a pending result for the workflow-driven deploy', async () => {
			await expect(plugin.deploy({ projectName: 'x', sourceDir: '.' }, 't')).resolves.toMatchObject({
				status: 'pending'
			});
			await expect(plugin.getDeploymentStatus('id-1', 't')).resolves.toMatchObject({
				id: 'id-1',
				status: 'pending'
			});
		});
	});

	describe('getDeploymentSecrets', () => {
		const plugin = new CloudflareWorkersPlugin();

		it("derives the secrets from the member's settings and the managed subdomain", async () => {
			const secrets = await plugin.getDeploymentSecrets({
				apiToken: 'member-token',
				accountId: ACCOUNT,
				zoneName: 'ever.works',
				workerPrefix: 'ew-',
				managedSubdomain: 'crm',
				workSlug: 'awesome-crm'
			});
			expect(secrets).toEqual({
				CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
				CLOUDFLARE_WORKER_NAME: 'ew-crm',
				CLOUDFLARE_HOSTNAME: 'crm.ever.works'
			});
		});

		it('falls back to the slug without awesome- when no subdomain is persisted', async () => {
			const secrets = await plugin.getDeploymentSecrets({
				apiToken: 'member-token',
				accountId: ACCOUNT,
				zoneName: 'acme.dev',
				workSlug: 'awesome-mcp-servers'
			});
			expect(secrets.CLOUDFLARE_WORKER_NAME).toBe('ew-mcp-servers');
			expect(secrets.CLOUDFLARE_HOSTNAME).toBe('mcp-servers.acme.dev');
		});

		it('never returns the token', async () => {
			const secrets = await plugin.getDeploymentSecrets({
				apiToken: 'member-token',
				accountId: ACCOUNT,
				managedSubdomain: 'crm'
			});
			expect(Object.values(secrets)).not.toContain('member-token');
			expect(Object.keys(secrets)).not.toContain('CLOUDFLARE_TOKEN');
		});

		it("uses the operator's account and zone for the platform token, whatever the member stored", async () => {
			vi.stubEnv('CLOUDFLARE_DEPLOY_API_TOKEN', 'platform-token');
			vi.stubEnv('CLOUDFLARE_DEPLOY_ACCOUNT_ID', PLATFORM_ACCOUNT);
			const secrets = await plugin.getDeploymentSecrets({
				apiToken: 'platform-token',
				accountId: ACCOUNT,
				zoneName: 'gauzy.co',
				workerPrefix: '',
				managedSubdomain: 'crm'
			});
			expect(secrets).toEqual({
				CLOUDFLARE_ACCOUNT_ID: PLATFORM_ACCOUNT,
				CLOUDFLARE_WORKER_NAME: 'ew-crm',
				CLOUDFLARE_HOSTNAME: 'crm.ever.works'
			});
		});

		it('reads the platform values through the plugin context env allowlist once loaded', async () => {
			const get = vi.fn((name: string) =>
				name === 'CLOUDFLARE_DEPLOY_ACCOUNT_ID'
					? PLATFORM_ACCOUNT
					: name === 'CLOUDFLARE_DEPLOY_ZONE_NAME'
						? 'sites.example.org'
						: undefined
			);
			const loaded = new CloudflareWorkersPlugin();
			await loaded.onLoad({
				logger: { log: vi.fn() },
				envVars: { get },
				getSettings: vi.fn().mockResolvedValue({})
			} as unknown as PluginContext);
			const secrets = await loaded.getDeploymentSecrets({ platformManaged: true, managedSubdomain: 'crm' });
			expect(secrets.CLOUDFLARE_ACCOUNT_ID).toBe(PLATFORM_ACCOUNT);
			expect(secrets.CLOUDFLARE_HOSTNAME).toBe('crm.sites.example.org');
			expect(get).toHaveBeenCalledWith('CLOUDFLARE_DEPLOY_ACCOUNT_ID');
		});

		it('throws a readable error when the account id is missing', async () => {
			await expect(plugin.getDeploymentSecrets({ apiToken: 't', managedSubdomain: 'crm' })).rejects.toThrow(
				/account ID/
			);
		});
	});

	describe('lookupExistingDeployment', () => {
		const context = {
			settingsOverride: { accountId: ACCOUNT, zoneName: 'ever.works', managedSubdomain: 'crm' }
		};

		it('answers found:false while the Worker does not exist yet', async () => {
			const fetchImpl = mockFetch(
				on('GET', `/accounts/${ACCOUNT}/workers/scripts/ew-crm/deployments`, json(404, { success: false }))
			);
			await expect(
				pluginWith(fetchImpl).lookupExistingDeployment('awesome-crm-website', 't', undefined, context)
			).resolves.toEqual({
				found: false
			});
		});

		it('answers BUILDING while the hostname is not attached', async () => {
			const fetchImpl = mockFetch(
				on(
					'GET',
					`/accounts/${ACCOUNT}/workers/scripts/ew-crm/deployments`,
					json(200, { success: true, result: { deployments: [{ id: 'd', created_on: 'now' }] } })
				),
				on('GET', `/accounts/${ACCOUNT}/workers/domains`, json(200, { success: true, result: [] }))
			);
			await expect(pluginWith(fetchImpl).lookupExistingDeployment('x', 't', undefined, context)).resolves.toEqual(
				{
					found: true,
					projectId: 'ew-crm',
					deploymentState: 'BUILDING'
				}
			);
		});

		it('answers READY with the website once the hostname is attached to the Worker', async () => {
			const fetchImpl = mockFetch(
				on(
					'GET',
					`/accounts/${ACCOUNT}/workers/scripts/ew-crm/deployments`,
					json(200, { success: true, result: { deployments: [{ id: 'd', created_on: 'now' }] } })
				),
				on('GET', `/accounts/${ACCOUNT}/workers/domains`, (url) => {
					expect(url.searchParams.get('service')).toBe('ew-crm');
					expect(url.searchParams.get('hostname')).toBe('crm.ever.works');
					return json(200, {
						success: true,
						result: [{ id: 'dom', hostname: 'crm.ever.works', service: 'ew-crm' }]
					});
				})
			);
			await expect(pluginWith(fetchImpl).lookupExistingDeployment('x', 't', undefined, context)).resolves.toEqual(
				{
					found: true,
					projectId: 'ew-crm',
					website: 'https://crm.ever.works',
					deploymentState: 'READY'
				}
			);
		});

		it('derives the Worker from the website repository name when no context is given', async () => {
			const fetchImpl = mockFetch(
				on('GET', `/accounts/${ACCOUNT}/workers/scripts/ew-crm/deployments`, json(404, { success: false }))
			);
			const plugin = pluginWith(fetchImpl);
			await plugin.onLoad({
				logger: { log: vi.fn() },
				envVars: { get: () => undefined },
				getSettings: vi.fn().mockResolvedValue({ accountId: ACCOUNT })
			} as unknown as PluginContext);
			await expect(plugin.lookupExistingDeployment('awesome-crm-website', 't')).resolves.toEqual({
				found: false
			});
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it('surfaces API failures to the verifier', async () => {
			const fetchImpl = mockFetch(
				on(
					'GET',
					`/accounts/${ACCOUNT}/workers/scripts/ew-crm/deployments`,
					json(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
				)
			);
			await expect(pluginWith(fetchImpl).lookupExistingDeployment('x', 't', undefined, context)).rejects.toThrow(
				/Authentication error/
			);
		});
	});

	describe('validateToken / validateConnection', () => {
		it('verifies an account-owned token on the account endpoint', async () => {
			const fetchImpl = mockFetch(
				on(
					'GET',
					`/accounts/${ACCOUNT}/tokens/verify`,
					json(200, { success: true, result: { status: 'active' } })
				),
				on(
					'GET',
					`/accounts/${ACCOUNT}/workers/scripts`,
					json(200, { success: true, result: [{ id: 'a' }, { id: 'b' }] })
				),
				on('GET', '/zones', json(200, { success: true, result: [{ id: 'z', name: 'ever.works' }] }))
			);
			const result = await pluginWith(fetchImpl).validateConnection({ apiToken: 'tok', accountId: ACCOUNT });
			expect(result.success).toBe(true);
			expect(result.message).toContain('2 Worker(s)');
			expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/user/tokens/verify'))).toBe(false);
		});

		it('falls back to the user endpoint for a user-owned token', async () => {
			const fetchImpl = mockFetch(
				on('GET', `/accounts/${ACCOUNT}/tokens/verify`, json(401, { success: false })),
				on('GET', '/user/tokens/verify', json(200, { success: true, result: { status: 'active' } })),
				on('GET', `/accounts/${ACCOUNT}/workers/scripts`, json(200, { success: true, result: [] })),
				on('GET', '/zones', json(200, { success: true, result: [{ id: 'z', name: 'acme.dev' }] }))
			);
			const result = await pluginWith(fetchImpl).validateConnection({
				apiToken: 'tok',
				accountId: ACCOUNT,
				zoneName: 'acme.dev'
			});
			expect(result.success).toBe(true);
		});

		it('fails without a token or account id', async () => {
			const plugin = pluginWith(mockFetch());
			await expect(plugin.validateConnection({})).resolves.toMatchObject({ success: false });
			await expect(plugin.validateConnection({ apiToken: 'tok' })).resolves.toMatchObject({
				success: false,
				message: expect.stringMatching(/account ID/)
			});
		});

		it('fails when the token is rejected', async () => {
			const fetchImpl = mockFetch(
				on('GET', `/accounts/${ACCOUNT}/tokens/verify`, json(401, { success: false })),
				on('GET', '/user/tokens/verify', json(401, { success: false }))
			);
			await expect(
				pluginWith(fetchImpl).validateConnection({ apiToken: 'bad', accountId: ACCOUNT })
			).resolves.toMatchObject({
				success: false,
				message: expect.stringMatching(/rejected/)
			});
		});

		it('fails when the zone is not in the account', async () => {
			const fetchImpl = mockFetch(
				on(
					'GET',
					`/accounts/${ACCOUNT}/tokens/verify`,
					json(200, { success: true, result: { status: 'active' } })
				),
				on('GET', `/accounts/${ACCOUNT}/workers/scripts`, json(200, { success: true, result: [] })),
				on('GET', '/zones', json(200, { success: true, result: [] }))
			);
			await expect(
				pluginWith(fetchImpl).validateConnection({ apiToken: 'tok', accountId: ACCOUNT })
			).resolves.toMatchObject({
				success: false,
				message: expect.stringMatching(/ever\.works was not found/)
			});
		});

		it('validateToken uses the account endpoint when the account is known, else the user endpoint', async () => {
			const fetchImpl = mockFetch(
				on('GET', '/user/tokens/verify', json(200, { success: true, result: { status: 'active' } }))
			);
			await expect(pluginWith(fetchImpl).validateToken('tok')).resolves.toBe(true);
			await expect(pluginWith(fetchImpl).validateToken('  ')).resolves.toBe(false);
		});
	});

	describe('domains', () => {
		const member = { settingsOverride: { accountId: ACCOUNT } };

		it("lists the Worker's custom domains", async () => {
			const fetchImpl = mockFetch(
				on('GET', `/accounts/${ACCOUNT}/workers/domains`, (url) => {
					expect(url.searchParams.get('service')).toBe('ew-crm');
					return json(200, {
						success: true,
						result: [
							{ id: '1', hostname: 'crm.ever.works', service: 'ew-crm' },
							{ id: '2', hostname: 'www.acme.com', service: 'ew-crm' }
						]
					});
				})
			);
			await expect(pluginWith(fetchImpl).getDomains('ew-crm', 't', undefined, member)).resolves.toEqual([
				{ name: 'crm.ever.works', verified: true },
				{ name: 'www.acme.com', verified: true }
			]);
		});

		it("attaches a domain to the zone that contains it in the member's account", async () => {
			const fetchImpl = mockFetch(
				on('GET', '/zones', (url) =>
					json(200, {
						success: true,
						result:
							url.searchParams.get('name') === 'acme.com' ? [{ id: 'zone-acme', name: 'acme.com' }] : []
					})
				),
				on('PUT', `/accounts/${ACCOUNT}/workers/domains`, (_url, init) => {
					expect(JSON.parse(init.body as string)).toEqual({
						hostname: 'www.acme.com',
						service: 'ew-crm',
						zone_id: 'zone-acme'
					});
					return json(200, {
						success: true,
						result: { id: 'n', hostname: 'www.acme.com', service: 'ew-crm' }
					});
				})
			);
			await expect(
				pluginWith(fetchImpl).addDomain('ew-crm', 'WWW.Acme.com.', 't', undefined, member)
			).resolves.toEqual({
				domain: { name: 'www.acme.com', verified: true },
				verified: true
			});
		});

		it('refuses a domain whose zone is not in the account', async () => {
			const fetchImpl = mockFetch(on('GET', '/zones', json(200, { success: true, result: [] })));
			await expect(
				pluginWith(fetchImpl).addDomain('ew-crm', 'www.acme.com', 't', undefined, member)
			).rejects.toThrow(/No zone/);
		});

		it("removes only this Worker's attachment of the hostname", async () => {
			const fetchImpl = mockFetch(
				on('GET', `/accounts/${ACCOUNT}/workers/domains`, (url) => {
					expect(url.searchParams.get('service')).toBe('ew-crm');
					return json(200, {
						success: true,
						result: [
							{ id: 'mine', hostname: 'www.acme.com', service: 'ew-crm' },
							{ id: 'theirs', hostname: 'www.acme.com', service: 'ew-other' }
						]
					});
				}),
				on('DELETE', `/accounts/${ACCOUNT}/workers/domains/mine`, json(200, { success: true, result: null }))
			);
			await expect(
				pluginWith(fetchImpl).removeDomain('ew-crm', 'www.acme.com', 't', undefined, member)
			).resolves.toBe(true);
			expect(fetchImpl.mock.calls.some(([u]) => String(u).endsWith('/theirs'))).toBe(false);
		});

		it('verifyDomain reports an unattached domain with guidance', async () => {
			const fetchImpl = mockFetch(
				on('GET', `/accounts/${ACCOUNT}/workers/domains`, json(200, { success: true, result: [] }))
			);
			const result = await pluginWith(fetchImpl).verifyDomain('ew-crm', 'www.acme.com', 't', undefined, member);
			expect(result.verified).toBe(false);
			expect(result.verification?.[0].reason).toMatch(/same account/);
		});

		it('refuses adding or removing domains on the platform account', async () => {
			const platform = { settingsOverride: { platformManaged: true, platformAccountId: PLATFORM_ACCOUNT } };
			const plugin = pluginWith(mockFetch());
			await expect(plugin.addDomain('ew-crm', 'evil.gauzy.co', 't', undefined, platform)).rejects.toThrow(
				/platform's Cloudflare account/
			);
			await expect(plugin.removeDomain('ew-crm', 'crm.ever.works', 't', undefined, platform)).rejects.toThrow(
				/platform's Cloudflare account/
			);
		});

		it('refuses a Worker name that is not a Work Worker on the platform account, or not a name at all', async () => {
			const platform = { settingsOverride: { platformManaged: true, platformAccountId: PLATFORM_ACCOUNT } };
			const plugin = pluginWith(mockFetch());
			await expect(plugin.getDomains('api-gateway', 't', undefined, platform)).rejects.toThrow(
				/not a Work's Worker/
			);
			await expect(plugin.getDomains('../zones', 't', undefined, member)).rejects.toThrow(/not a Worker name/);
		});
	});
});
