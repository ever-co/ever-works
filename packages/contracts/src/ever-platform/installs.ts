/**
 * Install requests from apps.ever.co — what a connected installation receives
 * on its Ever Platform feed when an organization owner asks for a plugin to be
 * installed into it, and what the installation reports back.
 *
 * The request travels under the `marketplace_installs` integration (an SDK
 * identifier, consented on Ever Platform). It names the package, the version
 * and, when declared, the integrity; never a tenant, a person, an organization
 * name or a configuration value. A request installs nothing by itself: a
 * platform admin of the installation approves it in the product.
 *
 * Two wire spellings are read:
 *
 * - `ever.listings.install.state_changed` — the event Ever Platform sends the
 *   target installation on every state change of an install. A plugin install
 *   (`mechanism: instance_plugin`) in state `requested` carries the request;
 *   `cancelled` withdraws a request not yet handled; `removed` asks for the
 *   removal of an installed one. Every other state is an echo of what the
 *   installation itself reported, or a step on Ever Platform's side.
 * - `install_requested`, `install_withdrawn`, `remove_requested` — the command
 *   spelling of the same three messages, with an exact `version` and a
 *   required `integrity`.
 *
 * Both are closed: a field outside the list is refused with its path, and
 * nothing of the message is kept.
 */

/** The integration the requests and the reports travel under (an SDK key, not copy). */
export const EVER_INSTALLS_INTEGRATION_KEY = 'marketplace_installs' as const;

/** The feed event of an install's state change. */
export const EVER_INSTALL_STATE_EVENT = 'ever.listings.install.state_changed' as const;

/** The command spellings of the three messages. */
export const EVER_INSTALL_COMMANDS = ['install_requested', 'install_withdrawn', 'remove_requested'] as const;
export type EverInstallCommand = (typeof EVER_INSTALL_COMMANDS)[number];

/** Whether a feed event type is one of the install messages. */
export function isInstallFeedEventType(type: string): boolean {
	return type === EVER_INSTALL_STATE_EVENT || (EVER_INSTALL_COMMANDS as readonly string[]).includes(type);
}

/** An install's state on Ever Platform. */
export const EVER_INSTALL_STATES = [
	'requested',
	'pending_payment',
	'installing',
	'delivered',
	'installed',
	'failed',
	'removed',
	'cancelled'
] as const;
export type EverInstallState = (typeof EVER_INSTALL_STATES)[number];

/** How an install reaches its target. Only `instance_plugin` is a request this module handles. */
export const EVER_INSTALL_MECHANISMS = [
	'works_blueprint',
	'provision_product',
	'instance_plugin',
	'external_link',
	'partner_referral'
] as const;
export type EverInstallMechanism = (typeof EVER_INSTALL_MECHANISMS)[number];

/** The states an installation reports (`POST /v1/installs/{install}/status`). */
export const EVER_INSTALL_REPORT_STATES = ['installing', 'installed', 'failed', 'removed'] as const;
export type EverInstallReportState = (typeof EVER_INSTALL_REPORT_STATES)[number];

/** Why a reported install failed: a fixed token, never free text. */
export const EVER_INSTALL_DETAIL_TOKENS = [
	'checksum_mismatch',
	'incompatible_version',
	'installer_disabled',
	'permission_denied',
	'unknown'
] as const;
export type EverInstallDetailToken = (typeof EVER_INSTALL_DETAIL_TOKENS)[number];

/** The body of `POST /v1/installs/{install}/status`. */
export interface EverInstallStatusReport {
	readonly state: EverInstallReportState;
	/** One of {@link EVER_INSTALL_DETAIL_TOKENS}; only with `failed`. */
	readonly detail?: EverInstallDetailToken;
	/** The installation's own reference to the installed plugin (its plugin id). */
	readonly external_ref?: string;
	/** The version installed; only with `installed`. */
	readonly version?: string;
}

/** Where the requested plugin comes from. */
export type EverInstallSource =
	| { readonly kind: 'registry'; readonly registry: 'npm' | 'oci' | 'cargo'; readonly packageName: string }
	| { readonly kind: 'repo'; readonly repo: string; readonly sha: string };

/** A plugin install request, as parsed from the feed. Identifiers and package coordinates only. */
export interface EverPluginInstallRequest {
	readonly installId: string;
	readonly listingSlug: string;
	readonly source: EverInstallSource;
	/** The exact version, a semver range, or `null` when the request names none. */
	readonly version: string | null;
	/** Whether {@link version} is one exact version. */
	readonly versionIsExact: boolean;
	/** `sha512-…` (or `sha256-…`, `sha384-…`), when the request declares it. */
	readonly integrity: string | null;
	readonly editionKey: string | null;
	/** The Ever organization that asked (an id), when the message carries it. */
	readonly orgId: string | null;
	/** The installation the request is for (Ever Platform's id), when the message carries it. */
	readonly instanceId: string | null;
}

/** What one install message means for this installation. */
export type EverInstallFeedMessage =
	/** A plugin install is requested. */
	| { readonly kind: 'requested'; readonly request: EverPluginInstallRequest }
	/** A request not yet handled is withdrawn (cancelled before it was delivered). */
	| { readonly kind: 'withdrawn'; readonly installId: string }
	/** The removal of an installed plugin is asked for; the installation decides. */
	| { readonly kind: 'remove_requested'; readonly installId: string }
	/** Another state of a plugin install: an echo of a report, or a step on Ever Platform's side. */
	| { readonly kind: 'state'; readonly installId: string; readonly state: EverInstallState }
	/** An install of another mechanism (a blueprint, a product): left to its own handler. */
	| { readonly kind: 'other_mechanism'; readonly installId: string; readonly mechanism: EverInstallMechanism }
	/** Not a well-formed message: the path of the first field at fault, and why. */
	| { readonly kind: 'rejected'; readonly path: string; readonly code: InstallFieldCode };

/** Why a field was refused. */
export type InstallFieldCode = 'not_an_object' | 'unknown_field' | 'required' | 'invalid';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EDITION_KEY = /^[a-z0-9][a-z0-9_-]{0,40}$/;
/** An npm package name (with an optional scope), at most 214 characters. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** A registry package id of another registry (as Ever Platform pins it). */
const PACKAGE_ID = /^[@a-z0-9][a-z0-9._/@-]{0,213}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_RANGE = /^[0-9A-Za-z.*^~<>=| -]{1,64}$/;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]{20,}={0,2}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const HTTPS_URL = /^https:\/\/[^\s]{1,2040}$/;

/** The fields of `ever.listings.install.state_changed` (plus the request's `version` and `integrity`). */
const STATE_EVENT_FIELDS = new Set([
	'install_id',
	'listing_id',
	'edition_id',
	'org_id',
	'instance_id',
	'mechanism',
	'state',
	'next_action_url',
	'listing_slug',
	'edition_key',
	'package',
	'version',
	'integrity'
]);
const PACKAGE_FIELDS = new Set(['registry', 'id', 'version_range']);
const REQUEST_COMMAND_FIELDS = new Set([
	'install_id',
	'kind',
	'listing_slug',
	'package',
	'source',
	'version',
	'integrity',
	'edition_key'
]);
const ID_COMMAND_FIELDS = new Set(['install_id']);
const SOURCE_FIELDS = new Set(['repo', 'sha']);

class Refused extends Error {
	constructor(
		readonly path: string,
		readonly code: InstallFieldCode
	) {
		super(`${path}: ${code}`);
	}
}

type Fields = Record<string, unknown>;

function object(value: unknown, path: string): Fields {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refused(path, 'not_an_object');
	return value as Fields;
}

function closed(value: Fields, allowed: ReadonlySet<string>, path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Refused(`${path}/${key}`, 'unknown_field');
	}
}

function text(value: Fields, key: string, path: string, pattern: RegExp, required: true): string;
function text(value: Fields, key: string, path: string, pattern: RegExp, required: false): string | null;
function text(value: Fields, key: string, path: string, pattern: RegExp, required: boolean): string | null {
	const raw = value[key];
	if (raw === undefined || raw === null) {
		if (required) throw new Refused(`${path}/${key}`, 'required');
		return null;
	}
	if (typeof raw !== 'string' || !pattern.test(raw)) throw new Refused(`${path}/${key}`, 'invalid');
	return raw;
}

function oneOf<T extends string>(value: Fields, key: string, path: string, allowed: readonly T[]): T {
	const raw = value[key];
	if (raw === undefined || raw === null) throw new Refused(`${path}/${key}`, 'required');
	if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
		throw new Refused(`${path}/${key}`, 'invalid');
	}
	return raw as T;
}

function isNpmName(name: string): boolean {
	return name.length <= 214 && NPM_NAME.test(name);
}

/** `ever.listings.install.state_changed`. */
function parseStateEvent(data: unknown): EverInstallFeedMessage {
	const event = object(data, '');
	closed(event, STATE_EVENT_FIELDS, '');
	const installId = text(event, 'install_id', '', ULID, true);
	text(event, 'listing_id', '', ULID, true);
	text(event, 'edition_id', '', ULID, false);
	const orgId = text(event, 'org_id', '', ULID, true);
	const instanceId = text(event, 'instance_id', '', ULID, false);
	const mechanism = oneOf(event, 'mechanism', '', EVER_INSTALL_MECHANISMS);
	const state = oneOf(event, 'state', '', EVER_INSTALL_STATES);
	text(event, 'next_action_url', '', HTTPS_URL, false);
	if (mechanism !== 'instance_plugin') return { kind: 'other_mechanism', installId, mechanism };
	if (state === 'cancelled') return { kind: 'withdrawn', installId };
	if (state === 'removed') return { kind: 'remove_requested', installId };
	if (state !== 'requested') return { kind: 'state', installId, state };

	const listingSlug = text(event, 'listing_slug', '', SLUG, true);
	const editionKey = text(event, 'edition_key', '', EDITION_KEY, false);
	const pkg = object(event.package, '/package');
	closed(pkg, PACKAGE_FIELDS, '/package');
	const registry = oneOf(pkg, 'registry', '/package', ['npm', 'oci', 'cargo'] as const);
	const packageName = text(pkg, 'id', '/package', PACKAGE_ID, true);
	if (registry === 'npm' && !isNpmName(packageName)) throw new Refused('/package/id', 'invalid');
	const range = text(pkg, 'version_range', '/package', VERSION_RANGE, false);
	const exact = text(event, 'version', '', EXACT_VERSION, false);
	return {
		kind: 'requested',
		request: {
			installId,
			listingSlug,
			source: { kind: 'registry', registry, packageName },
			version: exact ?? range,
			versionIsExact: exact !== null,
			integrity: text(event, 'integrity', '', INTEGRITY, false),
			editionKey,
			orgId,
			instanceId
		}
	};
}

/** `install_requested {install_id, kind, listing_slug, package | source{repo, sha}, version, integrity, edition_key}`. */
function parseRequestCommand(data: unknown): EverInstallFeedMessage {
	const command = object(data, '');
	closed(command, REQUEST_COMMAND_FIELDS, '');
	const installId = text(command, 'install_id', '', ULID, true);
	const kind = command.kind;
	if (kind === 'works_blueprint') return { kind: 'other_mechanism', installId, mechanism: 'works_blueprint' };
	if (kind !== 'instance_plugin') throw new Refused('/kind', kind === undefined ? 'required' : 'invalid');
	const listingSlug = text(command, 'listing_slug', '', SLUG, true);
	const hasPackage = command.package !== undefined && command.package !== null;
	const hasSource = command.source !== undefined && command.source !== null;
	if (hasPackage === hasSource)
		throw new Refused(hasPackage ? '/source' : '/package', hasPackage ? 'invalid' : 'required');
	let source: EverInstallSource;
	let pinned: string | null = null;
	if (hasPackage) {
		// An npm name with an optional `@version` after it.
		const raw = command.package;
		if (typeof raw !== 'string' || raw.length > 280) throw new Refused('/package', 'invalid');
		const at = raw.lastIndexOf('@');
		const name = at > 0 ? raw.slice(0, at) : raw;
		pinned = at > 0 ? raw.slice(at + 1) : null;
		if (!isNpmName(name) || (pinned !== null && !EXACT_VERSION.test(pinned))) {
			throw new Refused('/package', 'invalid');
		}
		source = { kind: 'registry', registry: 'npm', packageName: name };
	} else {
		const repo = object(command.source, '/source');
		closed(repo, SOURCE_FIELDS, '/source');
		source = {
			kind: 'repo',
			repo: text(repo, 'repo', '/source', REPO, true),
			sha: text(repo, 'sha', '/source', SHA, true)
		};
	}
	const version = text(command, 'version', '', EXACT_VERSION, true);
	if (pinned !== null && pinned !== version) throw new Refused('/package', 'invalid');
	return {
		kind: 'requested',
		request: {
			installId,
			listingSlug,
			source,
			version,
			versionIsExact: true,
			integrity: text(command, 'integrity', '', INTEGRITY, true),
			editionKey: text(command, 'edition_key', '', EDITION_KEY, false),
			orgId: null,
			instanceId: null
		}
	};
}

function parseIdCommand(data: unknown, kind: 'withdrawn' | 'remove_requested'): EverInstallFeedMessage {
	const command = object(data, '');
	closed(command, ID_COMMAND_FIELDS, '');
	return { kind, installId: text(command, 'install_id', '', ULID, true) };
}

/**
 * Read one install message of the feed. Never throws: a message that is not
 * well formed answers `rejected` with the path of the first field at fault.
 * `type` must satisfy {@link isInstallFeedEventType}.
 */
export function parseInstallFeedMessage(type: string, data: unknown): EverInstallFeedMessage {
	try {
		switch (type) {
			case EVER_INSTALL_STATE_EVENT:
				return parseStateEvent(data);
			case 'install_requested':
				return parseRequestCommand(data);
			case 'install_withdrawn':
				return parseIdCommand(data, 'withdrawn');
			case 'remove_requested':
				return parseIdCommand(data, 'remove_requested');
			default:
				return { kind: 'rejected', path: '#type', code: 'invalid' };
		}
	} catch (error) {
		if (error instanceof Refused) return { kind: 'rejected', path: error.path || '/', code: error.code };
		throw error;
	}
}

/** Whether `value` is one of the detail tokens. */
export function isInstallDetailToken(value: unknown): value is EverInstallDetailToken {
	return typeof value === 'string' && (EVER_INSTALL_DETAIL_TOKENS as readonly string[]).includes(value);
}

/**
 * The body of a status report: `detail` only with `failed` (a token), `version`
 * only with `installed`, `external_ref` at most 128 characters.
 */
export function installStatusReport(input: {
	state: EverInstallReportState;
	detail?: EverInstallDetailToken | null;
	version?: string | null;
	externalRef?: string | null;
}): EverInstallStatusReport {
	if (!(EVER_INSTALL_REPORT_STATES as readonly string[]).includes(input.state)) {
		throw new TypeError(`Not a reportable install state: ${String(input.state)}`);
	}
	const body: {
		state: EverInstallReportState;
		detail?: EverInstallDetailToken;
		external_ref?: string;
		version?: string;
	} = { state: input.state };
	if (input.state === 'failed') body.detail = isInstallDetailToken(input.detail) ? input.detail : 'unknown';
	if (input.state === 'installed' && input.version && input.version.length <= 64) body.version = input.version;
	if (input.externalRef && input.externalRef.length <= 128) body.external_ref = input.externalRef;
	return body;
}

/** Where an install request stands on this installation. */
export type EverInstallRequestState =
	| 'requested'
	| 'installing'
	| 'installed'
	| 'failed'
	| 'declined'
	| 'withdrawn'
	| 'removed';

/** The package's place on the plugin allow-list (first-party packages are always allowed). */
export type EverInstallAllowlistState = 'first_party' | 'allowed' | 'disabled' | 'absent';

/** Why an open request cannot be installed on this installation. */
export type EverInstallNotInstallableReason = 'source_not_supported' | 'plugin_unknown';

/** One install request, as the platform admins see it (`GET /api/ever-connect/install-requests`). */
export interface EverInstallRequestView {
	readonly installId: string;
	readonly listingSlug: string;
	readonly packageName: string | null;
	readonly registry: string | null;
	readonly sourceRepo: string | null;
	readonly sourceSha: string | null;
	readonly version: string | null;
	readonly versionIsExact: boolean;
	readonly integrity: string | null;
	readonly editionKey: string | null;
	readonly state: EverInstallRequestState;
	readonly detail: string | null;
	readonly pluginId: string | null;
	readonly installedVersion: string | null;
	readonly allowlistAdded: boolean;
	readonly receivedAt: string;
	readonly decidedAt: string | null;
	readonly removalRequestedAt: string | null;
	/** For an open request: the package's allow-list state. */
	readonly allowlist: EverInstallAllowlistState | null;
	/** For an open request: why it cannot be installed here, or `null`. */
	readonly notInstallable: EverInstallNotInstallableReason | null;
}

/** `GET /api/ever-connect/install-requests`. */
export interface EverInstallRequestsView {
	/** Whether dynamic plugin installs run on this installation (`PLUGIN_DISTRIBUTION_MODE=dynamic`). */
	readonly installerEnabled: boolean;
	/** Whether `marketplace_installs` is enabled for one of the installation's tenant links. */
	readonly integrationEnabled: boolean;
	readonly requests: EverInstallRequestView[];
}
