/**
 * Sessions on computers (FL-04) — the terminal the daemon gives each session.
 *
 * A session is an interactive process — an agent's TUI or a person's shell —
 * so it needs a REAL terminal: the `@homebridge/node-pty-prebuilt-multiarch`
 * addon the `pty-local` terminal host already ships (ConPTY on Windows, a
 * pty on macOS and Linux). There is deliberately no pipe floor here: a TUI
 * on a pipe renders garbage and cannot be resized, so when the addon is
 * missing the daemon reports `pty: missing` and the node withdraws the
 * `sessions` tag, naming the fix (spec U3) — it never pretends.
 *
 * The addon is a RUNTIME require (never a static import): bundlers would
 * trace it, and a machine without the prebuild must degrade, not crash on
 * module load. Everything that spawns goes through {@link PtyFactory}, so
 * the daemon is testable with any process host.
 */

/** One running terminal process. */
export interface PtyProcess {
	readonly pid: number | null;
	onData(listener: (data: string) => void): void;
	onExit(listener: (exit: { exitCode: number | null; signal?: number | null }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** Ask it to stop (`SIGTERM`-like); `force` kills it outright. */
	kill(force?: boolean): void;
}

export interface PtySpawnOptions {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;

export interface PtyAvailability {
	available: boolean;
	/** Why not, in words a person can act on. */
	reason?: string;
}

/** The structural slice of node-pty this file uses — typed locally so the addon stays a runtime require. */
interface NodePtyModule {
	spawn(
		file: string,
		args: string[],
		options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
	): {
		readonly pid: number;
		onData(listener: (data: string) => void): void;
		onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
		write(data: string): void;
		resize(cols: number, rows: number): void;
		kill(signal?: string): void;
	};
}

/** The terminal addon: the package the `pty-local` terminal host requires at runtime. */
export const PTY_ADDON = '@homebridge/node-pty-prebuilt-multiarch';

/**
 * The range `ever-works-node` installs the addon at. `build.js` publishes the
 * range from the `pty-local` plugin's manifest; `pty-host.spec.ts` keeps this
 * copy equal to it (and to `apps/node/package.json`), so the fix printed below
 * always names the version the release ships.
 *
 * 0.15 is the first line that loads on Node 25+: 0.13.x declares
 * `engines: node <25`, and npm skips an optional dependency whose engines
 * exclude the running Node without a word, so 0.2.10 on Node 26 had no
 * terminal at all.
 */
export const PTY_ADDON_RANGE = '^0.15.0';

/**
 * The command that puts the addon where a global `ever-works-node` finds it
 * (beside it in the global `node_modules`). Quoted: `^` is cmd.exe's escape
 * character.
 */
export const PTY_INSTALL_COMMAND = `npm install -g "${PTY_ADDON}@${PTY_ADDON_RANGE}"`;

const PTY_FIX = `Fix: ${PTY_INSTALL_COMMAND} as the user who installed ever-works-node, then restart ever-works-node`;

/** The fix a person can apply when the addon is missing and there is no loader error to explain why. */
export const PTY_MISSING_HINT = `terminal support is missing on this computer: the terminal addon ${PTY_ADDON}@${PTY_ADDON_RANGE} is not usable. ${PTY_FIX}.`;

/** Where the addon was looked for: the running Node and its platform. */
export interface PtyRuntime {
	node: string;
	platform: string;
	arch: string;
	/** Linux with musl libc (Alpine). Absent means glibc or not Linux. */
	musl?: boolean;
}

/**
 * True on Linux with musl libc. Node's diagnostic report names the glibc it
 * runs on (`header.glibcVersionRuntime`) and has no such field on musl — the
 * check `detect-libc` makes. Never throws.
 */
export function isMuslLinux(
	platform: string = process.platform,
	getReport: () => unknown = () => process.report?.getReport?.()
): boolean {
	if (platform !== 'linux') return false;
	try {
		const report = getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
		return Boolean(report?.header) && !report?.header?.glibcVersionRuntime;
	} catch {
		return false;
	}
}

const currentRuntime = (): PtyRuntime => ({
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	...(isMuslLinux() ? { musl: true } : {})
});

/**
 * Why the addon is refused on musl Linux. 0.15 ships `linux-musl-*`
 * prebuilds, but its loader (`lib/utils.js` `loadNativeModule`) only looks in
 * `prebuilds/<platform>-<arch>`, so on Alpine it loads the glibc build: the
 * require succeeds and the first `spawn()` segfaults the whole process (seen
 * on `node:26-alpine`, 2026-11-11). Refusing keeps the node up, without
 * `sessions`, and says why. The fleet runs on glibc (Debian VMs, the
 * `node:26-bookworm-slim` image, the Trigger.dev bookworm worker).
 */
export const PTY_MUSL_REASON = `terminal support is missing: ${PTY_ADDON} ${PTY_ADDON_RANGE} has no working build for musl Linux (Alpine) — it loads its glibc build there and crashes on spawn. Run ever-works-node on a glibc Linux (Debian, Ubuntu, Fedora) for terminal sessions.`;

/**
 * Why the addon is unusable, in words a person can act on: the exact package
 * and range, the command that installs it, and the Node it failed on. Its
 * first ~280 characters carry the fix, because the platform keeps 300
 * (`FLEET_SESSION_DAEMON_REASON_MAX_LENGTH`) of the reason the heartbeat
 * reports; the loader's own message, when there is one, comes last.
 */
export function describePtyLoadFailure(
	error: unknown,
	runtime: PtyRuntime = currentRuntime(),
	installedVersion?: string | null
): string {
	const where = `Node ${runtime.node} (${runtime.platform}-${runtime.arch})`;
	const message = error instanceof Error ? error.message : error === undefined ? '' : String(error);
	const first = message.split(/\r?\n/, 1)[0].slice(0, 160);
	const code = (error as { code?: unknown } | null | undefined)?.code;
	if (code === 'MODULE_NOT_FOUND' && first.includes(PTY_ADDON)) {
		// Not installed. npm prints nothing when it skips an optional dependency
		// (engines that exclude this Node, or no prebuild and no compiler), so
		// this line is the first place anyone hears about it.
		return `terminal support is missing: npm did not install the optional addon ${PTY_ADDON}@${PTY_ADDON_RANGE} for ${where}. ${PTY_FIX}.`;
	}
	const installed = installedVersion ? `${PTY_ADDON} ${installedVersion}` : PTY_ADDON;
	const cause = first ? ` Loader: ${first}` : ' It has no spawn().';
	return `terminal support is missing: the terminal addon ${installed} does not load on ${where}. ${PTY_FIX}.${cause}`;
}

/** The installed addon's version, or null when it is not installed (never throws). */
export function readPtyAddonVersion(require_: (id: string) => unknown = require): string | null {
	try {
		const manifest = require_(`${PTY_ADDON}/package.json`) as { version?: unknown } | undefined;
		return typeof manifest?.version === 'string' ? manifest.version : null;
	} catch {
		return null;
	}
}

let cached: { module: NodePtyModule | null; reason?: string } | null = null;

/**
 * Load the addon once. A load that fails — not installed, installed without
 * its native binary, built for another Node — is remembered as missing with
 * a reason that names the package, the range and the install command
 * ({@link describePtyLoadFailure}), never thrown.
 */
export function loadNodePty(
	require_: (id: string) => unknown = require,
	runtime: PtyRuntime = currentRuntime()
): {
	module: NodePtyModule | null;
	reason?: string;
} {
	if (cached && require_ === require) return cached;
	let result: { module: NodePtyModule | null; reason?: string };
	if (runtime.musl === true) {
		result = { module: null, reason: PTY_MUSL_REASON };
		if (require_ === require) cached = result;
		return result;
	}
	try {
		const loaded = require_(PTY_ADDON) as Partial<NodePtyModule> | undefined;
		result =
			loaded && typeof loaded.spawn === 'function'
				? { module: loaded as NodePtyModule }
				: { module: null, reason: describePtyLoadFailure(undefined, runtime, readPtyAddonVersion(require_)) };
	} catch (error) {
		result = { module: null, reason: describePtyLoadFailure(error, runtime, readPtyAddonVersion(require_)) };
	}
	if (require_ === require) cached = result;
	return result;
}

/** What `doctor` prints about the terminal addon, checked in this process (no daemon needed). */
export interface TerminalAddonReport {
	available: boolean;
	addon: string;
	range: string;
	/** The installed addon's version, when it is installed. */
	version: string | null;
	node: string;
	/** Why it is unusable and the command that fixes it, when it is. */
	reason?: string;
}

/** Check the terminal addon here, read-only: the same load the session daemon does. */
export function describeTerminalAddon(
	require_: (id: string) => unknown = require,
	runtime: PtyRuntime = currentRuntime()
): TerminalAddonReport {
	const { module, reason } = loadNodePty(require_, runtime);
	return {
		available: module !== null,
		addon: PTY_ADDON,
		range: PTY_ADDON_RANGE,
		version: readPtyAddonVersion(require_),
		node: `${runtime.node} (${runtime.platform}-${runtime.arch})`,
		...(module ? {} : { reason: reason ?? PTY_MISSING_HINT })
	};
}

/** A {@link PtyFactory} over the real addon, or null with the reason when it is unavailable. */
export function createNodePtyFactory(require_: (id: string) => unknown = require): {
	factory: PtyFactory | null;
	availability: PtyAvailability;
} {
	const { module, reason } = loadNodePty(require_);
	if (!module) return { factory: null, availability: { available: false, reason: reason ?? PTY_MISSING_HINT } };
	const factory: PtyFactory = (options) => {
		const child = module.spawn(options.command, options.args, {
			name: 'xterm-256color',
			cols: options.cols,
			rows: options.rows,
			cwd: options.cwd,
			env: options.env
		});
		return {
			// Read live: on Windows the addon (0.15+) knows the pid only once
			// ConPTY has connected, a moment after spawn() returns, and reports
			// 0 until then.
			get pid() {
				return typeof child.pid === 'number' && child.pid > 0 ? child.pid : null;
			},
			onData: (listener) => child.onData(listener),
			onExit: (listener) =>
				child.onExit((event) =>
					listener({
						exitCode: typeof event.exitCode === 'number' ? event.exitCode : null,
						signal: typeof event.signal === 'number' ? event.signal : null
					})
				),
			write: (data) => child.write(data),
			resize: (cols, rows) => child.resize(cols, rows),
			kill: (force) => {
				try {
					// ConPTY ignores signal names; elsewhere SIGKILL is the forced stop.
					if (process.platform === 'win32') child.kill();
					else child.kill(force ? 'SIGKILL' : 'SIGTERM');
				} catch {
					// already gone
				}
			}
		};
	};
	return { factory, availability: { available: true } };
}
