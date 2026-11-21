import type { JsonSchema } from '@ever-works/plugin';
import { CLOUDFLARE_DEPLOY_ENV, DEFAULT_WORKER_PREFIX, DEFAULT_ZONE_NAME } from './types.js';

/**
 * Settings of the `cloudflare` deploy provider.
 *
 * Two modes:
 *
 * - **Your own Cloudflare account** — the member stores `apiToken` (secret) and `accountId`, and may change
 *   `zoneName` and `workerPrefix`.
 * - **Platform-managed** — the operator sets `CLOUDFLARE_DEPLOY_API_TOKEN` / `CLOUDFLARE_DEPLOY_ACCOUNT_ID`
 *   / `CLOUDFLARE_DEPLOY_ZONE_NAME`. `apiToken` falls back to the env token (secret + `x-envVar` is the BYOK
 *   pattern: a member's own value still wins), and the account and zone come from the two admin-only
 *   `platform*` fields below.
 *
 * Why the account and zone have separate `platform*` fields instead of an `x-envVar` on `accountId` /
 * `zoneName`: a NON-secret field that carries `x-envVar` is operator-only — `PluginSettingsService`
 * rejects it from every write — so putting the env binding on the member's own fields would make
 * bring-your-own-account impossible. The split also keeps the two modes from mixing: in platform-managed
 * mode the plugin never reads the member's account, zone or prefix (see `resolveAccountConfig`).
 */
export const cloudflareWorkersSettingsSchema: JsonSchema = {
	type: 'object',
	properties: {
		apiToken: {
			type: 'string',
			title: 'Cloudflare API token',
			description:
				'API token with Account → Workers Scripts: Edit, Zone → Workers Routes: Edit, Zone → DNS: Edit and Zone → Zone: Read on the zone that serves your sites. Create one at https://dash.cloudflare.com/profile/api-tokens.',
			'x-secret': true,
			'x-scope': 'user',
			'x-envVar': CLOUDFLARE_DEPLOY_ENV.apiToken
		},
		accountId: {
			type: 'string',
			title: 'Cloudflare account ID',
			description:
				'The 32-character account ID shown in the Cloudflare dashboard (Workers & Pages → Account details). Not needed when the platform hosts your sites.',
			pattern: '^[a-fA-F0-9]{32}$',
			'x-scope': 'user'
		},
		zoneName: {
			type: 'string',
			title: 'Zone',
			description:
				'The Cloudflare zone your sites are published under: a Work with the subdomain "crm" is served at crm.<zone>. The zone must be in the same account.',
			default: DEFAULT_ZONE_NAME,
			'x-scope': 'user'
		},
		workerPrefix: {
			type: 'string',
			title: 'Worker name prefix',
			description: 'Prefix of each Work\'s Worker script name, e.g. "ew-" gives "ew-crm".',
			default: DEFAULT_WORKER_PREFIX,
			maxLength: 20,
			'x-scope': 'user'
		},
		platformAccountId: {
			type: 'string',
			title: 'Platform Cloudflare account ID',
			description: `Account that hosts platform-managed sites. Set by the operator through ${CLOUDFLARE_DEPLOY_ENV.accountId}.`,
			'x-envVar': CLOUDFLARE_DEPLOY_ENV.accountId,
			'x-adminOnly': true,
			'x-scope': 'global'
		},
		platformZoneName: {
			type: 'string',
			title: 'Platform zone',
			description: `Zone of platform-managed sites. Set by the operator through ${CLOUDFLARE_DEPLOY_ENV.zoneName}.`,
			default: DEFAULT_ZONE_NAME,
			'x-envVar': CLOUDFLARE_DEPLOY_ENV.zoneName,
			'x-adminOnly': true,
			'x-scope': 'global'
		}
	},
	required: ['apiToken']
};
