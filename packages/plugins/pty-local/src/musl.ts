import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * musl Linux (Alpine) and the PTY addon.
 *
 * `@homebridge/node-pty-prebuilt-multiarch` 0.15 ships `linux-musl-*`
 * prebuilds, but its loader (`lib/utils.js` `loadNativeModule`) looks only in
 * `build/Release`, `build/Debug` and `prebuilds/<platform>-<arch>`. On musl it
 * therefore loads the GLIBC prebuild: the `require` succeeds and the first
 * `spawn()` segfaults the whole process (seen on `node:26-alpine`,
 * 2026-11-11). A source build in `build/Release` (an install with
 * `npm_config_build_from_source`) is built for this libc and is safe.
 */

/** How the check reads the machine; tests inject their own. */
export interface MuslProbe {
	platform: string;
	/** A file's text, or null when it cannot be read. */
	readFile(path: string): string | null;
	/** A folder's entries, or [] when it cannot be read. */
	readDir(path: string): string[];
	/** Node's diagnostic report header, read without touching the network. */
	reportHeader(): { glibcVersionRuntime?: unknown } | undefined;
}

const realProbe = (): MuslProbe => ({
	platform: process.platform,
	readFile: (path) => {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return null;
		}
	},
	readDir: (path) => {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
	reportHeader: () => {
		const report = process.report as { excludeNetwork?: boolean; getReport?: () => unknown } | undefined;
		if (!report?.getReport) return undefined;
		// A full report resolves every open socket's peer unless told not to.
		const previous = report.excludeNetwork;
		report.excludeNetwork = true;
		try {
			return (report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header;
		} finally {
			report.excludeNetwork = previous;
		}
	}
});

/**
 * The libc, from the cheapest evidence first — the files `detect-libc` and
 * the claude-code plugin read (`/lib/ld-musl-*`, `/usr/bin/ldd`), then the
 * diagnostic report (no `glibcVersionRuntime` on musl). Never throws.
 */
export function detectMuslLinux(probe: MuslProbe): boolean {
	if (probe.platform !== 'linux') return false;
	try {
		if (probe.readDir('/lib').some((name) => name.startsWith('ld-musl-'))) return true;
		const ldd = probe.readFile('/usr/bin/ldd');
		if (ldd !== null) return ldd.includes('musl');
		const header = probe.reportHeader();
		return header !== undefined && !header.glibcVersionRuntime;
	} catch {
		return false;
	}
}

let cachedMusl: boolean | null = null;

/** True on musl Linux. Detected once per process (the libc does not change under it). */
export function isMuslLinux(): boolean {
	if (cachedMusl === null) cachedMusl = detectMuslLinux(realProbe());
	return cachedMusl;
}

/**
 * True when the PTY addon must not be loaded here: musl Linux without a
 * source build of the addon. `resolvePackageJson` returns the addon's
 * `package.json` path (throws when it is not installed — then nothing is
 * loadable anyway, so the answer is `musl`).
 */
export function muslBlocksPtyAddon(
	resolvePackageJson: () => string,
	musl: boolean = isMuslLinux(),
	fileExists: (path: string) => boolean = existsSync
): boolean {
	if (!musl) return false;
	try {
		return !fileExists(join(dirname(resolvePackageJson()), 'build', 'Release', 'pty.node'));
	} catch {
		return true;
	}
}
