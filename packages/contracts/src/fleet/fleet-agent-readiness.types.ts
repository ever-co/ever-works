/**
 * Fleet agent readiness — "can at least one agent actually work on this
 * computer right now?"
 *
 * The defect this closes (prod, 2026-11): a node read `online`, its popup
 * showed `Agent CLI claude 2.1.319`, and every run sent to it failed at once
 * with `Your organization has disabled Claude subscription access for Claude
 * Code · Use an Anthropic API key instead, or ask your admin to enable
 * access`. Before that, the same node failed for days on an expired OAuth
 * session. "Online" and "CLI installed" are facts about the machine and the
 * binary; neither says whether the seat behind the binary may run a model.
 *
 * So the node reports, per agent CLI it knows, what it can find out WITHOUT
 * spending a model token:
 *
 *  - installed + version (the pinned binary a run would spawn);
 *  - auth state from the CLI's own free status command (`claude auth status`,
 *    `codex login status`): signed in or not, the method, and the account
 *    label when the CLI prints one;
 *  - what the last real runs proved: the last successful run, and the last
 *    failure classified from the CLI's own sentence
 *    ({@link classifyFleetAgentFailure});
 *  - usage windows when a real run (or a record it left) carried them.
 *
 * No probe ever starts a model call. A status the node cannot prove is
 * `unknown`, never `ready`.
 *
 * Shared by the node (which builds the report), the API (which stores it and
 * derives the node-level answer) and the web tier (which renders it).
 * Dependency-free, like the rest of this package.
 */

import { detectFleetModelUsageLimit, type FleetNodeModelThrottleView } from './fleet-model-usage-limit.types.js';

/**
 * Whether one agent CLI can take work:
 * - `ready`         — installed, signed in, and nothing the last runs said contradicts it;
 * - `not_signed_in` — no credential, or the CLI said its session expired / was revoked / is invalid;
 * - `access_denied` — signed in, but the account may not use the CLI (organization policy, a 403);
 * - `limit_reached` — out of quota or credit until a reset;
 * - `not_installed` — the node has no such CLI (or could not find it at startup);
 * - `unsupported`   — installed, but this node version cannot run agent work with it;
 * - `unknown`       — the node could not tell (the status command did not answer).
 */
export type FleetAgentReadinessStatus =
	| 'ready'
	| 'not_signed_in'
	| 'access_denied'
	| 'limit_reached'
	| 'not_installed'
	| 'unsupported'
	| 'unknown';

export const FLEET_AGENT_READINESS_STATUSES: readonly FleetAgentReadinessStatus[] = [
	'ready',
	'not_signed_in',
	'access_denied',
	'limit_reached',
	'not_installed',
	'unsupported',
	'unknown'
];

/**
 * How the CLI is signed in:
 * - `subscription`   — a Claude subscription login or long-lived subscription token; a ChatGPT login;
 * - `api_key`        — an API key (or an API-key helper);
 * - `access_token`   — another bearer credential (Codex access token, personal access token, workload identity);
 * - `cloud_provider` — a third-party platform (Bedrock, Vertex, Foundry);
 * - `none`           — not signed in;
 * - `unknown`        — signed in, method not stated (or the status command did not answer).
 */
export type FleetAgentAuthMethod = 'subscription' | 'api_key' | 'access_token' | 'cloud_provider' | 'none' | 'unknown';

export const FLEET_AGENT_AUTH_METHODS: readonly FleetAgentAuthMethod[] = [
	'subscription',
	'api_key',
	'access_token',
	'cloud_provider',
	'none',
	'unknown'
];

/** Most agent CLIs one report lists. */
export const FLEET_AGENT_READINESS_MAX_AGENTS = 8;
/** Cap on the provider token (`claude-code`). */
export const FLEET_AGENT_READINESS_MAX_PROVIDER_LENGTH = 32;
/** Cap on a CLI version string. */
export const FLEET_AGENT_READINESS_MAX_VERSION_LENGTH = 64;
/** Cap on the account label (`user@example.com (Acme, max)`). */
export const FLEET_AGENT_READINESS_MAX_ACCOUNT_LENGTH = 200;
/** Cap on the human reason (the CLI's own sentence). */
export const FLEET_AGENT_READINESS_MAX_REASON_LENGTH = 300;
/** Most usage windows one agent lists. */
export const FLEET_AGENT_READINESS_MAX_USAGE_WINDOWS = 6;
/** Cap on a usage window's name (`five_hour`). */
export const FLEET_AGENT_READINESS_MAX_WINDOW_LENGTH = 32;
/** When a failure names no reset time, it is trusted for this long (the usage-limit fallback). */
export const FLEET_AGENT_FAILURE_FALLBACK_MS = 60 * 60 * 1000;
/**
 * A stored report this much older than the node's last accepted heartbeat is
 * no longer the node's word: the node kept beating WITHOUT reporting (it was
 * downgraded to a version older than the field, or its probe stopped
 * answering). Served as "never reported" — unknown — rather than as last
 * week's `ready`.
 */
export const FLEET_AGENT_READINESS_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * One usage window of a seat — a subscription's rolling 5-hour or weekly
 * allowance, or a rate-limit snapshot.
 *
 * `window` is a short token: `five_hour`, `weekly`, `weekly_opus`,
 * `weekly_sonnet`, `overage`, or `primary` / `secondary` when the CLI named
 * only the slot. A wire `string`, so a window this build has never heard of
 * still renders (by its token) instead of being dropped.
 */
export interface FleetAgentUsageWindow {
	window: string;
	/** How much of the window is used, 0-100, or null when the CLI gave no figure. */
	usedPercent: number | null;
	/** ISO instant the window resets, or null when the CLI named none. */
	resetsAt: string | null;
	/** True when the CLI said this window is exhausted. */
	limited?: boolean;
}

/** One agent CLI on a node. */
export interface FleetAgentReadinessEntry {
	/** The CLI: `claude-code`, `codex`, `gemini`, `opencode`. */
	provider: string;
	installed: boolean;
	/** The CLI's version, or null when it is not installed or did not answer. */
	version: string | null;
	/** True = signed in, false = not, null = the node could not tell. */
	signedIn: boolean | null;
	authMethod: FleetAgentAuthMethod;
	/**
	 * Who the CLI is signed in as — a display label the CLI itself prints
	 * (`user@example.com (Acme, max)`), or null. NEVER a token or a key.
	 */
	account: string | null;
	status: FleetAgentReadinessStatus;
	/** Why, in one short sentence (usually the CLI's own), or null. */
	reason: string | null;
	/** ISO instant the node last checked this CLI (the node's clock). */
	checkedAt: string;
	/** ISO instant a `limit_reached` status is expected to lift, or null. */
	limitResetsAt?: string | null;
	/** Usage windows last observed, when a run or its record carried them. */
	usage?: FleetAgentUsageWindow[];
	/** ISO instant those windows were observed. */
	usageObservedAt?: string | null;
	/** ISO instant of the last run on this node that this CLI finished successfully. */
	lastSuccessAt?: string | null;
	/** ISO instant of the last run this CLI failed for a reason classified above. */
	lastFailureAt?: string | null;
}

/** The heartbeat's `agents` field: every agent CLI the node knows about. */
export interface FleetAgentReadinessReport {
	/** ISO instant the report was assembled (the node's clock). */
	checkedAt: string;
	agents: FleetAgentReadinessEntry[];
}

/** The report as the platform stores it: stamped with the platform's RECEIPT time. */
export interface FleetAgentReadinessStored extends FleetAgentReadinessReport {
	/** ISO instant the platform received the beat that carried it. */
	at: string;
}

/** The report as a node view serves it, with the node-level answer. */
export interface FleetNodeAgentReadinessView extends FleetAgentReadinessStored {
	/** True when at least one agent on this node can work now. */
	anyReady: boolean;
}

/**
 * What the platform's own run records say about a node (agent-task jobs that
 * reached a terminal status in the window).
 */
export interface FleetNodeRunWindowStats {
	/** Jobs that finished (succeeded or failed) in the window. */
	runs: number;
	/** Of those, how many failed. */
	failed: number;
	/** Model spend the node reported for them, in cents (0 when none was reported). */
	costCents: number;
}

/** `runStats` on a node view: the last 24 hours and the last 7 days. */
export interface FleetNodeRunStats {
	last24h: FleetNodeRunWindowStats;
	last7d: FleetNodeRunWindowStats;
}

// ─── Failure classification ─────────────────────────────────────────────────

/** The statuses a failed run can prove. */
export type FleetAgentFailureKind = 'not_signed_in' | 'access_denied' | 'limit_reached';

export interface FleetAgentFailure {
	kind: FleetAgentFailureKind;
	/** The CLI's own sentence: one line, bounded, credentials masked. */
	reason: string;
	/** ISO instant the CLI said the limit resets, or null. `limit_reached` only. */
	resetsAt: string | null;
	/**
	 * ISO instant after which a `limit_reached` verdict is no longer trusted
	 * (the reset plus slack, or the fallback). Null for the other kinds, which
	 * stay until a run succeeds or the sign-in changes.
	 */
	until: string | null;
	/**
	 * True when this is the usage limit {@link detectFleetModelUsageLimit}
	 * recognises — the one the worker also throttles on, and an owner can
	 * clear from Fleet.
	 */
	usageLimit: boolean;
}

export interface ClassifyFleetAgentFailureOptions {
	/** The CLI whose output this is. Defaults to `claude-code`. */
	provider?: string;
	/** "Now", for resolving a wall-clock reset and the fallback. */
	now?: Date | number;
	/** IANA zone a reset time with no zone of its own is read in (the node passes its own). */
	timeZone?: string;
	/**
	 * Only the unambiguous phrases. Used for a CLI's raw output tail, which
	 * can contain the MODEL's own words: a Task about login pages must never
	 * read as the CLI being signed out.
	 */
	strict?: boolean;
}

interface FailureSignature {
	pattern: RegExp;
	/** Recognised in `strict` mode too. */
	strict: boolean;
}

/**
 * "Signed in, but not allowed" — the CLIs' own words.
 *
 * Claude Code: `Your organization has disabled Claude subscription access for
 * Claude Code · Use an Anthropic API key instead, or ask your admin to enable
 * access`; the API's `permission_error` / `API Error: 403`.
 * Codex: `unexpected status 403 Forbidden: …`.
 */
const ACCESS_DENIED_SIGNATURES: readonly FailureSignature[] = [
	{ pattern: /\borganization has disabled\b[^\n]{0,80}\baccess\b/i, strict: true },
	{ pattern: /\bpermission_error\b/, strict: true },
	{ pattern: /\bAPI Error:? 403\b/i, strict: true },
	{ pattern: /\bunexpected status 403\b/i, strict: true },
	{ pattern: /\b(?:does not|doesn't|do not|don't) have (?:access|permission) to\b/i, strict: false },
	{ pattern: /\baccess (?:has been |was |is )?(?:denied|disabled|revoked)\b/i, strict: false }
];

/**
 * "No usable credential" — the CLIs' own words.
 *
 * Claude Code: `Not logged in · Please run /login`, `Login expired · Please
 * run /login`, `OAuth token revoked · Please run /login`, `Failed to
 * authenticate: OAuth session expired and could not be refreshed`, `Please
 * run /login · API Error: 401 OAuth token has expired …`, `Invalid API key ·
 * Fix external API key`, the API's `authentication_error`.
 * Codex: `Not logged in`, `Your access token could not be refreshed because
 * your refresh token has expired. Please log out and sign in again.` (and its
 * `was revoked` / `was already used` siblings), `unexpected status 401
 * Unauthorized: …`.
 */
const NOT_SIGNED_IN_SIGNATURES: readonly FailureSignature[] = [
	{ pattern: /\bplease run \/login\b/i, strict: true },
	{ pattern: /\bnot logged in\b/i, strict: true },
	{ pattern: /\blogin expired\b/i, strict: true },
	{ pattern: /\bOAuth (?:session|token) (?:has )?(?:expired|revoked)\b/i, strict: true },
	{ pattern: /\bfailed to authenticate\b/i, strict: true },
	{ pattern: /\binvalid api key\b/i, strict: true },
	{ pattern: /\binvalid authentication credentials\b/i, strict: true },
	{ pattern: /\bauthentication_error\b/, strict: true },
	{ pattern: /\bAPI Error:? 401\b/i, strict: true },
	{ pattern: /\bunexpected status 401\b/i, strict: true },
	{
		pattern: /\b(?:access|refresh) token (?:could not be refreshed|has expired|was revoked|was already used)\b/i,
		strict: true
	},
	{ pattern: /\bsign in again\b/i, strict: false }
];

/**
 * "Out of credit" — a limit with no reset the CLI can name. Kept apart from
 * {@link detectFleetModelUsageLimit}'s signatures on purpose: those park the
 * job and throttle the node, and a prepaid balance does not come back by
 * waiting.
 *
 * Claude Code: `Credit balance is too low`. Codex: `Quota exceeded. Check
 * your plan and billing details.`, the API's `insufficient_quota`.
 */
const OUT_OF_CREDIT_SIGNATURES: readonly FailureSignature[] = [
	{ pattern: /\bcredit balance is too low\b/i, strict: true },
	{ pattern: /\bquota exceeded\b/i, strict: true },
	{ pattern: /\binsufficient_quota\b/, strict: true }
];

/**
 * Classify why a model CLI's run failed, from the CLI's own text, or null
 * when the text names none of the three conditions.
 *
 * Deliberately narrow, like {@link detectFleetModelUsageLimit}: a false
 * positive marks a working agent "Not signed in", so only the CLIs' own
 * phrases match, and `strict` narrows them further for raw output. A usage
 * limit is read first (with its reset time), then "not allowed", then "no
 * credential", then "out of credit".
 *
 * Pure: the same text and options always give the same answer.
 */
export function classifyFleetAgentFailure(
	text: unknown,
	options: ClassifyFleetAgentFailureOptions = {}
): FleetAgentFailure | null {
	if (typeof text !== 'string' || !text.trim()) return null;
	const strict = options.strict === true;
	const nowMs = toEpochMs(options.now);

	const limit = detectFleetModelUsageLimit(text, {
		...(options.provider ? { provider: options.provider } : {}),
		now: nowMs,
		strict,
		...(options.timeZone ? { timeZone: options.timeZone } : {})
	});
	if (limit) {
		return {
			kind: 'limit_reached',
			reason: sanitizeFleetAgentReason(limit.message) ?? 'usage limit reached',
			resetsAt: limit.resetsAt,
			until: limit.retryAfter,
			usageLimit: true
		};
	}

	const matched = (signatures: readonly FailureSignature[]): RegExp | null =>
		signatures.find((signature) => (!strict || signature.strict) && signature.pattern.test(text))?.pattern ?? null;

	const denied = matched(ACCESS_DENIED_SIGNATURES);
	if (denied) {
		return {
			kind: 'access_denied',
			reason: matchedSentence(text, denied) ?? 'access denied',
			resetsAt: null,
			until: null,
			usageLimit: false
		};
	}
	const signedOut = matched(NOT_SIGNED_IN_SIGNATURES);
	if (signedOut) {
		return {
			kind: 'not_signed_in',
			reason: matchedSentence(text, signedOut) ?? 'not signed in',
			resetsAt: null,
			until: null,
			usageLimit: false
		};
	}
	const credit = matched(OUT_OF_CREDIT_SIGNATURES);
	if (credit) {
		return {
			kind: 'limit_reached',
			reason: matchedSentence(text, credit) ?? 'out of credit',
			resetsAt: null,
			until: new Date(nowMs + FLEET_AGENT_FAILURE_FALLBACK_MS).toISOString(),
			usageLimit: false
		};
	}
	return null;
}

// ─── Sanitising ─────────────────────────────────────────────────────────────

/**
 * Credential-shaped runs of text, masked wherever a reason or an account
 * label is built or stored. The report never needs one, and a CLI that one
 * day prints a key inside an error sentence must not turn a status line into
 * a leak: API keys (`sk-…`, `sk-ant-…`), bearer values, JSON Web Tokens, and
 * any unbroken run of 32 or more key-alphabet characters.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g,
	/[A-Za-z0-9_-]{32,}/g
];

/** `text` with anything credential-shaped replaced by `[redacted]`. */
export function redactFleetAgentText(text: string): string {
	let out = text;
	for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, '[redacted]');
	return out;
}

function oneLine(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	// eslint-disable-next-line no-control-regex
	const cleaned = redactFleetAgentText(value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ')).trim();
	if (!cleaned) return null;
	const points = Array.from(cleaned);
	return points.length > max
		? `${points
				.slice(0, max - 1)
				.join('')
				.trimEnd()}…`
		: cleaned;
}

/** A reason as the report carries it: one line, credentials masked, bounded; null when empty. */
export function sanitizeFleetAgentReason(value: unknown): string | null {
	return oneLine(value, FLEET_AGENT_READINESS_MAX_REASON_LENGTH);
}

/** An account label as the report carries it: one line, credentials masked, bounded; null when empty. */
export function sanitizeFleetAgentAccount(value: unknown): string | null {
	return oneLine(value, FLEET_AGENT_READINESS_MAX_ACCOUNT_LENGTH);
}

function isoOrNull(value: unknown): string | null {
	if (typeof value !== 'string' || !value || value.length > 64) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function token(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return /^[A-Za-z0-9._:+-]+$/.test(trimmed) && trimmed.length <= max ? trimmed : null;
}

function sanitizeUsageWindow(raw: unknown): FleetAgentUsageWindow | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;
	const window = token(source.window, FLEET_AGENT_READINESS_MAX_WINDOW_LENGTH);
	if (!window) return null;
	const used =
		typeof source.usedPercent === 'number' &&
		Number.isFinite(source.usedPercent) &&
		source.usedPercent >= 0 &&
		source.usedPercent <= 100
			? Math.round(source.usedPercent * 10) / 10
			: null;
	const out: FleetAgentUsageWindow = { window, usedPercent: used, resetsAt: isoOrNull(source.resetsAt) };
	if (source.limited === true) out.limited = true;
	// A window with neither a figure, a reset nor a verdict says nothing.
	return out.usedPercent === null && out.resetsAt === null && !out.limited ? null : out;
}

function sanitizeEntry(raw: unknown, fallbackCheckedAt: string): FleetAgentReadinessEntry | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;
	const provider = token(source.provider, FLEET_AGENT_READINESS_MAX_PROVIDER_LENGTH);
	if (!provider) return null;
	const status = (FLEET_AGENT_READINESS_STATUSES as readonly unknown[]).includes(source.status)
		? (source.status as FleetAgentReadinessStatus)
		: 'unknown';
	const entry: FleetAgentReadinessEntry = {
		provider,
		installed: source.installed === true,
		version: oneLine(source.version, FLEET_AGENT_READINESS_MAX_VERSION_LENGTH),
		signedIn: typeof source.signedIn === 'boolean' ? source.signedIn : null,
		authMethod: (FLEET_AGENT_AUTH_METHODS as readonly unknown[]).includes(source.authMethod)
			? (source.authMethod as FleetAgentAuthMethod)
			: 'unknown',
		account: sanitizeFleetAgentAccount(source.account),
		status,
		reason: sanitizeFleetAgentReason(source.reason),
		checkedAt: isoOrNull(source.checkedAt) ?? fallbackCheckedAt
	};
	const limitResetsAt = isoOrNull(source.limitResetsAt);
	if (limitResetsAt) entry.limitResetsAt = limitResetsAt;
	if (Array.isArray(source.usage)) {
		const usage = source.usage
			.slice(0, FLEET_AGENT_READINESS_MAX_USAGE_WINDOWS)
			.map(sanitizeUsageWindow)
			.filter((window): window is FleetAgentUsageWindow => window !== null);
		if (usage.length > 0) {
			entry.usage = usage;
			const observedAt = isoOrNull(source.usageObservedAt);
			if (observedAt) entry.usageObservedAt = observedAt;
		}
	}
	const lastSuccessAt = isoOrNull(source.lastSuccessAt);
	if (lastSuccessAt) entry.lastSuccessAt = lastSuccessAt;
	const lastFailureAt = isoOrNull(source.lastFailureAt);
	if (lastFailureAt) entry.lastFailureAt = lastFailureAt;
	return entry;
}

/**
 * Keep only the report fields this build knows, each within its bounds.
 *
 * Used at BOTH ends, like `sanitizeFleetNodeHealthSnapshot`: the node runs it
 * before sending, the platform on receipt (and again when it serves a stored
 * value). An unknown status reads `unknown`, an unknown auth method
 * `unknown`; an entry without a usable provider is dropped; one entry per
 * provider (the first wins). Free text is cut to one bounded line with
 * anything credential-shaped masked.
 *
 * Returns null when `raw` is not a report at all (no `agents` list), so
 * "said nothing" stays distinct from an EMPTY list, which is a real report:
 * "this machine has no agent CLI".
 *
 * Pure: the same input always gives the same output (no clock is read).
 */
export function normalizeFleetAgentReadinessReport(
	raw: unknown,
	/** Used when the report (or an entry) carries no usable `checkedAt` — the platform passes its receipt time. */
	fallbackCheckedAt?: string
): FleetAgentReadinessReport | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const source = raw as Record<string, unknown>;
	if (!Array.isArray(source.agents)) return null;
	const checkedAt = isoOrNull(source.checkedAt) ?? isoOrNull(fallbackCheckedAt) ?? new Date(0).toISOString();
	const seen = new Set<string>();
	const agents: FleetAgentReadinessEntry[] = [];
	for (const candidate of source.agents) {
		if (agents.length >= FLEET_AGENT_READINESS_MAX_AGENTS) break;
		const entry = sanitizeEntry(candidate, checkedAt);
		if (!entry || seen.has(entry.provider)) continue;
		seen.add(entry.provider);
		agents.push(entry);
	}
	return { checkedAt, agents };
}

// ─── The node-level answer ──────────────────────────────────────────────────

/** True when this agent can take work: installed and `ready`. */
export function isFleetAgentReady(entry: Pick<FleetAgentReadinessEntry, 'installed' | 'status'>): boolean {
	return entry.installed === true && entry.status === 'ready';
}

/**
 * True when at least one agent of a report can work now.
 *
 * An empty report is `false` (no agent CLI at all) — the answer for a node
 * that never reported is not this function's to give: the caller holds a
 * null report and says "unknown".
 */
export function anyFleetAgentReady(agents: readonly Pick<FleetAgentReadinessEntry, 'installed' | 'status'>[]): boolean {
	return agents.some(isFleetAgentReady);
}

export interface ResolveFleetNodeAgentReadinessOptions {
	/**
	 * The platform's own active throttles for the node (`modelThrottles`): a
	 * CLI the platform is holding work back from is not ready, whatever the
	 * node last said — the node's report can be a beat behind a limit the
	 * platform learned from a job result.
	 */
	throttles?: readonly FleetNodeModelThrottleView[] | null;
	/**
	 * When the node's last heartbeat was accepted. A report older than it by
	 * more than {@link FLEET_AGENT_READINESS_STALE_AFTER_MS} is not served: the
	 * node has been beating without one. Absent: the report is served as is.
	 */
	lastHeartbeatAt?: string | Date | null;
}

/**
 * The stored report as a node view serves it, or null when the row holds
 * none (a daemon older than the field) or junk.
 *
 * Re-normalised on the way out, so a value written by an older or newer
 * build is served in THIS build's shape. An agent the node called `ready`
 * that the platform is throttling reads `limit_reached` until the throttle's
 * own instant. A report the node stopped refreshing while it kept beating is
 * not served at all (see `lastHeartbeatAt`).
 */
export function resolveFleetNodeAgentReadiness(
	stored: unknown,
	options: ResolveFleetNodeAgentReadinessOptions = {}
): FleetNodeAgentReadinessView | null {
	const report = normalizeFleetAgentReadinessReport(stored);
	if (!report) return null;
	const at = isoOrNull((stored as { at?: unknown }).at);
	if (!at) return null;
	const lastBeat =
		options.lastHeartbeatAt instanceof Date
			? options.lastHeartbeatAt.getTime()
			: typeof options.lastHeartbeatAt === 'string'
				? Date.parse(options.lastHeartbeatAt)
				: Number.NaN;
	if (Number.isFinite(lastBeat) && lastBeat - Date.parse(at) > FLEET_AGENT_READINESS_STALE_AFTER_MS) return null;
	const throttles = new Map<string, FleetNodeModelThrottleView>();
	for (const throttle of options.throttles ?? []) {
		if (throttle && typeof throttle.provider === 'string') throttles.set(throttle.provider, throttle);
	}
	const agents = report.agents.map((entry): FleetAgentReadinessEntry => {
		const throttle = throttles.get(entry.provider);
		if (!throttle || entry.status !== 'ready') return entry;
		return {
			...entry,
			status: 'limit_reached',
			reason: sanitizeFleetAgentReason(throttle.reason) ?? entry.reason,
			limitResetsAt: isoOrNull(throttle.until) ?? entry.limitResetsAt ?? null
		};
	});
	return { at, checkedAt: report.checkedAt, agents, anyReady: anyFleetAgentReady(agents) };
}

/** A zeroed window, for a node the run records say nothing about. */
export function emptyFleetNodeRunStats(): FleetNodeRunStats {
	return {
		last24h: { runs: 0, failed: 0, costCents: 0 },
		last7d: { runs: 0, failed: 0, costCents: 0 }
	};
}

// ─── internals ──────────────────────────────────────────────────────────────

function toEpochMs(value: Date | number | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	return Date.now();
}

/** The line that matched (the CLI's sentence), not the whole output. */
function matchedSentence(text: string, pattern: RegExp): string | null {
	const line = text.split(/\r?\n/).find((candidate) => pattern.test(candidate));
	return sanitizeFleetAgentReason(line ?? text);
}
