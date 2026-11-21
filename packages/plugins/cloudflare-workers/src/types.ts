/**
 * Environment variables that put the plugin in **platform-managed** mode: the operator's own Cloudflare
 * account hosts every Work's Worker. They are declared through `x-envVar` on the settings schema, which is
 * also what lets the plugin read them through its (allowlisted) `PluginContext.envVars`.
 */
export const CLOUDFLARE_DEPLOY_ENV = {
	apiToken: 'CLOUDFLARE_DEPLOY_API_TOKEN',
	accountId: 'CLOUDFLARE_DEPLOY_ACCOUNT_ID',
	zoneName: 'CLOUDFLARE_DEPLOY_ZONE_NAME'
} as const;

/** Zone that public hostnames are created in when nothing else is configured. */
export const DEFAULT_ZONE_NAME = 'ever.works';

/** Prefix of every Worker script name (`ew-<subdomain>`). Fixed in platform-managed mode. */
export const DEFAULT_WORKER_PREFIX = 'ew-';

/** The GitHub Actions workflow the website template ships for this provider. */
export const CLOUDFLARE_WORKFLOW_FILE = 'deploy_cloudflare.yaml';

/** Cloudflare v4 REST API base URL. */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Keys the platform adds to the settings it hands this plugin (deploy settings and the lookup context's
 * `settingsOverride`). They are not part of the settings schema, so a member can never store them.
 */
export interface CloudflarePlatformFacts {
	/** The Work's persisted managed subdomain label (`work.managedSubdomain`), when it has one. */
	managedSubdomain?: string | null;
	/** The Work slug — fallback for the label (leading `awesome-` removed). */
	workSlug?: string | null;
	/** `true` when the deploy credential is the operator's, not the member's own. */
	platformManaged?: boolean;
}

/** Everything that decides where a Work is hosted. */
export interface CloudflareAccountConfig {
	readonly accountId: string;
	readonly zoneName: string;
	readonly workerPrefix: string;
	readonly platformManaged: boolean;
}

/** One Work's Worker on Cloudflare. */
export interface CloudflareWorkerIdentity {
	/** DNS label (the managed subdomain), e.g. `crm`. */
	readonly label: string;
	/** Worker script name, e.g. `ew-crm`. */
	readonly workerName: string;
	/** Public hostname, e.g. `crm.ever.works`. */
	readonly hostname: string;
}

/** A Workers Custom Domain as the Cloudflare API returns it. */
export interface CloudflareWorkerDomain {
	readonly id: string;
	readonly hostname: string;
	readonly service: string;
	readonly zone_id?: string;
	readonly zone_name?: string;
	readonly environment?: string;
	readonly cert_id?: string;
}

/** A Worker deployment as the Cloudflare API returns it. */
export interface CloudflareWorkerDeployment {
	readonly id: string;
	readonly created_on: string;
	readonly source?: string;
}

/** A zone as the Cloudflare API returns it (only the fields used here). */
export interface CloudflareZone {
	readonly id: string;
	readonly name: string;
	readonly status?: string;
}
