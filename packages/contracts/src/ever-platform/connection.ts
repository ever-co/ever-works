/**
 * The connection of an Ever Works installation to Ever Platform, as Settings →
 * Ever Platform shows it: the connection itself (platform admins), an
 * Organization's link to its Ever organization (the Organization's members),
 * and what the parts that are switched on separately report.
 *
 * Everything here is an identifier, a state word, a date or a count. No key,
 * token, code or signed document is ever part of a view.
 */

/** Where the installation's connection stands. */
export const EVER_PLATFORM_CONNECTION_STATES = ['disconnected', 'pending_approval', 'active', 'revoked'] as const;
export type EverPlatformConnectionState = (typeof EVER_PLATFORM_CONNECTION_STATES)[number];

/** The two codes a person brings from app.ever.co. */
export type EverPlatformCodeKind = 'connect' | 'link';

const CODE_PREFIX: Readonly<Record<EverPlatformCodeKind, string>> = { connect: 'EVC', link: 'EVL' };

/**
 * The canonical spelling of a code a person typed or pasted
 * (`EVC-XXXX-XXXX-XXXX` to connect an installation, `EVL-XXXX-XXXX-XXXX` to
 * link an Organization), or `null` when it is not one. Case, surrounding
 * space and the dashes between the groups do not matter; the letters I, L, O
 * and U never appear in a code.
 */
export function normalizeEverPlatformCode(input: unknown, kind: EverPlatformCodeKind): string | null {
	if (typeof input !== 'string' || input.length > 64) return null;
	const prefix = CODE_PREFIX[kind];
	const compact = input.toUpperCase().replace(/[\s-]+/g, '');
	if (!compact.startsWith(prefix)) return null;
	const body = compact.slice(prefix.length);
	if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(body)) return null;
	return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/**
 * Where an entitlement document stands: `valid` until it expires, `grace` for
 * the period after that (its features still apply), then `paused`. Only Ever
 * Platform features pause; Ever Works keeps working.
 */
export type EverPlatformEntitlementStatus = 'valid' | 'grace' | 'paused';

/** What a stored, verified entitlement document says (never the document itself). */
export interface EverPlatformEntitlementView {
	readonly status: EverPlatformEntitlementStatus;
	/** The Ever organization's handle (`ever.co/<handle>`). */
	readonly handle: string | null;
	readonly tier: string | null;
	/** The plan's code. */
	readonly plan: string | null;
	readonly features: Readonly<Record<string, boolean>>;
	readonly limits: Readonly<Record<string, number>>;
	readonly seq: number | null;
	readonly issuedAt: string | null;
	readonly expiresAt: string | null;
	/** When the document was last read from Ever Platform. */
	readonly fetchedAt: string | null;
	/** The machine code of the last read that was refused or failed, if the last one was. */
	readonly lastError: string | null;
}

/** The apps mirror, as the platform admin sees it. */
export interface EverPlatformAppSyncStatusView {
	/** Organizations whose link has the integration enabled. */
	readonly linksEnabled: number;
	/** Works with a change waiting to be sent. */
	readonly pending: number;
	/** Works whose last report Ever Platform refused. */
	readonly failed: number;
	readonly lastError: string | null;
	/** When the full set was last sent again. */
	readonly reconciledAt: string | null;
}

/** Which separately switched parts this installation runs. */
export interface EverPlatformFeaturesView {
	readonly linkCodes: boolean;
	readonly heartbeat: boolean;
	readonly entitlements: boolean;
	readonly appSync: boolean;
}

/** One installation-wide integration as Ever Platform reports it. */
export interface EverPlatformIntegrationView {
	readonly key: string;
	readonly state: string;
	readonly enabled: boolean;
}

/** `GET /api/ever-connect/status` (platform admins only). */
export interface EverPlatformConnectionStatusView {
	readonly connection: {
		readonly status: EverPlatformConnectionState;
		readonly platformInstanceId: string | null;
		readonly connectedAt: string | null;
		readonly lastError: string | null;
	};
	readonly integrations: readonly EverPlatformIntegrationView[];
	readonly outbox: { readonly pending: number; readonly failed: number; readonly lastError: string | null };
	readonly features: EverPlatformFeaturesView;
	/** When Ever Platform last recorded a heartbeat; `null` when none was, or the heartbeat is off. */
	readonly heartbeat: { readonly lastSentAt: string | null };
	/** The installation's entitlement document; `null` when none is stored or reading is off. */
	readonly entitlement: EverPlatformEntitlementView | null;
	/** `null` when the apps mirror is off. */
	readonly appSync: EverPlatformAppSyncStatusView | null;
}

/** How an Organization's link was made. */
export type EverPlatformLinkOrigin = 'provisioning' | 'link_code';

/** An Organization's link to its Ever organization. */
export interface EverPlatformLinkView {
	/** Ever Platform's id of the organization. */
	readonly everOrgId: string;
	/** The Ever organization's handle, once known. */
	readonly handle: string | null;
	readonly createdVia: EverPlatformLinkOrigin;
	readonly linkedAt: string;
}

/** `GET /api/ever-connect/organizations/:orgId/link`. */
export interface EverPlatformOrganizationLinkView {
	/** Whether the installation is connected to Ever Platform (a link needs it). */
	readonly connected: boolean;
	readonly link: EverPlatformLinkView | null;
	/** The link's entitlement document; `null` without a link, a stored document, or with reading off. */
	readonly entitlement: EverPlatformEntitlementView | null;
	/** Whether the apps mirror runs for this Organization (switched on here and enabled in app.ever.co). */
	readonly appSync: boolean;
}
