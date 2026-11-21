import { createHash } from 'node:crypto';

import {
	CLOUDFLARE_DEPLOY_ENV,
	DEFAULT_WORKER_PREFIX,
	DEFAULT_ZONE_NAME,
	type CloudflareAccountConfig,
	type CloudflareWorkerIdentity
} from './types.js';

/**
 * A setting is missing or malformed. The message is safe to show a member: it names the setting, never a
 * credential value.
 */
export class CloudflareConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CloudflareConfigError';
	}
}

/** Reads one of the plugin's declared environment variables. */
export type EnvReader = (name: string) => string | undefined;

/** Cloudflare account ids are 32 hex characters; anything else is refused before it reaches a URL path. */
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;
/** A DNS label / Worker script name: lowercase letters, digits and inner hyphens. */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PREFIX_RE = /^[a-z0-9][a-z0-9-]*$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** Workers script names are limited to 63 characters. */
const MAX_WORKER_NAME = 63;
const MAX_PREFIX = 20;

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Is the deploy credential the operator's rather than the member's own?
 *
 * True when the platform says so (`platformManaged`, set by the deployment-context resolver from the
 * token's setting source) or when the token is byte-for-byte the operator's `CLOUDFLARE_DEPLOY_API_TOKEN`
 * — the credential itself proves it, whatever the stored settings claim (the same rule the k8s plugin
 * applies to operator kubeconfigs).
 */
export function isPlatformManaged(
	settings: Record<string, unknown>,
	token: string | undefined,
	env: EnvReader
): boolean {
	if (settings.platformManaged === true) return true;
	const platformToken = str(env(CLOUDFLARE_DEPLOY_ENV.apiToken));
	if (!platformToken) return false;
	const candidates = [str(token), str(settings.apiToken)];
	return candidates.some((candidate) => candidate.length > 0 && candidate === platformToken);
}

/**
 * The account, zone and Worker prefix a deploy targets.
 *
 * Platform-managed: every value comes from the operator (`CLOUDFLARE_DEPLOY_*` env vars, or the admin-only
 * `platform*` settings they back) and the prefix is fixed. A member's own `accountId`, `zoneName` or
 * `workerPrefix` is ignored, so a member can never point the operator's token at another zone of the
 * operator's account or at a Worker that is not a Work's.
 *
 * Member's own account: the member's `accountId` (required), `zoneName` and `workerPrefix`.
 */
export function resolveAccountConfig(
	settings: Record<string, unknown>,
	token: string | undefined,
	env: EnvReader
): CloudflareAccountConfig {
	const platformManaged = isPlatformManaged(settings, token, env);

	const accountId = platformManaged
		? str(settings.platformAccountId) || str(env(CLOUDFLARE_DEPLOY_ENV.accountId))
		: str(settings.accountId);
	if (!accountId) {
		throw new CloudflareConfigError(
			platformManaged
				? `Platform-managed Cloudflare deploys need ${CLOUDFLARE_DEPLOY_ENV.accountId} to be set by the operator.`
				: 'Enter your Cloudflare account ID in the Cloudflare Workers plugin settings.'
		);
	}
	if (!ACCOUNT_ID_RE.test(accountId)) {
		throw new CloudflareConfigError(
			'The Cloudflare account ID must be the 32-character hex id shown in the dashboard.'
		);
	}

	const zoneName = (
		platformManaged
			? str(settings.platformZoneName) || str(env(CLOUDFLARE_DEPLOY_ENV.zoneName)) || DEFAULT_ZONE_NAME
			: str(settings.zoneName) || DEFAULT_ZONE_NAME
	)
		.toLowerCase()
		.replace(/\.$/, '');
	if (!HOSTNAME_RE.test(zoneName)) {
		throw new CloudflareConfigError(
			`"${zoneName.slice(0, 100)}" is not a valid zone name (for example ever.works).`
		);
	}

	const workerPrefix = platformManaged ? DEFAULT_WORKER_PREFIX : resolveMemberPrefix(settings.workerPrefix);

	return { accountId: accountId.toLowerCase(), zoneName, workerPrefix, platformManaged };
}

function resolveMemberPrefix(raw: unknown): string {
	if (typeof raw !== 'string') return DEFAULT_WORKER_PREFIX;
	const prefix = raw.trim().toLowerCase();
	if (prefix === '') return '';
	if (prefix.length > MAX_PREFIX || !PREFIX_RE.test(prefix)) {
		throw new CloudflareConfigError(
			`The Worker name prefix may hold up to ${MAX_PREFIX} lowercase letters, digits and hyphens, and must start with a letter or digit.`
		);
	}
	return prefix;
}

/** Lowercase, collapse anything outside `[a-z0-9]` to single hyphens, trim edge hyphens, clamp to 63. */
export function toDnsLabel(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+/, '')
		.slice(0, 63)
		.replace(/-+$/, '');
}

/**
 * The Work's hostname label.
 *
 * 1. The persisted managed subdomain (`work.managedSubdomain`, allocated collision-free by the platform).
 * 2. Otherwise the Work slug with a leading `awesome-` removed (`awesome-crm` → `crm`).
 * 3. Otherwise the website repository name, with its `-website` suffix and leading `awesome-` removed.
 */
export function resolveLabel(settings: Record<string, unknown>, projectName?: string): string {
	const persisted = toDnsLabel(str(settings.managedSubdomain));
	if (persisted) return persisted;

	const slug = str(settings.workSlug) || str(projectName).replace(/-website$/i, '');
	const lowered = slug.toLowerCase();
	const stripped = lowered.startsWith('awesome-') ? lowered.slice('awesome-'.length) : lowered;
	const label = toDnsLabel(stripped) || toDnsLabel(lowered);
	if (!label) {
		throw new CloudflareConfigError(
			'Cannot derive a hostname for this Work: it has no managed subdomain and no usable slug.'
		);
	}
	return label;
}

/**
 * `<prefix><label>`, kept within the 63-character Workers limit.
 *
 * A label that does not fit is cut and given an 8-hex digest of the WHOLE label, so two long labels that
 * share their first characters still get different Workers (a plain cut would map them onto one Worker).
 */
export function buildWorkerName(prefix: string, label: string): string {
	const room = MAX_WORKER_NAME - prefix.length;
	const fitted =
		label.length <= room
			? label
			: `${label.slice(0, room - 9).replace(/-+$/, '')}-${createHash('sha256').update(label).digest('hex').slice(0, 8)}`;
	const name = `${prefix}${fitted.replace(/-+$/, '')}`;
	if (!NAME_RE.test(name)) {
		throw new CloudflareConfigError(`"${name}" is not a valid Worker name.`);
	}
	return name;
}

/** Worker name and public hostname for one Work. */
export function resolveWorkerIdentity(
	config: CloudflareAccountConfig,
	settings: Record<string, unknown>,
	projectName?: string
): CloudflareWorkerIdentity {
	// On the shared platform account the label MUST be the Work's allocated managed subdomain (unique across all
	// tenants). Work slugs are not unique, so a slug fallback could address another tenant's Worker (review of #3275).
	if (config.platformManaged && !toDnsLabel(str(settings.managedSubdomain))) {
		throw new CloudflareConfigError(
			'This Work has no allocated ever.works subdomain yet; refusing to derive a Worker name from its slug on the shared platform account.'
		);
	}
	const label = resolveLabel(settings, projectName);
	return {
		label,
		workerName: buildWorkerName(config.workerPrefix, label),
		hostname: `${label}.${config.zoneName}`
	};
}

/** Is this a Worker script name the plugin may address (also guards URL paths)? */
export function isValidWorkerName(name: string): boolean {
	return name.length <= MAX_WORKER_NAME && NAME_RE.test(name);
}

/** Normalise and validate a hostname a member typed. */
export function normalizeHostname(raw: string): string {
	const hostname = str(raw).toLowerCase().replace(/\.$/, '');
	if (!HOSTNAME_RE.test(hostname)) {
		throw new CloudflareConfigError(`"${hostname.slice(0, 100)}" is not a valid hostname.`);
	}
	return hostname;
}
