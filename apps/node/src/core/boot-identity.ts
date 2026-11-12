import type { CommandRunner } from './capabilities';

/**
 * Which boot of this machine the node is running in (2026-11-12).
 *
 * A worker session records it in its safety marker, so a later start can tell
 * the two reasons a marker outlives its session apart: a CRASH (same boot, so
 * the dead session's process tree may still be running and the quarantine
 * stays) and a REBOOT (a different boot, which ended every process of the
 * previous one).
 *
 * Only identities the kernel mints once per boot are used, never one derived
 * from the wall clock: "now minus uptime" moves with every clock step (NTP, a
 * resumed VM), and a quarantine cleared on such a move without a reboot would
 * be exactly the fail-open the marker exists to prevent.
 *
 * - Linux: `/proc/sys/kernel/random/boot_id`, a random UUID per boot.
 * - macOS: `sysctl -n kern.bootsessionuuid`, a UUID per boot session.
 * - Windows: the boot counter `BootId` (REG_DWORD) under
 *   `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`,
 *   which the kernel advances on every boot (on the machine this was written on
 *   it equalled the number of "operating system started" events since install).
 *
 * Anything else, or any failure, is `null`, which keeps today's behaviour: the
 * marker carries no boot, and nothing clears itself.
 */
export type BootIdentitySource = 'linux-boot-id' | 'darwin-boot-session-uuid' | 'windows-boot-id';

export interface BootIdentity {
	source: BootIdentitySource;
	value: string;
}

export interface BootIdentityProbe {
	/** This boot's identity, or null when it cannot be read. Never rejects. */
	identity(): Promise<BootIdentity | null>;
	/** Seconds since this boot began, or null when unknown. Never throws. */
	uptimeSec(): number | null;
}

/** What {@link createBootIdentityProbe} reads through; tests inject fakes. */
export interface BootIdentityIo {
	/** `process.platform`. */
	platform: string;
	/** The file's text, or null when it does not exist. May reject. */
	readFile(filePath: string): Promise<string | null>;
	runner: CommandRunner;
	/** `os.uptime()`. */
	uptimeSec(): number;
}

export const BOOT_IDENTITY_SOURCES: readonly BootIdentitySource[] = [
	'linux-boot-id',
	'darwin-boot-session-uuid',
	'windows-boot-id'
];
export const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
/** Absolute, so no PATH entry can stand in for it. */
export const DARWIN_SYSCTL_PATH = '/usr/sbin/sysctl';
export const WINDOWS_BOOT_ID_KEY =
	'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters';

const PROBE_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The real probe. The identity is read once per process and kept: it cannot
 * change while this process lives (a reboot ends it), and the start-time check
 * and the worker's marker must agree on it.
 */
export function createBootIdentityProbe(io: BootIdentityIo): BootIdentityProbe {
	let identity: Promise<BootIdentity | null> | null = null;
	return {
		identity: () => (identity ??= readBootIdentity(io)),
		uptimeSec: () => {
			try {
				const seconds = io.uptimeSec();
				return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
			} catch {
				return null;
			}
		}
	};
}

/** This boot's identity for `io.platform`, or null. Never rejects. */
export async function readBootIdentity(io: BootIdentityIo): Promise<BootIdentity | null> {
	try {
		switch (io.platform) {
			case 'linux':
				return parseLinuxBootId(await io.readFile(LINUX_BOOT_ID_PATH));
			case 'darwin': {
				const result = await io.runner.run(DARWIN_SYSCTL_PATH, ['-n', 'kern.bootsessionuuid'], {
					timeoutMs: PROBE_TIMEOUT_MS
				});
				return answered(result) ? parseDarwinBootSessionUuid(result.stdout) : null;
			}
			case 'win32': {
				// `reg` resolves to `%SystemRoot%\System32\reg.exe`, never a PATH entry.
				const result = await io.runner.run('reg', ['query', WINDOWS_BOOT_ID_KEY, '/v', 'BootId'], {
					timeoutMs: PROBE_TIMEOUT_MS
				});
				return answered(result) ? parseWindowsBootId(result.stdout) : null;
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

export function parseLinuxBootId(raw: string | null): BootIdentity | null {
	const value = raw?.trim() ?? '';
	return UUID.test(value) ? { source: 'linux-boot-id', value: value.toLowerCase() } : null;
}

export function parseDarwinBootSessionUuid(stdout: string): BootIdentity | null {
	const value = stdout.trim();
	return UUID.test(value) ? { source: 'darwin-boot-session-uuid', value: value.toLowerCase() } : null;
}

/** `reg query … /v BootId` prints `    BootId    REG_DWORD    0x36`. */
export function parseWindowsBootId(stdout: string): BootIdentity | null {
	const match = /^\s*BootId\s+REG_DWORD\s+0x([0-9a-f]{1,8})\s*$/im.exec(stdout);
	if (!match) return null;
	return { source: 'windows-boot-id', value: String(Number.parseInt(match[1], 16)) };
}

function answered(result: Awaited<ReturnType<CommandRunner['run']>>): boolean {
	return result.code === 0 && result.timedOut !== true && !result.spawnError;
}
