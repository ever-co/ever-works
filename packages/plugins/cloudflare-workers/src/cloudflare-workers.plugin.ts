import type {
	AddDomainResult,
	ConnectionValidationResult,
	DeploymentConfig,
	DeploymentDomain,
	DeploymentLookupContext,
	DeploymentResult,
	IDeploymentPlugin,
	IPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest
} from '@ever-works/plugin';
import { CloudflareApiClient } from './cloudflare-api.service.js';
import { cloudflareWorkersSettingsSchema } from './settings.schema.js';
import {
	CloudflareConfigError,
	isValidWorkerName,
	normalizeHostname,
	resolveAccountConfig,
	resolveWorkerIdentity,
	type EnvReader
} from './target.js';
import {
	CLOUDFLARE_WORKFLOW_FILE,
	DEFAULT_WORKER_PREFIX,
	type CloudflareAccountConfig,
	type CloudflareWorkerDomain
} from './types.js';

/** The verifier's deployment states (`deployment-verifier.service.ts`). */
type VerifierState = 'READY' | 'BUILDING';

/**
 * Cloudflare Workers deploy provider (plugin id `cloudflare`).
 *
 * Hosts a static website (the Astro "minimal" directory template) on **Workers Static Assets**: one
 * assets-only Worker per Work, named `<workerPrefix><subdomain>` (`ew-crm`), attached to
 * `<subdomain>.<zone>` (`crm.ever.works`) as a **Workers Custom Domain**.
 *
 * Like the Vercel provider it does not build anything itself. The deploy service pushes the repository
 * secrets returned by {@link getDeploymentSecrets} (plus the token as `CLOUDFLARE_TOKEN` / `DEPLOY_TOKEN`)
 * and dispatches the website repository's `deploy_cloudflare.yaml`, which builds the site and runs
 * `wrangler deploy`. The deployment verifier then polls {@link lookupExistingDeployment}.
 *
 * Serving static assets on Workers is not billed per request, so an idle directory costs close to nothing.
 */
export class CloudflareWorkersPlugin implements IPlugin, IDeploymentPlugin {
	readonly id = 'cloudflare';
	readonly name = 'Cloudflare Workers';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'deployment';
	readonly capabilities: readonly string[] = ['deployment'];
	readonly providerName = 'cloudflare';

	readonly settingsSchema: JsonSchema = cloudflareWorkersSettingsSchema;

	/** A member's own account, or the operator's through the `CLOUDFLARE_DEPLOY_*` env fallbacks. */
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;
	private readonly api: CloudflareApiClient;

	constructor(api?: CloudflareApiClient) {
		this.api = api ?? new CloudflareApiClient();
	}

	// IDeploymentPlugin — the build runs in the website repository's GitHub Actions workflow.

	async deploy(_config: DeploymentConfig, _token: string): Promise<DeploymentResult> {
		return {
			id: `pending-${Date.now()}`,
			status: 'pending',
			createdAt: new Date().toISOString()
		};
	}

	async getDeploymentStatus(deploymentId: string, _token: string): Promise<DeploymentResult> {
		// Workflow-based: status is tracked by the deployment verifier through lookupExistingDeployment.
		return {
			id: deploymentId,
			status: 'pending',
			createdAt: new Date().toISOString()
		};
	}

	getWorkflowFilenames(): string[] {
		return [CLOUDFLARE_WORKFLOW_FILE];
	}

	/**
	 * `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME` and `CLOUDFLARE_HOSTNAME` for the website repository.
	 * The token itself is pushed by the deploy service (`CLOUDFLARE_TOKEN`, `DEPLOY_TOKEN`), never here.
	 *
	 * `settings` are the Work's resolved plugin settings plus the facts the platform adds
	 * (`managedSubdomain`, `workSlug`, `platformManaged`).
	 */
	async getDeploymentSecrets(settings: Record<string, unknown>): Promise<Record<string, string>> {
		const token = typeof settings.apiToken === 'string' ? settings.apiToken : undefined;
		const config = resolveAccountConfig(settings, token, this.envReader());
		const identity = resolveWorkerIdentity(config, settings);
		return {
			CLOUDFLARE_ACCOUNT_ID: config.accountId,
			CLOUDFLARE_WORKER_NAME: identity.workerName,
			CLOUDFLARE_HOSTNAME: identity.hostname
		};
	}

	/**
	 * Feeds the deployment verifier.
	 *
	 * - Worker missing → `found: false` (the first build has not reached `wrangler deploy` yet).
	 * - Worker uploaded but its hostname not attached yet → `BUILDING`.
	 * - Worker deployed and `<hostname>` attached to it → `READY`, `website: https://<hostname>`.
	 *
	 * `projectId` is the Worker script name; the domain methods take it back as their `projectId`.
	 */
	async lookupExistingDeployment(
		projectName: string,
		token: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<{ found: boolean; website?: string; deploymentState?: string; projectId?: string }> {
		const settings = await this.effectiveSettings(context);
		const config = resolveAccountConfig(settings, token, this.envReader());
		const identity = resolveWorkerIdentity(config, settings, context?.projectNameOverride || projectName);

		const deployments = await this.api.getWorkerDeployments(token, config.accountId, identity.workerName);
		if (deployments === null) {
			return { found: false };
		}
		if (deployments.length === 0) {
			return { found: true, projectId: identity.workerName, deploymentState: 'BUILDING' satisfies VerifierState };
		}

		const domains = await this.api.listWorkerDomains(token, config.accountId, {
			service: identity.workerName,
			hostname: identity.hostname
		});
		const attached = domains.some(
			(domain) => domain.service === identity.workerName && domain.hostname?.toLowerCase() === identity.hostname
		);
		return attached
			? {
					found: true,
					projectId: identity.workerName,
					website: `https://${identity.hostname}`,
					deploymentState: 'READY' satisfies VerifierState
				}
			: { found: true, projectId: identity.workerName, deploymentState: 'BUILDING' satisfies VerifierState };
	}

	/**
	 * Token check. Account-owned tokens only verify on `/accounts/{id}/tokens/verify`, so that endpoint is
	 * used whenever the account is known; `/user/tokens/verify` covers user-owned tokens.
	 */
	async validateToken(token: string): Promise<boolean> {
		if (!token?.trim()) return false;
		const accountId = await this.tryResolveAccount({ ...(await this.ownSettings()) }, token);
		if (accountId && (await this.api.verifyAccountToken(token, accountId))) {
			return true;
		}
		return this.api.verifyUserToken(token);
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const token = typeof settings.apiToken === 'string' ? settings.apiToken.trim() : '';
		if (!token) {
			return { success: false, message: 'Enter a Cloudflare API token before validating.' };
		}

		let config: CloudflareAccountConfig;
		try {
			config = resolveAccountConfig(settings, token, this.envReader());
		} catch (error) {
			return { success: false, message: this.describe(error) };
		}

		try {
			const active =
				(await this.api.verifyAccountToken(token, config.accountId)) || (await this.api.verifyUserToken(token));
			if (!active) {
				return {
					success: false,
					message: 'Cloudflare rejected the API token (invalid, expired or not active).'
				};
			}

			const workers = await this.api.countWorkerScripts(token, config.accountId);
			const zone = await this.api.findZone(token, config.accountId, config.zoneName);
			if (!zone) {
				return {
					success: false,
					message: `The zone ${config.zoneName} was not found in this Cloudflare account (or the token cannot read it). Set "Zone" to a zone of the account and give the token Zone → Zone: Read.`
				};
			}

			return {
				success: true,
				message: config.platformManaged
					? `Using the platform's Cloudflare account; sites are published under ${config.zoneName}.`
					: `Cloudflare connection verified: ${workers} Worker(s) on the account, sites are published under ${config.zoneName}.`,
				details: {
					zoneName: config.zoneName,
					workerPrefix: config.workerPrefix,
					platformManaged: config.platformManaged
				}
			};
		} catch (error) {
			return { success: false, message: this.describe(error) };
		}
	}

	// Domain management — Workers Custom Domains on the Work's Worker (`projectId` = Worker script name).
	//
	// Note: `wrangler deploy` replaces the Worker's custom domains with the ones its config lists, so a
	// domain added here stays attached only until the next deploy unless the workflow lists it too.

	async getDomains(
		projectId: string,
		token: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentDomain[]> {
		const config = await this.domainConfig(projectId, token, context);
		const domains = await this.api.listWorkerDomains(token, config.accountId, { service: projectId });
		return domains.map((domain) => this.toDeploymentDomain(domain));
	}

	async addDomain(
		projectId: string,
		domain: string,
		token: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<AddDomainResult> {
		const config = await this.domainConfig(projectId, token, context);
		this.refuseOnPlatformAccount(config, 'add');
		const hostname = normalizeHostname(domain);

		const zone = await this.findZoneFor(token, config.accountId, hostname);
		if (!zone) {
			throw new CloudflareConfigError(
				`No zone for ${hostname} was found in your Cloudflare account. Add the domain's zone to the same Cloudflare account first.`
			);
		}
		const attached = await this.api.attachWorkerDomain(token, config.accountId, {
			hostname,
			service: projectId,
			zoneId: zone.id
		});
		const result = this.toDeploymentDomain(attached);
		return { domain: result, verified: result.verified };
	}

	async removeDomain(
		projectId: string,
		domain: string,
		token: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<boolean> {
		const config = await this.domainConfig(projectId, token, context);
		this.refuseOnPlatformAccount(config, 'remove');
		const hostname = normalizeHostname(domain);
		// Only this Worker's own attachments are candidates, so a Work can never detach another Worker's host.
		const matches = await this.api.listWorkerDomains(token, config.accountId, { service: projectId, hostname });
		let removed = false;
		for (const match of matches) {
			removed = (await this.api.detachWorkerDomain(token, config.accountId, match.id)) || removed;
		}
		return removed;
	}

	async verifyDomain(
		projectId: string,
		domain: string,
		token: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentDomain> {
		const config = await this.domainConfig(projectId, token, context);
		const hostname = normalizeHostname(domain);
		const matches = await this.api.listWorkerDomains(token, config.accountId, { service: projectId, hostname });
		if (matches.length > 0) {
			return this.toDeploymentDomain(matches[0]);
		}
		return {
			name: hostname,
			verified: false,
			verification: [
				{
					type: 'NS',
					domain: hostname,
					value: 'Cloudflare nameservers',
					reason: "A Workers Custom Domain needs the domain's zone on Cloudflare, in the same account as the Worker. Move the zone to Cloudflare, then add the domain again; Cloudflare creates the DNS record and certificate."
				}
			]
		};
	}

	// IPlugin lifecycle

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Cloudflare Workers plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Cloudflare Workers plugin is ready (account access is checked per token)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Host your work as a static website on Cloudflare Workers',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: true,
			visibility: 'user-only',
			distribution: 'core',
			readme: [
				'## What does the Cloudflare Workers plugin do?',
				'',
				'It publishes a directory website as a static site on Cloudflare Workers Static Assets: one Worker per work (`ew-<subdomain>`), served at `<subdomain>.<zone>` (for example `crm.ever.works`) through a Workers Custom Domain. Cloudflare creates the DNS record and the TLS certificate.',
				'',
				'## Why use it?',
				'',
				'- **Close to free hosting** — requests for static assets are not billed on Workers, so an idle directory costs next to nothing',
				'- **Global edge network** — pages are served from Cloudflare locations worldwide',
				'- **Automatic HTTPS and DNS** — the custom domain gets its record and certificate without manual DNS work',
				'',
				'## How it works in Ever Works',
				'',
				'When you deploy, Ever Works pushes the repository secrets `CLOUDFLARE_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKER_NAME` and `CLOUDFLARE_HOSTNAME` to the website repository and starts its `deploy_cloudflare.yaml` workflow, which builds the static site and runs `wrangler deploy`. Ever Works then polls Cloudflare until the Worker is live on its hostname.',
				'',
				'## Getting started',
				'',
				'1. Create an API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with **Account → Workers Scripts: Edit**, **Zone → Workers Routes: Edit**, **Zone → DNS: Edit** and **Zone → Zone: Read** on your zone',
				'2. Enter the token, your account ID and the zone your sites should live under',
				'3. Pick **Cloudflare Workers** as the deploy provider of a work that uses the minimal (static) website template, then deploy',
				'',
				'When the platform hosts your sites on its own Cloudflare account, there is nothing to configure.'
			].join('\n'),
			homepage: 'https://developers.cloudflare.com/workers/static-assets/',
			uiHints: {
				setupLink: {
					url: 'https://dash.cloudflare.com/profile/api-tokens',
					label: 'Cloudflare API tokens',
					buttonLabel: 'Create a Cloudflare API token',
					showWhenEmpty: ['apiToken']
				},
				includeInOnboarding: false,
				completionFields: ['apiToken', 'accountId'],
				showReadmeInOnboarding: true
			},
			icon: {
				type: 'lucide',
				value: 'Cloud',
				backgroundColor: '#F38020'
			}
		};
	}

	// Private helpers

	/** Singleton (global-scope) settings, overlaid with the Work's settings the facade resolved. */
	private async effectiveSettings(context?: DeploymentLookupContext): Promise<Record<string, unknown>> {
		return { ...(await this.ownSettings()), ...(context?.settingsOverride ?? {}) };
	}

	private async ownSettings(): Promise<Record<string, unknown>> {
		if (!this.context) return {};
		try {
			return ((await this.context.getSettings()) ?? {}) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	/**
	 * Reads only the env vars this plugin declares (`x-envVar`) through the allowlisted plugin context;
	 * `process.env` is the fallback for a plugin used outside the host (tests, scripts).
	 */
	private envReader(): EnvReader {
		const envVars = this.context?.envVars;
		return (name: string) => (envVars ? envVars.get(name) : process.env[name]);
	}

	private async tryResolveAccount(settings: Record<string, unknown>, token: string): Promise<string | undefined> {
		try {
			return resolveAccountConfig(settings, token, this.envReader()).accountId;
		} catch {
			return undefined;
		}
	}

	/** Account config for a domain call, after checking `projectId` is a Worker this plugin may address. */
	private async domainConfig(
		projectId: string,
		token: string,
		context?: DeploymentLookupContext
	): Promise<CloudflareAccountConfig> {
		const settings = await this.effectiveSettings(context);
		const config = resolveAccountConfig(settings, token, this.envReader());
		if (!isValidWorkerName(projectId)) {
			throw new CloudflareConfigError(`"${String(projectId).slice(0, 80)}" is not a Worker name.`);
		}
		// On the operator's account only Work Workers (`ew-…`) are addressable.
		if (config.platformManaged && !projectId.startsWith(DEFAULT_WORKER_PREFIX)) {
			throw new CloudflareConfigError(`Worker "${projectId}" is not a Work's Worker.`);
		}
		return config;
	}

	/**
	 * Extra domains on the operator's account are refused: the operator's token reaches every zone of that
	 * account, so attaching or detaching a member-chosen hostname there could take over a host that is not
	 * the Work's. Members who want their own domains use their own Cloudflare account.
	 */
	private refuseOnPlatformAccount(config: CloudflareAccountConfig, action: 'add' | 'remove'): void {
		if (config.platformManaged) {
			throw new CloudflareConfigError(
				`Custom domains cannot be ${action === 'add' ? 'added to' : 'removed from'} sites hosted on the platform's Cloudflare account. Connect your own Cloudflare account to use your own domain.`
			);
		}
	}

	/** The account's zone that contains `hostname` (longest matching suffix). */
	private async findZoneFor(token: string, accountId: string, hostname: string) {
		const labels = hostname.split('.');
		for (let i = 0; i < labels.length - 1; i++) {
			const candidate = labels.slice(i).join('.');
			const zone = await this.api.findZone(token, accountId, candidate);
			if (zone) return zone;
		}
		return null;
	}

	private toDeploymentDomain(domain: CloudflareWorkerDomain): DeploymentDomain {
		// A Workers Custom Domain exists only once Cloudflare accepted it for a zone of the account; the
		// DNS record and certificate are Cloudflare's, so there is nothing left for the member to verify.
		return { name: domain.hostname, verified: true };
	}

	private describe(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

export default CloudflareWorkersPlugin;
