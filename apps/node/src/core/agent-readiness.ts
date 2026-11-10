import {
	classifyFleetAgentFailure,
	normalizeFleetAgentReadinessReport,
	sanitizeFleetAgentAccount,
	sanitizeFleetAgentReason,
	type FleetAgentAuthMethod,
	type FleetAgentFailure,
	type FleetAgentReadinessEntry,
	type FleetAgentReadinessReport,
	type FleetAgentReadinessStatus,
	type FleetAgentUsageWindow
} from '@ever-works/contracts';
import type { CommandRunner } from './capabilities';
import { writeStateFile, type ConfigFileSystem, type StateFileSystem } from './config-store';
import type { Logger } from './logger';
import { parseCliVersion } from './telemetry-probe';

/**
 * Fleet agent readiness — can any agent CLI on this machine actually work?
 *
 * A node that is `online` with `claude 2.1.319` installed told its owner
 * nothing about the seat behind the binary: an organization that switched
 * subscription access off, or an OAuth session that expired, failed every
 * run while the popup stayed green. This module is what the heartbeat's
 * `agents` field is built from.
 *
 * ## Sources, and the one hard rule
 *
 * **No probe here ever starts a model call.** Everything comes from:
 *
 *  1. the CLIs' own FREE status commands — `claude auth status --json`
 *     (signed in or not, the method, the account label) and `codex login
 *     status` (signed in or not, the method; Codex never names the account);
 *  2. what REAL runs on this node proved — the last successful run, and the
 *     last failure classified from the CLI's own sentence
 *     (`classifyFleetAgentFailure`, `@ever-works/contracts`);
 *  3. usage windows a real run's own output carried (Claude Code's
 *     `rate_limit_event` lines in its `stream-json` output), or — only under
 *     the owner's `--usage-scan` consent — the rate-limit snapshot Codex
 *     wrote into its newest session record.
 *
 * ## What never leaves the machine
 *
 * The status commands' raw output is never forwarded and never logged:
 * `codex login status` prints a masked API key, and a future CLI version
 * could print more. Only whitelisted fields are read, the account label is
 * the CLI's own display label, and every free-text field goes through the
 * contract's sanitiser, which masks anything credential-shaped. No
 * credential file is ever opened.
 *
 * Everything is injected (the command runner, the clock, the filesystem), so
 * the whole matrix is unit-testable without a CLI on the host.
 */

// ─── Auth state from the CLIs' own status commands ──────────────────────────

/** What one status command said. */
export interface AgentAuthReading {
	/** True = signed in, false = not, null = the output did not say. */
	signedIn: boolean | null;
	method: FleetAgentAuthMethod;
	/** The CLI's own display label for the account, or null. Never a credential. */
	account: string | null;
}

/** How long one status command may run before it is abandoned. */
export const AGENT_AUTH_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long one status reading is reused. A sign-in changes rarely and the
 * command is a full CLI start-up; five minutes keeps a re-login visible
 * within the offline window without spawning the CLI on every beat (the same
 * figure `MODEL_IDENTITY_CACHE_TTL_MS` uses, for the same reason).
 */
export const AGENT_AUTH_CACHE_TTL_MS = 5 * 60_000;

/**
 * A successful run is trusted as proof the agent works for this long, even
 * when the status command says otherwise or does not answer (a run that gets
 * its credential from a per-run grant never shows up in `auth status`).
 */
export const AGENT_SUCCESS_TRUST_MS = 24 * 60 * 60_000;

/**
 * Claude Code's documented `authMethod` values
 * (https://code.claude.com/docs/en/cli-reference, `claude auth status`):
 * `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`,
 * `third_party`. `oauth_token` is the long-lived token `claude setup-token`
 * mints, which needs a subscription — so it reads `subscription`.
 */
const CLAUDE_AUTH_METHODS: Readonly<Record<string, FleetAgentAuthMethod>> = {
	none: 'none',
	'claude.ai': 'subscription',
	oauth_token: 'subscription',
	api_key: 'api_key',
	api_key_helper: 'api_key',
	third_party: 'cloud_provider'
};

/**
 * Read `claude auth status --json`.
 *
 * WHITELISTED fields only — `loggedIn`, `authMethod`, `email`, `orgName`,
 * `subscriptionType` — for the reason `parseClaudeAuthStatus` gives: this is
 * a credential-adjacent document, and a field this function does not name is
 * a field that never reaches the wire. Null when the output is not that
 * document (an older CLI without the command prints a usage error).
 */
export function readClaudeAuthStatus(stdout: string): AgentAuthReading | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(stdout ?? '').trim());
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const status = parsed as Record<string, unknown>;
	const rawMethod = typeof status.authMethod === 'string' ? status.authMethod.trim() : '';
	const signedIn = typeof status.loggedIn === 'boolean' ? status.loggedIn : rawMethod ? rawMethod !== 'none' : null;
	if (signedIn === null) return null;
	if (!signedIn) return { signedIn: false, method: 'none', account: null };
	const email = text(status.email);
	const details = [text(status.orgName), text(status.subscriptionType)].filter(
		(part): part is string => part !== null
	);
	const label = email ? `${email}${details.length > 0 ? ` (${details.join(', ')})` : ''}` : details.join(', ');
	return {
		signedIn: true,
		method: CLAUDE_AUTH_METHODS[rawMethod] ?? 'unknown',
		account: sanitizeFleetAgentAccount(label)
	};
}

/**
 * Read `codex login status`, which prints one line of prose to stderr and
 * exits 0 when signed in, 1 when not (openai/codex,
 * `codex-rs/cli/src/login.rs`): `Logged in using ChatGPT`, `API key
 * configured - <masked>` (older builds: `Logged in using an API key -
 * <masked>`), `Logged in using access token`, `Logged in using personal
 * access token`, `Logged in using workload identity`, `Logged in using Amazon
 * Bedrock …`, `Not logged in`.
 *
 * Only the METHOD is read. The line itself carries a masked key and is never
 * kept; Codex does not name the account, so `account` is always null.
 */
export function readCodexLoginStatus(output: string): AgentAuthReading | null {
	const line = String(output ?? '').toLowerCase();
	if (!line.trim()) return null;
	if (line.includes('not logged in')) return { signedIn: false, method: 'none', account: null };
	const signedIn = (method: FleetAgentAuthMethod): AgentAuthReading => ({ signedIn: true, method, account: null });
	if (line.includes('bedrock')) return signedIn('cloud_provider');
	if (line.includes('logged in using chatgpt')) return signedIn('subscription');
	if (line.includes('api key configured') || line.includes('logged in using an api key')) return signedIn('api_key');
	if (line.includes('access token') || line.includes('workload identity')) return signedIn('access_token');
	if (line.includes('logged in')) return signedIn('unknown');
	return null;
}

/** The status command of each CLI this node can run agent work with. */
const AUTH_PROBES: Readonly<
	Record<string, { args: string[]; read: (stdout: string, stderr: string) => AgentAuthReading | null }>
> = {
	// stdout alone first: a warning on stderr beside a valid document must
	// not make the document unreadable.
	'claude-code': {
		args: ['auth', 'status', '--json'],
		read: (stdout) => readClaudeAuthStatus(stdout)
	},
	codex: {
		args: ['login', 'status'],
		read: (stdout, stderr) => readCodexLoginStatus(`${stdout}\n${stderr}`)
	}
};

/**
 * Ask one CLI how it is signed in. The exit code is not the judge (both CLIs
 * exit 1 when signed out and still say so); the parser is. Null when the
 * command could not run, timed out or printed something else — "could not
 * tell", which the report shows as `unknown`, never as signed out.
 */
export async function probeAgentAuth(
	runner: CommandRunner,
	provider: string,
	executable: string
): Promise<AgentAuthReading | null> {
	const probe = AUTH_PROBES[provider];
	if (!probe) return null;
	try {
		const result = await runner.run(executable, probe.args, { timeoutMs: AGENT_AUTH_PROBE_TIMEOUT_MS });
		if (result.timedOut || result.spawnError) return null;
		return probe.read(result.stdout ?? '', result.stderr ?? '');
	} catch {
		return null;
	}
}

/**
 * Agent CLIs the node can SEE but has no executor for. Reported so an owner
 * who installed one learns why it does not count, instead of wondering.
 */
export const UNSUPPORTED_AGENT_CLIS: readonly string[] = ['gemini', 'opencode'];

/** Which of {@link UNSUPPORTED_AGENT_CLIS} answer `--version` here. */
export async function detectUnsupportedAgentClis(
	runner: CommandRunner,
	candidates: readonly string[] = UNSUPPORTED_AGENT_CLIS
): Promise<Array<{ provider: string; version: string | null }>> {
	const found: Array<{ provider: string; version: string | null }> = [];
	for (const command of candidates) {
		try {
			const result = await runner.run(command, ['--version'], { timeoutMs: AGENT_AUTH_PROBE_TIMEOUT_MS });
			if (result.code !== 0) continue;
			found.push({
				provider: command,
				version: parseCliVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
			});
		} catch {
			// A spawn failure is an absent tool, not a probe failure.
		}
	}
	return found;
}

// ─── Usage windows a real run (or its record) carried ───────────────────────

/** Claude Code's `rateLimitType` → the report's window token. */
const CLAUDE_RATE_LIMIT_WINDOWS: Readonly<Record<string, string>> = {
	five_hour: 'five_hour',
	seven_day: 'weekly',
	seven_day_overage_included: 'weekly',
	seven_day_opus: 'weekly_opus',
	seven_day_sonnet: 'weekly_sonnet',
	overage: 'overage'
};

/** An epoch the CLIs print in seconds (or, defensively, milliseconds) → ISO, or null. */
function epochToIso(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	const ms = value > 1e11 ? value : value * 1000;
	const date = new Date(ms);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The usage windows a Claude Code `stream-json` run reported about its own
 * seat, newest per window.
 *
 * Claude Code writes `{"type":"rate_limit_event","rate_limit_info":{status,
 * resetsAt, rateLimitType, utilization, …}}` lines into the stream of a run
 * on a subscription seat (Claude Agent SDK reference, `SDKRateLimitEvent`).
 * Reading them costs nothing: the run happened anyway. `utilization` is a
 * 0-1 fraction; `resetsAt` is epoch seconds; `status: 'rejected'` means the
 * window is exhausted.
 *
 * Only a line whose TOP-LEVEL `type` is `rate_limit_event` counts. The same
 * words inside a tool result (a file the model read) sit under a `user`
 * event and are ignored, so a repository cannot forge a reading.
 */
export function readClaudeRateLimitWindows(rawOutput: string | null | undefined): FleetAgentUsageWindow[] {
	if (typeof rawOutput !== 'string' || !rawOutput.includes('rate_limit_event')) return [];
	const byWindow = new Map<string, FleetAgentUsageWindow>();
	for (const line of rawOutput.split(/\r?\n/)) {
		if (!line.includes('rate_limit_event')) continue;
		let event: Record<string, unknown> | null = null;
		try {
			const parsed = JSON.parse(line) as unknown;
			event =
				parsed && typeof parsed === 'object' && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: null;
		} catch {
			continue;
		}
		if (!event || event.type !== 'rate_limit_event') continue;
		const info = event.rate_limit_info;
		if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
		const source = info as Record<string, unknown>;
		const type = typeof source.rateLimitType === 'string' ? source.rateLimitType : '';
		const window = CLAUDE_RATE_LIMIT_WINDOWS[type] ?? (type && /^[a-z0-9_]{1,32}$/.test(type) ? type : 'usage');
		const utilization =
			typeof source.utilization === 'number' && Number.isFinite(source.utilization) && source.utilization >= 0
				? source.utilization
				: null;
		// A 0-1 fraction by contract; a value above 1 can only be a percentage.
		const usedPercent =
			utilization === null
				? null
				: Math.min(100, Math.round((utilization <= 1 ? utilization * 100 : utilization) * 10) / 10);
		const entry: FleetAgentUsageWindow = { window, usedPercent, resetsAt: epochToIso(source.resetsAt) };
		if (source.status === 'rejected') entry.limited = true;
		if (entry.usedPercent === null && entry.resetsAt === null && !entry.limited) continue;
		byWindow.set(window, entry);
	}
	return [...byWindow.values()];
}

/** Codex window length in minutes → the report's window token. */
function codexWindowToken(minutes: unknown, slot: 'primary' | 'secondary'): string {
	if (minutes === 300) return 'five_hour';
	if (minutes === 10_080) return 'weekly';
	return slot;
}

/**
 * The rate-limit snapshot of one Codex session-record line, or null.
 *
 * Codex persists every `token_count` event to its rollout file
 * (`<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`), and the event carries
 * the seat's `rate_limits`: `primary` and `secondary`, each `{ used_percent,
 * window_minutes, resets_at }` (openai/codex,
 * `codex-rs/protocol/src/protocol.rs`, `RateLimitSnapshot` /
 * `RateLimitWindow`). `codex exec --json` prints token counts only, so the
 * record is the one place a past run left this.
 */
export function readCodexRateLimitLine(line: string): { windows: FleetAgentUsageWindow[]; at: string | null } | null {
	if (!line.includes('token_count') || !line.includes('rate_limits')) return null;
	let record: Record<string, unknown>;
	try {
		const parsed = JSON.parse(line) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		record = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	const payload = record.payload as Record<string, unknown> | null | undefined;
	if (record.type !== 'event_msg' || !payload || typeof payload !== 'object' || payload.type !== 'token_count') {
		return null;
	}
	const limits = payload.rate_limits as Record<string, unknown> | null | undefined;
	if (!limits || typeof limits !== 'object') return null;
	const windows: FleetAgentUsageWindow[] = [];
	for (const slot of ['primary', 'secondary'] as const) {
		const raw = limits[slot] as Record<string, unknown> | null | undefined;
		if (!raw || typeof raw !== 'object') continue;
		const used =
			typeof raw.used_percent === 'number' && Number.isFinite(raw.used_percent) && raw.used_percent >= 0
				? Math.min(100, Math.round(raw.used_percent * 10) / 10)
				: null;
		const resetsAt = epochToIso(raw.resets_at);
		if (used === null && resetsAt === null) continue;
		const window: FleetAgentUsageWindow = {
			window: codexWindowToken(raw.window_minutes, slot),
			usedPercent: used,
			resetsAt
		};
		if (used !== null && used >= 100) window.limited = true;
		windows.push(window);
	}
	if (windows.length === 0) return null;
	const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
	return { windows, at: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null };
}

/** The read-only filesystem the Codex record lookup needs (a subset of the usage scan's). */
export interface AgentRecordFs {
	readdir(
		dir: string
	): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
	lstat(path: string): Promise<{ size: number; isFile(): boolean; isSymbolicLink(): boolean }>;
	openRead(
		path: string
	): Promise<{ read(length: number, position: number): Promise<Buffer>; close(): Promise<void> }>;
}

/** How much of the end of a record is read for its last snapshot. */
export const CODEX_RECORD_TAIL_BYTES = 256 * 1024;
/** How many of the newest records are tried before giving up. */
export const CODEX_RECORD_MAX_FILES = 3;

/**
 * The newest rate-limit snapshot Codex left under one `sessions` folder.
 *
 * Bounded on purpose: it walks only the newest year / month / day folders
 * (their names sort), opens at most {@link CODEX_RECORD_MAX_FILES} records,
 * and reads at most {@link CODEX_RECORD_TAIL_BYTES} from the END of each.
 * Never follows a symbolic link, never writes, and keeps nothing but the
 * numbers: no message, instruction or tool output is copied out of a line.
 *
 * The caller reads a record folder only under the owner's `--usage-scan`
 * consent — the switch that already decides whether this node may read
 * session records at all.
 */
export async function readNewestCodexRateLimits(
	fs: AgentRecordFs,
	sessionsDir: string,
	join: (...parts: string[]) => string
): Promise<{ windows: FleetAgentUsageWindow[]; at: string | null } | null> {
	const newestFirst = async (dir: string, want: 'dir' | 'file'): Promise<string[]> => {
		try {
			return (await fs.readdir(dir))
				.filter(
					(entry) =>
						!entry.isSymbolicLink() &&
						(want === 'dir' ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.jsonl'))
				)
				.map((entry) => entry.name)
				.sort()
				.reverse();
		} catch {
			return [];
		}
	};
	const files: string[] = [];
	for (const year of (await newestFirst(sessionsDir, 'dir')).slice(0, 2)) {
		for (const month of (await newestFirst(join(sessionsDir, year), 'dir')).slice(0, 2)) {
			for (const day of (await newestFirst(join(sessionsDir, year, month), 'dir')).slice(0, 3)) {
				for (const name of await newestFirst(join(sessionsDir, year, month, day), 'file')) {
					files.push(join(sessionsDir, year, month, day, name));
					if (files.length >= CODEX_RECORD_MAX_FILES) break;
				}
				if (files.length >= CODEX_RECORD_MAX_FILES) break;
			}
			if (files.length >= CODEX_RECORD_MAX_FILES) break;
		}
		if (files.length >= CODEX_RECORD_MAX_FILES) break;
	}
	for (const path of files) {
		try {
			const stat = await fs.lstat(path);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) continue;
			const length = Math.min(stat.size, CODEX_RECORD_TAIL_BYTES);
			const handle = await fs.openRead(path);
			let tail: string;
			try {
				tail = (await handle.read(length, stat.size - length)).toString('utf8');
			} finally {
				await handle.close().catch(() => undefined);
			}
			const lines = tail.split(/\r?\n/);
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const reading = readCodexRateLimitLine(lines[index]!);
				if (reading) return reading;
			}
		} catch {
			// An unreadable record is skipped; the next newest is tried.
		}
	}
	return null;
}

// ─── What real runs proved ──────────────────────────────────────────────────

/** One finished model-CLI invocation, as the executor reports it. */
export interface AgentRunObservation {
	provider: string;
	status: 'succeeded' | 'failed' | 'timeout' | 'error';
	/** The CLI's own final message. */
	summary?: string | null;
	/** The CLI's output tail (may hold the model's words — read strictly). */
	outputTail?: string | null;
	/** Output tokens the run reported: above zero, the CLI reached its model. */
	outputTokens?: number | null;
	/** Usage windows the run's own stream carried. */
	usage?: FleetAgentUsageWindow[];
}

/** A classified failure, with when it happened and how the CLI was signed in at the time. */
export interface AgentRunFailure extends FleetAgentFailure {
	at: string;
	/**
	 * The sign-in fingerprint in force when the run failed, or null when no
	 * status reading existed yet. A DIFFERENT fingerprint later means the
	 * owner signed in again (or switched method), which is what lifts a
	 * `not_signed_in` / `access_denied` verdict short of a successful run.
	 */
	authFingerprint: string | null;
}

export interface AgentRunHistoryEntry {
	lastSuccessAt: string | null;
	failure: AgentRunFailure | null;
	usage: FleetAgentUsageWindow[];
	usageObservedAt: string | null;
}

/**
 * Persisted beside the node config so a restart does not forget that the
 * last run was refused: the status command can keep saying "signed in" for
 * an organization that switched access off. NOT a secret — statuses, the
 * CLI's (masked) sentence and timestamps.
 */
export interface AgentRunHistoryRecord {
	version: 1;
	recordedAt: string;
	agents: Record<string, AgentRunHistoryEntry>;
}

/** Deliberately adjacent to the config, like the lifecycle record. */
export function agentRunHistoryPath(configPath: string): string {
	return `${configPath}.agent-readiness.json`;
}

function isoOrNull(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Defensive parse — a hand-edited or truncated file reads as "no record". */
export function parseAgentRunHistoryRecord(raw: string | null | undefined): AgentRunHistoryRecord | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const record = parsed as Partial<AgentRunHistoryRecord>;
	if (record.version !== 1 || !record.agents || typeof record.agents !== 'object' || Array.isArray(record.agents)) {
		return null;
	}
	const agents: Record<string, AgentRunHistoryEntry> = {};
	for (const [provider, value] of Object.entries(record.agents).slice(0, 16)) {
		if (!/^[A-Za-z0-9._:+-]{1,32}$/.test(provider) || !value || typeof value !== 'object') continue;
		const entry = value as Partial<AgentRunHistoryEntry>;
		// The stored windows go through the contract's own sanitiser, inside a
		// one-agent report, so a hand-edited file cannot put anything on the
		// wire that a fresh reading could not.
		const usage =
			normalizeFleetAgentReadinessReport({
				checkedAt: new Date(0).toISOString(),
				agents: [{ provider, installed: true, status: 'unknown', usage: entry.usage }]
			})?.agents[0]?.usage ?? [];
		const failure = entry.failure;
		const kind = failure?.kind;
		const at = isoOrNull(failure?.at);
		agents[provider] = {
			lastSuccessAt: isoOrNull(entry.lastSuccessAt),
			failure:
				failure && at && (kind === 'not_signed_in' || kind === 'access_denied' || kind === 'limit_reached')
					? {
							kind,
							reason: sanitizeFleetAgentReason(failure.reason) ?? kind,
							resetsAt: isoOrNull(failure.resetsAt),
							until: isoOrNull(failure.until),
							usageLimit: failure.usageLimit === true,
							at,
							authFingerprint:
								typeof failure.authFingerprint === 'string' ? failure.authFingerprint : null
						}
					: null,
			usage,
			usageObservedAt: usage.length > 0 ? isoOrNull(entry.usageObservedAt) : null
		};
	}
	return { version: 1, recordedAt: isoOrNull(record.recordedAt) ?? new Date(0).toISOString(), agents };
}

/** The record an earlier process left, or null when there is none or it is unreadable. Never throws. */
export async function readAgentRunHistoryRecord(
	fs: Pick<ConfigFileSystem, 'readFile'>,
	configPath: string
): Promise<AgentRunHistoryRecord | null> {
	try {
		return parseAgentRunHistoryRecord(await fs.readFile(agentRunHistoryPath(configPath)));
	} catch {
		return null;
	}
}

/**
 * Write the record — atomically, like the lifecycle record, so a kill
 * mid-write leaves the previous one rather than a torn one. Best-effort by
 * contract: the caller logs a failure and carries on.
 */
export async function writeAgentRunHistoryRecord(
	fs: StateFileSystem & Pick<ConfigFileSystem, 'mkdir' | 'dirname'>,
	configPath: string,
	record: AgentRunHistoryRecord
): Promise<void> {
	const path = agentRunHistoryPath(configPath);
	await fs.mkdir(fs.dirname(path));
	await writeStateFile(fs, path, `${JSON.stringify(record, null, 2)}\n`);
}

export interface AgentRunHistoryOptions {
	now?: () => number;
	/** IANA zone a CLI's "resets 3am" is read in — this machine's own. */
	timeZone?: () => string | undefined;
	/** What an earlier process recorded. */
	initial?: AgentRunHistoryRecord | null;
	/** Called (in order, one write at a time) whenever the record changes. Best-effort. */
	persist?: (record: AgentRunHistoryRecord) => Promise<void> | void;
	logger?: Pick<Logger, 'warn'>;
}

/** The sign-in a status reading describes, as one comparable string; null when there is no reading. */
export function agentAuthFingerprint(auth: AgentAuthReading | null | undefined): string | null {
	if (!auth || auth.signedIn === null) return null;
	return `${auth.signedIn ? 'in' : 'out'}|${auth.method}|${auth.account ?? ''}`;
}

/**
 * What the runs on this node proved about each agent CLI.
 *
 * Fed by the executor after every model-CLI invocation ({@link note}). It
 * never runs anything itself.
 */
export class AgentRunHistory {
	private readonly entries = new Map<string, AgentRunHistoryEntry>();
	private readonly fingerprints = new Map<string, string>();
	private readonly now: () => number;
	private writes: Promise<void> = Promise.resolve();

	constructor(private readonly options: AgentRunHistoryOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		for (const [provider, entry] of Object.entries(options.initial?.agents ?? {})) {
			this.entries.set(provider, { ...entry, usage: [...entry.usage] });
		}
	}

	/** The entry for one CLI (a fresh, empty one when nothing was ever observed). */
	get(provider: string): AgentRunHistoryEntry {
		return this.entries.get(provider) ?? { lastSuccessAt: null, failure: null, usage: [], usageObservedAt: null };
	}

	/**
	 * Record one finished model-CLI invocation.
	 *
	 *  - a SUCCESS stamps `lastSuccessAt` and clears any failure: the agent
	 *    just worked;
	 *  - a FAILURE is classified from the CLI's own final message, then —
	 *    strictly — from its output tail; a failure that names none of the
	 *    conditions changes nothing, except that one which demonstrably
	 *    reached the model (it produced output tokens) clears an earlier
	 *    "not signed in" / "access denied", since that is no longer true;
	 *  - a TIMEOUT proves nothing either way.
	 */
	note(observation: AgentRunObservation): void {
		const provider = observation.provider;
		if (typeof provider !== 'string' || !provider) return;
		const nowMs = this.now();
		const at = new Date(nowMs).toISOString();
		const entry = { ...this.get(provider) };
		let changed = false;
		if (observation.usage && observation.usage.length > 0) {
			entry.usage = observation.usage.slice(0, 6);
			entry.usageObservedAt = at;
			changed = true;
		}
		if (observation.status === 'succeeded') {
			entry.lastSuccessAt = at;
			entry.failure = null;
			changed = true;
		} else if (observation.status !== 'timeout') {
			const classify = { provider, now: nowMs, timeZone: this.options.timeZone?.() };
			const failure =
				classifyFleetAgentFailure(observation.summary, classify) ??
				classifyFleetAgentFailure(observation.outputTail, { ...classify, strict: true });
			if (failure) {
				entry.failure = { ...failure, at, authFingerprint: this.fingerprints.get(provider) ?? null };
				changed = true;
			} else if (
				entry.failure &&
				entry.failure.kind !== 'limit_reached' &&
				typeof observation.outputTokens === 'number' &&
				observation.outputTokens > 0
			) {
				entry.failure = null;
				changed = true;
			}
		}
		if (!changed) return;
		this.entries.set(provider, entry);
		this.save();
	}

	/** Usage windows learned outside a run of this process (a Codex session record). */
	noteUsage(provider: string, windows: readonly FleetAgentUsageWindow[], observedAt: string | null): void {
		if (windows.length === 0) return;
		const entry = { ...this.get(provider) };
		const at = observedAt ?? new Date(this.now()).toISOString();
		// Never replace a newer reading with an older record.
		if (entry.usageObservedAt && Date.parse(entry.usageObservedAt) >= Date.parse(at)) return;
		entry.usage = windows.slice(0, 6);
		entry.usageObservedAt = at;
		this.entries.set(provider, entry);
		this.save();
	}

	/**
	 * Tell the history how a CLI is signed in right now. A sign-in that
	 * CHANGED since a run was refused lifts that verdict: the owner signed in
	 * again or switched to another credential, and the old sentence no longer
	 * describes this seat. A failure recorded before any reading existed
	 * adopts the first one, so a later change is still noticed.
	 */
	observeAuth(provider: string, auth: AgentAuthReading | null): void {
		const fingerprint = agentAuthFingerprint(auth);
		if (fingerprint === null) return;
		this.fingerprints.set(provider, fingerprint);
		const entry = this.entries.get(provider);
		const failure = entry?.failure;
		if (!entry || !failure || failure.kind === 'limit_reached') return;
		if (failure.authFingerprint === null) {
			this.entries.set(provider, { ...entry, failure: { ...failure, authFingerprint: fingerprint } });
			this.save();
		} else if (failure.authFingerprint !== fingerprint) {
			this.entries.set(provider, { ...entry, failure: null });
			this.save();
		}
	}

	/** Everything observed so far, in the shape that is persisted. */
	record(): AgentRunHistoryRecord {
		return {
			version: 1,
			recordedAt: new Date(this.now()).toISOString(),
			agents: Object.fromEntries(this.entries)
		};
	}

	/** Resolves once every queued write has settled (test / shutdown helper). */
	async settled(): Promise<void> {
		await this.writes;
	}

	/** QUEUED, like the link record's writes: the newest record must be the one that lands last. */
	private save(): void {
		const persist = this.options.persist;
		if (!persist) return;
		const record = this.record();
		this.writes = this.writes
			.then(() => persist(record))
			.catch((error: unknown) => {
				try {
					this.options.logger?.warn(
						`Could not record agent readiness: ${error instanceof Error ? error.message : String(error)}`
					);
				} catch {
					// A failing log sink must not wedge the queue.
				}
			});
	}
}

// ─── The report ─────────────────────────────────────────────────────────────

/** One model CLI the node is out of quota on, as the worker loop holds it. */
export interface AgentThrottle {
	provider: string;
	until: string;
	reason: string;
}

export interface ResolveAgentStatusInput {
	installed: boolean;
	/** The startup PATH lookup timed out: unknown, not missing. */
	probeTimedOut?: boolean;
	/** Always-passed flags this binary does not understand (non-empty = a run cannot start). */
	missingRequiredFlags?: readonly string[];
	auth: AgentAuthReading | null;
	history: AgentRunHistoryEntry;
	/** The worker's active throttle for this CLI, or null. */
	throttle?: AgentThrottle | null;
	/**
	 * True when {@link throttle} comes from a worker loop (so "no throttle"
	 * means the platform lifted it); false on a node without a worker.
	 */
	throttlesKnown?: boolean;
	nowMs: number;
}

/**
 * The status of one agent CLI this node can run work with. Pure.
 *
 * In order — the first that applies wins:
 *
 *  1. not installed → `not_installed` (`unknown` when the startup probe
 *     timed out: a busy machine is not a missing CLI);
 *  2. a binary too old to be started by this node → `unsupported`;
 *  3. the worker is throttling this CLI → `limit_reached` until its instant;
 *  4. the last classified failure still stands → its status, with the CLI's
 *     own sentence. A usage limit stands until its instant — and, on a node
 *     with a worker, only while the worker still holds the throttle (an
 *     owner's "Clear limit now" lifts both);
 *  5. the status command says signed in → `ready`;
 *  6. a run succeeded within {@link AGENT_SUCCESS_TRUST_MS} → `ready` (the
 *     run is better evidence than a status command that cannot see a
 *     per-run credential);
 *  7. the status command says signed out → `not_signed_in`;
 *  8. otherwise `unknown` — never `ready` on no evidence.
 */
export function resolveAgentStatus(
	input: ResolveAgentStatusInput
): Pick<FleetAgentReadinessEntry, 'status' | 'reason'> & { limitResetsAt?: string | null } {
	if (!input.installed) {
		return input.probeTimedOut
			? {
					status: 'unknown',
					reason: 'The startup lookup for this CLI timed out; restart the node when the machine is less busy.'
				}
			: { status: 'not_installed', reason: null };
	}
	const missing = input.missingRequiredFlags ?? [];
	if (missing.length > 0) {
		return {
			status: 'unsupported',
			reason: `This CLI version is too old for this node (it lacks ${missing.slice(0, 4).join(', ')}); update the CLI.`
		};
	}
	if (input.throttle) {
		return {
			status: 'limit_reached',
			reason: sanitizeFleetAgentReason(input.throttle.reason),
			limitResetsAt: isoOrNull(input.throttle.until)
		};
	}
	const failure = input.history.failure;
	if (failure) {
		if (failure.kind !== 'limit_reached') return { status: failure.kind, reason: failure.reason };
		const until = failure.until ? Date.parse(failure.until) : Number.NaN;
		const lifted = failure.usageLimit && input.throttlesKnown === true;
		if (!lifted && Number.isFinite(until) && until > input.nowMs) {
			return {
				status: 'limit_reached',
				reason: failure.reason,
				limitResetsAt: failure.resetsAt ?? failure.until
			};
		}
	}
	if (input.auth?.signedIn === true) return { status: 'ready', reason: null };
	const lastSuccess = input.history.lastSuccessAt ? Date.parse(input.history.lastSuccessAt) : Number.NaN;
	if (Number.isFinite(lastSuccess) && input.nowMs - lastSuccess <= AGENT_SUCCESS_TRUST_MS) {
		return { status: 'ready', reason: null };
	}
	if (input.auth?.signedIn === false) {
		return { status: 'not_signed_in', reason: 'The CLI is not signed in on this computer.' };
	}
	return { status: 'unknown', reason: 'The CLI did not answer its status command.' };
}

/** One CLI the node can run agent work with, as the composition root describes it. */
export interface DrivableAgentCli {
	provider: string;
	/** The pinned executable a run would spawn, or null when there is none. */
	executable: string | null;
	version: string | null;
	missingRequiredFlags?: readonly string[];
	probeTimedOut?: boolean;
}

export interface AgentReadinessSources {
	/** The CLIs this node has an executor for (`claude-code`, `codex`), installed or not. */
	drivable: () => Promise<readonly DrivableAgentCli[]> | readonly DrivableAgentCli[];
	/** How one installed CLI is signed in (the caller caches it). */
	auth: (provider: string, executable: string) => Promise<AgentAuthReading | null>;
	/** Installed CLIs the node has no executor for (the caller caches it). */
	unsupported?: () => Promise<ReadonlyArray<{ provider: string; version: string | null }>>;
	history: AgentRunHistory;
	/** The worker's active model throttles; absent on a node without a worker. */
	throttles?: () => readonly AgentThrottle[];
	now?: () => number;
}

/** Windows whose reset has passed describe an allowance that no longer exists. */
function currentWindows(windows: readonly FleetAgentUsageWindow[], nowMs: number): FleetAgentUsageWindow[] {
	return windows.filter((window) => {
		const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
		return !Number.isFinite(resetsAt) || resetsAt > nowMs;
	});
}

/**
 * Assemble the heartbeat's `agents` report. Never throws for one CLI's sake:
 * a status command that fails is that CLI's `unknown`.
 */
export async function buildAgentReadinessReport(sources: AgentReadinessSources): Promise<FleetAgentReadinessReport> {
	const now = sources.now ?? (() => Date.now());
	const nowMs = now();
	const checkedAt = new Date(nowMs).toISOString();
	const throttlesKnown = sources.throttles !== undefined;
	const throttles = new Map<string, AgentThrottle>();
	for (const throttle of sources.throttles?.() ?? []) throttles.set(throttle.provider, throttle);

	const agents: FleetAgentReadinessEntry[] = [];
	for (const cli of await sources.drivable()) {
		const installed = typeof cli.executable === 'string' && cli.executable.length > 0;
		let auth: AgentAuthReading | null = null;
		if (installed) {
			try {
				auth = await sources.auth(cli.provider, cli.executable as string);
			} catch {
				auth = null;
			}
			sources.history.observeAuth(cli.provider, auth);
		}
		const history = sources.history.get(cli.provider);
		const verdict = resolveAgentStatus({
			installed,
			probeTimedOut: cli.probeTimedOut === true,
			missingRequiredFlags: cli.missingRequiredFlags ?? [],
			auth,
			history,
			throttle: throttles.get(cli.provider) ?? null,
			throttlesKnown,
			nowMs
		});
		const entry: FleetAgentReadinessEntry = {
			provider: cli.provider,
			installed,
			version: installed ? cli.version : null,
			signedIn: installed ? (auth?.signedIn ?? null) : null,
			authMethod: installed ? (auth?.method ?? 'unknown') : 'unknown',
			account: installed ? (auth?.account ?? null) : null,
			status: verdict.status,
			reason: verdict.reason,
			checkedAt
		};
		if (verdict.limitResetsAt) entry.limitResetsAt = verdict.limitResetsAt;
		const usage = currentWindows(history.usage, nowMs);
		if (installed && usage.length > 0) {
			entry.usage = usage;
			entry.usageObservedAt = history.usageObservedAt;
		}
		if (history.lastSuccessAt) entry.lastSuccessAt = history.lastSuccessAt;
		if (history.failure) entry.lastFailureAt = history.failure.at;
		agents.push(entry);
	}

	let others: ReadonlyArray<{ provider: string; version: string | null }> = [];
	try {
		others = (await sources.unsupported?.()) ?? [];
	} catch {
		others = [];
	}
	for (const other of others) {
		if (agents.some((entry) => entry.provider === other.provider)) continue;
		agents.push({
			provider: other.provider,
			installed: true,
			version: other.version,
			signedIn: null,
			authMethod: 'unknown',
			account: null,
			status: 'unsupported' satisfies FleetAgentReadinessStatus,
			reason: 'This node version cannot run agent work with this CLI.',
			checkedAt
		});
	}
	return { checkedAt, agents };
}

function text(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	// eslint-disable-next-line no-control-regex
	const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
	return cleaned ? cleaned : null;
}
