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
 *    failure classified from what the CLI ITSELF reported
 *    ({@link classifyFleetAgentFailure});
 *  - usage windows when a real run (or a record it left) carried them.
 *
 * Three rules hold the whole thing together:
 *
 *  1. **No probe starts a model call.**
 *  2. **A verdict comes only from text the CLI authored** — its error result,
 *     its error events, its stderr. Never from what the model wrote: a Task
 *     about login pages must not sign the CLI out.
 *  3. **No line of run output leaves the node.** A verdict travels as a
 *     reason CODE ({@link FLEET_AGENT_REASON_CODES}); the sentence a person
 *     reads is chosen from a fixed table by that code. The report never
 *     carries free text out of a run.
 *
 * A status the node cannot prove is `unknown`, never `ready` — and at the
 * node level "could not be determined" is its own answer (`null`), never
 * "no agent can work".
 *
 * Shared by the node (which builds the report), the API (which stores it and
 * derives the node-level answer) and the web tier (which renders it).
 * Dependency-free, like the rest of this package.
 */

import {
	describeFleetModelUsageLimitWindow,
	detectFleetModelUsageLimit,
	type FleetModelUsageLimitWindow,
	type FleetNodeModelThrottleView
} from './fleet-model-usage-limit.types.js';

/**
 * Whether one agent CLI can take work:
 * - `ready`         — installed, signed in, and nothing the last runs said contradicts it;
 * - `not_signed_in` — no credential, or the CLI said its session expired / was revoked / is invalid;
 * - `access_denied` — signed in, but the account may not use the CLI (organization policy, a 403);
 * - `limit_reached` — out of quota or credit;
 * - `not_installed` — the node has no such CLI, for certain;
 * - `unsupported`   — installed, but this node version cannot run agent work with it;
 * - `unknown`       — the node could not tell.
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
/** Most usage windows one agent lists. */
export const FLEET_AGENT_READINESS_MAX_USAGE_WINDOWS = 6;
/** Cap on a usage window's name (`five_hour`). */
export const FLEET_AGENT_READINESS_MAX_WINDOW_LENGTH = 32;
/**
 * When a usage limit names no reset time, it is held for this long (the
 * usage-limit fallback). Also how long an "out of credit" verdict is shown as
 * the status: nothing says when a balance is topped up, so after this long
 * with no newer run it reads `unknown` — never `ready`.
 */
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
 * How long a refusal a run proved is shown as the agent's status. After this
 * long with no newer run the node no longer knows: the status becomes
 * `unknown` and the last failure is kept beside it, instead of the agent
 * reading "Access denied" for ever on the strength of one old run.
 */
export const FLEET_AGENT_VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The length assumed for a usage window that names neither a reset nor its own length. */
export const FLEET_AGENT_USAGE_DEFAULT_WINDOW_MINUTES = 300;

// ─── Reasons ────────────────────────────────────────────────────────────────

/**
 * Why an agent has the status it has — a CODE, never a sentence out of a run.
 *
 * - `org_access_disabled` — the organization switched subscription access off for the CLI;
 * - `permission_denied`   — the API refused the account (403 / permission error);
 * - `not_logged_in`       — a run found the CLI signed out;
 * - `session_expired`     — the sign-in session expired, was revoked or could not be refreshed;
 * - `invalid_api_key`     — the API key was rejected;
 * - `unauthorized`        — the API rejected the credential (401);
 * - `usage_limit`         — a usage or rate limit (see the entry's `limitWindow` / `limitResetsAt`);
 * - `out_of_credit`       — the balance or quota is exhausted;
 * - `status_signed_out`   — the CLI's status command says it is not signed in;
 * - `status_unanswered`   — the CLI's status command did not answer;
 * - `status_unavailable`  — this CLI version has no status command the node may run;
 * - `probe_timed_out`     — the startup lookup for the CLI timed out (a busy machine, not a missing CLI);
 * - `cli_too_old`         — the CLI lacks options this node needs;
 * - `no_executor`         — this node version cannot run agent work with this CLI;
 * - `verdict_stale`       — the last run was refused, too long ago (or with too little said) to still call it the status.
 */
export const FLEET_AGENT_REASON_CODES = [
	'org_access_disabled',
	'permission_denied',
	'not_logged_in',
	'session_expired',
	'invalid_api_key',
	'unauthorized',
	'usage_limit',
	'out_of_credit',
	'status_signed_out',
	'status_unanswered',
	'status_unavailable',
	'probe_timed_out',
	'cli_too_old',
	'no_executor',
	'verdict_stale'
] as const;

export type FleetAgentReasonCode = (typeof FLEET_AGENT_REASON_CODES)[number];

export function isFleetAgentReasonCode(value: unknown): value is FleetAgentReasonCode {
	return typeof value === 'string' && (FLEET_AGENT_REASON_CODES as readonly string[]).includes(value);
}

const USAGE_LIMIT_WINDOWS: readonly FleetModelUsageLimitWindow[] = ['weekly', 'session', 'daily', 'rate', 'usage'];

const REASON_SENTENCES: Readonly<Record<Exclude<FleetAgentReasonCode, 'usage_limit'>, string>> = {
	org_access_disabled:
		'The organization has disabled subscription access for this CLI. Use an API key, or ask an admin to enable access.',
	permission_denied: 'The API refused this account (403). It may not use this CLI or model.',
	not_logged_in: 'The CLI is not signed in. Sign in on this computer.',
	session_expired: 'The sign-in session expired or was revoked. Sign in again on this computer.',
	invalid_api_key: 'The API key was rejected. Replace it on this computer.',
	unauthorized: 'The API rejected the credential (401). Sign in again on this computer.',
	out_of_credit: 'The credit balance or quota is exhausted. Add credit, or use another seat.',
	status_signed_out: 'The CLI is not signed in on this computer.',
	status_unanswered: 'The CLI did not answer its status command.',
	status_unavailable: 'This CLI version cannot report its sign-in state. Update the CLI.',
	probe_timed_out: 'The startup lookup for this CLI timed out. Restart the node when the computer is less busy.',
	cli_too_old: 'This CLI version is too old for this node. Update the CLI.',
	no_executor: 'This node version cannot run agent work with this CLI.',
	verdict_stale: 'The last run was refused and none has run since, so the current state is not known.'
};

/**
 * The sentence for a reason code — the ONLY way a reason becomes text. The
 * table is fixed; the one variable part, the window of a usage limit, is a
 * token of a closed set. Null for a code this build does not know.
 */
export function describeFleetAgentReason(
	code: unknown,
	details: { window?: FleetModelUsageLimitWindow | null } = {}
): string | null {
	if (!isFleetAgentReasonCode(code)) return null;
	if (code === 'usage_limit') {
		const window = USAGE_LIMIT_WINDOWS.includes(details.window as FleetModelUsageLimitWindow)
			? (details.window as FleetModelUsageLimitWindow)
			: 'usage';
		const label = describeFleetModelUsageLimitWindow(window);
		return `The ${label} is reached.`;
	}
	return REASON_SENTENCES[code];
}

// ─── The report ─────────────────────────────────────────────────────────────

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
	/** The window's own length in minutes, when the CLI stated it. */
	windowMinutes?: number;
}

/** One agent CLI on a node. */
export interface FleetAgentReadinessEntry {
	/** The CLI: `claude-code`, `codex`, `gemini`, `opencode`. */
	provider: string;
	/** True = installed, false = not installed for certain, null = the node could not tell. */
	installed: boolean | null;
	/** The CLI's version, or null when it is not installed or did not answer. */
	version: string | null;
	/** True = signed in, false = not, null = the node could not tell. */
	signedIn: boolean | null;
	authMethod: FleetAgentAuthMethod;
	/**
	 * Who the CLI is signed in as — a display label the CLI's own status
	 * command prints (`user@example.com (Acme, max)`), or null. NEVER a token
	 * or a key, and never text out of a run.
	 */
	account: string | null;
	status: FleetAgentReadinessStatus;
	/** Why — a {@link FleetAgentReasonCode}, or null when there is nothing to explain. */
	reasonCode: string | null;
	/**
	 * The sentence for {@link reasonCode}, from {@link describeFleetAgentReason}.
	 * Derived on every read and write; whatever a node puts here is ignored.
	 */
	reason: string | null;
	/** ISO instant the node last checked this CLI (the node's clock). */
	checkedAt: string;
	/** ISO instant a `limit_reached` status is expected to lift, or null. */
	limitResetsAt?: string | null;
	/** Which window ran out, for a usage limit. */
	limitWindow?: FleetModelUsageLimitWindow;
	/** Usage windows last observed, when a run or its record carried them. */
	usage?: FleetAgentUsageWindow[];
	/** ISO instant those windows were observed. */
	usageObservedAt?: string | null;
	/** ISO instant of the last run on this node that this CLI finished successfully. */
	lastSuccessAt?: string | null;
	/** ISO instant of the last run this CLI refused for a classified reason. */
	lastFailureAt?: string | null;
	/** What that run proved, kept when the status has since aged to `unknown`. */
	lastFailureKind?: FleetAgentFailureKind;
	/** The reason code of that run. */
	lastFailureCode?: string;
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
	/**
	 * `true` when at least one agent on this node can work now; `false` only
	 * when every agent has a definite negative verdict; `null` when it could
	 * not be determined (an agent's state is unknown and none is ready).
	 */
	anyReady: boolean | null;
}

/**
 * What the platform's own run records say about a node over one window:
 * agent-task jobs that finished, judged by the outcome of the RUN each
 * carried — a job the node reports `done` whose run failed is a failure.
 */
export interface FleetNodeRunWindowStats {
	/** Jobs that finished in the window. */
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
	/** True when the node finished more jobs in 7 days than one read counts: the figures are a floor. */
	capped?: boolean;
}

// ─── Failure classification ─────────────────────────────────────────────────

/** The statuses a failed run can prove. */
export type FleetAgentFailureKind = 'not_signed_in' | 'access_denied' | 'limit_reached';

const FAILURE_KINDS: readonly FleetAgentFailureKind[] = ['not_signed_in', 'access_denied', 'limit_reached'];

/**
 * What a model CLI ITSELF reported about a failed run. Every field comes
 * from a channel only the CLI writes to:
 *
 *  - Claude Code: the `result` / `errors` of a result envelope whose
 *    `is_error` is true (the text behind "claude-code reported an error: …"),
 *    its `api_error_status`, the `error` class on an assistant event, and
 *    the process's stderr;
 *  - Codex: the `message` of `error` and `turn.failed` events and of `error`
 *    items, and the process's stderr.
 *
 * NEVER an assistant message, a Codex `agent_message`, reasoning, or a
 * tool's output: those are the model's words, and a Task about sign-in
 * pages or rate limiters would be read as the CLI's own state.
 */
export interface FleetAgentCliError {
	text?: string | null;
	/** HTTP status of the failing API call, when the CLI reported one. */
	apiStatus?: number | null;
	/** The CLI's own error class (`authentication_failed`, `billing_error`, `rate_limit`, …). */
	errorClass?: string | null;
}

export interface FleetAgentFailure {
	kind: FleetAgentFailureKind;
	code: FleetAgentReasonCode;
	/** Which window ran out, for a usage limit; null otherwise. */
	window: FleetModelUsageLimitWindow | null;
	/** ISO instant the CLI said the limit resets, or null. A usage limit only. */
	resetsAt: string | null;
	/**
	 * ISO instant a usage limit is held until (the reset plus slack, or the
	 * fallback hour). Null for every other verdict, which ages instead: a
	 * sign-in or access verdict by {@link FLEET_AGENT_VERDICT_MAX_AGE_MS}, an
	 * empty credit balance by {@link FLEET_AGENT_FAILURE_FALLBACK_MS}.
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
	/** The CLI whose error this is. Defaults to `claude-code`. */
	provider?: string;
	/** "Now", for resolving a wall-clock reset and the fallback. */
	now?: Date | number;
	/** IANA zone a reset time with no zone of its own is read in (the node passes its own). */
	timeZone?: string;
	/**
	 * The run produced model output: the CLI demonstrably reached its model,
	 * so it was signed in and allowed. `not_signed_in` and `access_denied`
	 * are then never answered, whatever the text says. A limit can still be
	 * hit in the middle of a run.
	 */
	modelReached?: boolean;
}

interface CodedSignature {
	pattern: RegExp;
	code: FleetAgentReasonCode;
}

/**
 * "Signed in, but not allowed" — the CLIs' own words.
 *
 * Claude Code: `Your organization has disabled Claude subscription access for
 * Claude Code · Use an Anthropic API key instead, or ask your admin to enable
 * access`; the API's `permission_error` / `API Error: 403`.
 * Codex: `unexpected status 403 Forbidden: …`.
 */
const ACCESS_DENIED_SIGNATURES: readonly CodedSignature[] = [
	{ pattern: /\borganization has disabled\b[^\n]{0,80}\baccess\b/i, code: 'org_access_disabled' },
	{ pattern: /\bpermission_error\b/, code: 'permission_denied' },
	{ pattern: /\bAPI Error:? 403\b/i, code: 'permission_denied' },
	{ pattern: /\bunexpected status 403\b/i, code: 'permission_denied' }
];

/**
 * "No usable credential" — the CLIs' own words. Order matters: the more
 * specific reason is listed first.
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
const NOT_SIGNED_IN_SIGNATURES: readonly CodedSignature[] = [
	{ pattern: /\binvalid api key\b/i, code: 'invalid_api_key' },
	{ pattern: /\blogin expired\b/i, code: 'session_expired' },
	{ pattern: /\bOAuth (?:session|token) (?:has )?(?:expired|revoked)\b/i, code: 'session_expired' },
	{
		pattern: /\b(?:access|refresh) token (?:could not be refreshed|has expired|was revoked|was already used)\b/i,
		code: 'session_expired'
	},
	{ pattern: /\bnot logged in\b/i, code: 'not_logged_in' },
	{ pattern: /\bplease run \/login\b/i, code: 'not_logged_in' },
	{ pattern: /\bfailed to authenticate\b/i, code: 'unauthorized' },
	{ pattern: /\binvalid authentication credentials\b/i, code: 'unauthorized' },
	{ pattern: /\bauthentication_error\b/, code: 'unauthorized' },
	{ pattern: /\bAPI Error:? 401\b/i, code: 'unauthorized' },
	{ pattern: /\bunexpected status 401\b/i, code: 'unauthorized' }
];

/**
 * "Out of credit" — a limit no clock lifts. Kept apart from
 * {@link detectFleetModelUsageLimit}'s signatures on purpose: those park the
 * job and throttle the node until a reset, and a prepaid balance does not
 * come back by waiting.
 *
 * Claude Code: `Credit balance is too low`. Codex: `Quota exceeded. Check
 * your plan and billing details.`, the API's `insufficient_quota`.
 */
const OUT_OF_CREDIT_SIGNATURES: readonly RegExp[] = [
	/\bcredit balance is too low\b/i,
	/\bquota exceeded\b/i,
	/\binsufficient_quota\b/
];

/**
 * Classify why a model CLI's run failed, from what the CLI ITSELF reported
 * ({@link FleetAgentCliError}), or null when it names none of the three
 * conditions.
 *
 * The caller is responsible for the one thing this function cannot check:
 * that `error` holds only CLI-authored text. Given that, it is deliberately
 * narrow — a false positive marks a working agent "Not signed in" — and in
 * this order: a usage limit (with its reset), then "not allowed", then "no
 * credential", then "out of credit". A run that reached its model
 * (`modelReached`) can prove a limit, never a missing or refused sign-in.
 *
 * The answer carries a reason CODE and the structured facts it parsed (the
 * window, the reset instant). It never carries the text it read.
 *
 * Pure: the same input and options always give the same answer.
 */
export function classifyFleetAgentFailure(
	error: FleetAgentCliError | string | null | undefined,
	options: ClassifyFleetAgentFailureOptions = {}
): FleetAgentFailure | null {
	const signal: FleetAgentCliError = typeof error === 'string' ? { text: error } : (error ?? {});
	const text = typeof signal.text === 'string' ? signal.text : '';
	const apiStatus = typeof signal.apiStatus === 'number' ? signal.apiStatus : null;
	const errorClass = typeof signal.errorClass === 'string' ? signal.errorClass : null;
	if (!text.trim() && apiStatus === null && errorClass === null) return null;
	const nowMs = toEpochMs(options.now);

	const limit = text.trim()
		? detectFleetModelUsageLimit(text, {
				...(options.provider ? { provider: options.provider } : {}),
				now: nowMs,
				strict: true,
				...(options.timeZone ? { timeZone: options.timeZone } : {})
			})
		: null;
	if (limit) {
		return {
			kind: 'limit_reached',
			code: 'usage_limit',
			window: limit.window,
			resetsAt: limit.resetsAt,
			until: limit.retryAfter,
			usageLimit: true
		};
	}
	if (apiStatus === 429 || errorClass === 'rate_limit') {
		return {
			kind: 'limit_reached',
			code: 'usage_limit',
			window: 'rate',
			resetsAt: null,
			until: new Date(nowMs + FLEET_AGENT_FAILURE_FALLBACK_MS).toISOString(),
			usageLimit: true
		};
	}

	const verdict = (kind: FleetAgentFailureKind, code: FleetAgentReasonCode): FleetAgentFailure => ({
		kind,
		code,
		window: null,
		resetsAt: null,
		until: null,
		usageLimit: false
	});

	if (options.modelReached !== true) {
		const denied = ACCESS_DENIED_SIGNATURES.find((signature) => signature.pattern.test(text));
		if (denied) return verdict('access_denied', denied.code);
		if (apiStatus === 403) return verdict('access_denied', 'permission_denied');
		const signedOut = NOT_SIGNED_IN_SIGNATURES.find((signature) => signature.pattern.test(text));
		if (signedOut) return verdict('not_signed_in', signedOut.code);
		if (apiStatus === 401 || errorClass === 'authentication_failed')
			return verdict('not_signed_in', 'unauthorized');
	}

	if (errorClass === 'billing_error' || OUT_OF_CREDIT_SIGNATURES.some((pattern) => pattern.test(text))) {
		return verdict('limit_reached', 'out_of_credit');
	}
	return null;
}

// ─── Sanitising ─────────────────────────────────────────────────────────────

/**
 * Credential-shaped runs of text, masked wherever a label is built or
 * stored. Defence in depth: the report carries no run output at all (see the
 * module comment), and the only free text left on it — the account label and
 * the version — comes from a status command's whitelisted fields. Should one
 * of those ever hold more than a label, this is what keeps it from becoming
 * a leak: credentials inside a URL, `Basic` / `Bearer` values, `name=value`
 * pairs whose name says secret, API keys (`sk-…`), JSON Web Tokens, and any
 * unbroken run of 32 or more key-alphabet characters.
 */
const CREDENTIAL_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
	[/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted]'],
	[
		/\b([A-Za-z0-9_.-]*(?:secret|token|passwd|password|credential|key)[A-Za-z0-9_.-]*)\s*[=:]\s*[^\s,;]+/gi,
		'$1=[redacted]'
	],
	[/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, '[redacted]'],
	[/[A-Za-z0-9_+/=-]{32,}/g, '[redacted]']
];

/** `text` with anything credential-shaped replaced by `[redacted]`. */
export function redactFleetAgentText(text: string): string {
	let out = text;
	for (const [pattern, replacement] of CREDENTIAL_REPLACEMENTS) out = out.replace(pattern, replacement);
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

/** A reason code off the wire: a known one, or a short lowercase token a newer node may have invented. */
function reasonCodeOrNull(value: unknown): string | null {
	return typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value) ? value : null;
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
	if (
		typeof source.windowMinutes === 'number' &&
		Number.isInteger(source.windowMinutes) &&
		source.windowMinutes > 0 &&
		source.windowMinutes <= 525_600
	) {
		out.windowMinutes = source.windowMinutes;
	}
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
	const limitWindow = USAGE_LIMIT_WINDOWS.includes(source.limitWindow as FleetModelUsageLimitWindow)
		? (source.limitWindow as FleetModelUsageLimitWindow)
		: null;
	const reasonCode = reasonCodeOrNull(source.reasonCode);
	const entry: FleetAgentReadinessEntry = {
		provider,
		installed: source.installed === true ? true : source.installed === false ? false : null,
		version: oneLine(source.version, FLEET_AGENT_READINESS_MAX_VERSION_LENGTH),
		signedIn: typeof source.signedIn === 'boolean' ? source.signedIn : null,
		authMethod: (FLEET_AGENT_AUTH_METHODS as readonly unknown[]).includes(source.authMethod)
			? (source.authMethod as FleetAgentAuthMethod)
			: 'unknown',
		account: sanitizeFleetAgentAccount(source.account),
		status,
		reasonCode,
		// Never the node's own words: the sentence is looked up by the code, and
		// a code this build does not know has none.
		reason: describeFleetAgentReason(reasonCode, { window: limitWindow }),
		checkedAt: isoOrNull(source.checkedAt) ?? fallbackCheckedAt
	};
	const limitResetsAt = isoOrNull(source.limitResetsAt);
	if (limitResetsAt) entry.limitResetsAt = limitResetsAt;
	if (limitWindow) entry.limitWindow = limitWindow;
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
	if (lastFailureAt) {
		entry.lastFailureAt = lastFailureAt;
		if (FAILURE_KINDS.includes(source.lastFailureKind as FleetAgentFailureKind)) {
			entry.lastFailureKind = source.lastFailureKind as FleetAgentFailureKind;
		}
		const lastFailureCode = reasonCodeOrNull(source.lastFailureCode);
		if (lastFailureCode) entry.lastFailureCode = lastFailureCode;
	}
	return entry;
}

/**
 * Keep only the report fields this build knows, each within its bounds.
 *
 * Used at BOTH ends, like `sanitizeFleetNodeHealthSnapshot`: the node runs it
 * before sending, the platform on receipt (and again when it serves a stored
 * value). An unknown status reads `unknown`, an unknown auth method
 * `unknown`; an entry without a usable provider is dropped; one entry per
 * provider (the first wins).
 *
 * `reason` is REBUILT from `reasonCode` here — whatever text arrived in that
 * field is discarded — so no sentence a node sends is ever stored or served.
 * The account label and the version are cut to one bounded line with
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

// ─── Usage windows ──────────────────────────────────────────────────────────

const KNOWN_WINDOW_MINUTES: Readonly<Record<string, number>> = {
	five_hour: 300,
	weekly: 10_080,
	weekly_opus: 10_080,
	weekly_sonnet: 10_080
};

/**
 * Does a usage reading still describe the seat at `nowMs`?
 *
 * A window that names its reset is current until that instant. One that
 * names none is current for its own length after it was observed (the
 * length the CLI stated, else the one its name implies, else
 * {@link FLEET_AGENT_USAGE_DEFAULT_WINDOW_MINUTES}): after that the
 * allowance it measured has rolled over, and "82% used" is no longer true of
 * anything. A reading that cannot be dated at all is not current.
 */
export function isFleetAgentUsageWindowCurrent(
	window: Pick<FleetAgentUsageWindow, 'window' | 'resetsAt' | 'windowMinutes'>,
	observedAt: string | null | undefined,
	nowMs: number
): boolean {
	const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
	if (Number.isFinite(resetsAt)) return resetsAt > nowMs;
	const observed = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN;
	if (!Number.isFinite(observed)) return false;
	const minutes =
		window.windowMinutes ?? KNOWN_WINDOW_MINUTES[window.window] ?? FLEET_AGENT_USAGE_DEFAULT_WINDOW_MINUTES;
	return nowMs - observed < minutes * 60_000;
}

// ─── The node-level answer ──────────────────────────────────────────────────

/** True when this agent can take work: installed and `ready`. */
export function isFleetAgentReady(entry: Pick<FleetAgentReadinessEntry, 'installed' | 'status'>): boolean {
	return entry.installed === true && entry.status === 'ready';
}

/**
 * True when this agent DEFINITELY cannot take work: not installed for
 * certain, not signed in, access denied, limit reached, or a CLI this node
 * cannot drive. `unknown` is not a negative — it is the absence of an answer.
 */
export function isFleetAgentDefinitelyUnavailable(entry: Pick<FleetAgentReadinessEntry, 'status'>): boolean {
	return (
		entry.status === 'not_installed' ||
		entry.status === 'not_signed_in' ||
		entry.status === 'access_denied' ||
		entry.status === 'limit_reached' ||
		entry.status === 'unsupported'
	);
}

/**
 * Can at least one agent of a report work now? Three answers:
 *
 *  - `true`  — one is `ready`;
 *  - `false` — every agent has a definite negative verdict (an empty report
 *    is this too: the node said it has no agent CLI);
 *  - `null`  — none is ready and at least one could not be judged. Unknown
 *    is never shown as "cannot".
 *
 * The answer for a node that never reported is not this function's to give:
 * the caller holds a null report.
 */
export function anyFleetAgentReady(
	agents: readonly Pick<FleetAgentReadinessEntry, 'installed' | 'status'>[]
): boolean | null {
	if (agents.some(isFleetAgentReady)) return true;
	return agents.every(isFleetAgentDefinitelyUnavailable) ? false : null;
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
	/** "Now", for dropping usage readings that have rolled over. Defaults to the clock. */
	now?: Date | number;
}

/**
 * The stored report as a node view serves it, or null when the row holds
 * none (a daemon older than the field) or junk.
 *
 * Re-normalised on the way out, so a value written by an older or newer
 * build is served in THIS build's shape (and with THIS build's sentences).
 * An agent the node called `ready` that the platform is throttling reads
 * `limit_reached` until the throttle's own instant. A usage reading that has
 * rolled over since the node sent it is dropped. A report the node stopped
 * refreshing while it kept beating is not served at all (see
 * `lastHeartbeatAt`).
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
	const nowMs = toEpochMs(options.now);
	const throttles = new Map<string, FleetNodeModelThrottleView>();
	for (const throttle of options.throttles ?? []) {
		if (throttle && typeof throttle.provider === 'string') throttles.set(throttle.provider, throttle);
	}
	const agents = report.agents.map((entry): FleetAgentReadinessEntry => {
		const next: FleetAgentReadinessEntry = { ...entry };
		if (entry.usage) {
			const usage = entry.usage.filter((window) =>
				isFleetAgentUsageWindowCurrent(window, entry.usageObservedAt, nowMs)
			);
			if (usage.length > 0) {
				next.usage = usage;
			} else {
				delete next.usage;
				delete next.usageObservedAt;
			}
		}
		const throttle = throttles.get(entry.provider);
		if (!throttle || next.status !== 'ready') return next;
		const window = USAGE_LIMIT_WINDOWS.includes(throttle.window) ? throttle.window : 'usage';
		return {
			...next,
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			// The fixed sentence for the window — never the throttle's own text,
			// which is the CLI's line as a run reported it.
			reason: describeFleetAgentReason('usage_limit', { window }),
			limitWindow: window,
			limitResetsAt: isoOrNull(throttle.until) ?? next.limitResetsAt ?? null
		};
	});
	return { at, checkedAt: report.checkedAt, agents, anyReady: anyFleetAgentReady(agents) };
}

/** A zeroed pair of windows, for a node the run records say nothing about. */
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
