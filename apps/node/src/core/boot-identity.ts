import type { CommandRunner } from './capabilities';

/**
 * Which boot of WHICH machine the node is running in (2026-11-12).
 *
 * A worker session records it in its safety marker, so a later start can tell
 * the two reasons a marker outlives its session apart: a CRASH (same boot, so
 * the dead session's process tree may still be running and the quarantine
 * stays) and a REBOOT of this machine (a different boot, which ended every
 * process of the previous one).
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
 *   which the kernel advances on every FULL boot. "Shut down" with Fast Startup
 *   hibernates the kernel instead, so the next power-on keeps the counter (and
 *   the uptime): only "Restart" counts, which is right, since services survive
 *   a Fast Startup shutdown.
 *
 * A different boot proves a reboot only if the marker belongs to THIS machine,
 * so the identity carries the machine too: the host name everywhere, plus
 * `/etc/machine-id` on Linux when it is readable. A config directory shared
 * between machines (a roaming Windows profile, a volume that follows a pod)
 * then never clears another machine's live marker.
 *
 * Inside a container there is no identity at all: the boot is the host's, the
 * host name and machine id belong to an image or a pod that can be scheduled
 * anywhere, and the state volume may move with it. The auto-clear assumes a
 * machine-local config directory; a container keeps today's quarantine.
 *
 * WSL counts as a container here: `wsl --shutdown` gives the distro a new
 * `boot_id` and a fresh uptime with no host reboot, while Windows processes a
 * job started through interop may still be running.
 *
 * Anything else, or any failure, is `null`, which keeps today's behaviour: the
 * marker carries no boot, and nothing clears itself.
 */
export type BootIdentitySource = 'linux-boot-id' | 'darwin-boot-session-uuid' | 'windows-boot-id';

export interface BootIdentity {
	source: BootIdentitySource;
	/** This boot. */
	value: string;
	/** The machine it is a boot of: `os.hostname()`, lower-cased. */
	hostname: string;
	/** Linux `/etc/machine-id`, when readable. */
	machineId?: string;
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
	/** Whether the path exists. May reject. */
	exists(filePath: string): Promise<boolean>;
	/** `process.env`. */
	env: Readonly<Record<string, string | undefined>>;
	runner: CommandRunner;
	/** `os.hostname()`. */
	hostname(): string;
	/** `os.release()`: the kernel release (WSL's names Microsoft). */
	osRelease(): string;
	/** `os.uptime()`. */
	uptimeSec(): number;
}

export const BOOT_IDENTITY_SOURCES: readonly BootIdentitySource[] = [
	'linux-boot-id',
	'darwin-boot-session-uuid',
	'windows-boot-id'
];
export const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
export const LINUX_MACHINE_ID_PATH = '/etc/machine-id';
/** Absolute, so no PATH entry can stand in for it. */
export const DARWIN_SYSCTL_PATH = '/usr/sbin/sysctl';
export const WINDOWS_BOOT_ID_KEY =
	'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters';
/**
 * Container markers: Docker's `/.dockerenv`, Podman's `/run/.containerenv`,
 * and the file systemd writes when it detects one (LXC, nspawn, ...).
 */
export const LINUX_CONTAINER_MARKERS: readonly string[] = [
	'/.dockerenv',
	'/run/.containerenv',
	'/run/systemd/container'
];
/**
 * Set in every Kubernetes pod, by container managers for the container's
 * processes, and by WSL for processes it starts (a systemd service in WSL may
 * lack these, which is why the kernel release is checked too).
 */
export const CONTAINER_ENV_MARKERS: readonly string[] = [
	'KUBERNETES_SERVICE_HOST',
	'container',
	'WSL_DISTRO_NAME',
	'WSL_INTEROP'
];
/** A WSL kernel's release (`5.15.167.4-microsoft-standard-WSL2`, `4.4.0-19041-Microsoft`). */
const WSL_KERNEL_RELEASE = /microsoft|wsl/i;

const PROBE_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MACHINE_ID = /^[0-9a-f]{32}$/i;
const MAX_HOSTNAME_LENGTH = 255;

/**
 * The real probe. A boot identity, once read, is kept for the process: it
 * cannot change while this process lives (a reboot ends it). A FAILED read is
 * not kept: one `reg.exe` timeout on a machine still busy booting must not
 * also leave this session's marker without a boot, so the next call (the
 * worker arming its marker) reads again.
 */
export function createBootIdentityProbe(io: BootIdentityIo): BootIdentityProbe {
	let known: BootIdentity | null = null;
	let reading: Promise<BootIdentity | null> | null = null;
	return {
		identity: () => {
			if (known) return Promise.resolve(known);
			reading ??= readBootIdentity(io).then((identity) => {
				known = identity;
				reading = null;
				return identity;
			});
			return reading;
		},
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
		if (await inContainer(io)) return null;
		const hostname = normalizeHostname(io.hostname());
		if (!hostname) return null;
		const boot = await readKernelBoot(io);
		if (!boot) return null;
		const identity: BootIdentity = { ...boot, hostname };
		if (io.platform === 'linux') {
			const machineId = parseMachineId(await io.readFile(LINUX_MACHINE_ID_PATH).catch(() => null));
			if (machineId) identity.machineId = machineId;
		}
		return identity;
	} catch {
		return null;
	}
}

/** Same machine: the same host name and the same machine id (or neither has one). */
export function sameMachine(a: BootIdentity, b: BootIdentity): boolean {
	return a.hostname === b.hostname && (a.machineId ?? null) === (b.machineId ?? null);
}

/** A container or WSL, or a check that could not answer (counted as one: fail-closed). */
async function inContainer(io: BootIdentityIo): Promise<boolean> {
	if (CONTAINER_ENV_MARKERS.some((name) => (io.env[name] ?? '').trim() !== '')) return true;
	if (io.platform !== 'linux') return false;
	try {
		if (WSL_KERNEL_RELEASE.test(io.osRelease())) return true;
	} catch {
		return true;
	}
	for (const marker of LINUX_CONTAINER_MARKERS) {
		try {
			if (await io.exists(marker)) return true;
		} catch {
			return true;
		}
	}
	return false;
}

async function readKernelBoot(io: BootIdentityIo): Promise<Pick<BootIdentity, 'source' | 'value'> | null> {
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
}

export function parseLinuxBootId(raw: string | null): Pick<BootIdentity, 'source' | 'value'> | null {
	const value = raw?.trim() ?? '';
	return UUID.test(value) ? { source: 'linux-boot-id', value: value.toLowerCase() } : null;
}

export function parseDarwinBootSessionUuid(stdout: string): Pick<BootIdentity, 'source' | 'value'> | null {
	const value = stdout.trim();
	return UUID.test(value) ? { source: 'darwin-boot-session-uuid', value: value.toLowerCase() } : null;
}

/** `reg query … /v BootId` prints `    BootId    REG_DWORD    0x36`. */
export function parseWindowsBootId(stdout: string): Pick<BootIdentity, 'source' | 'value'> | null {
	const match = /^\s*BootId\s+REG_DWORD\s+0x([0-9a-f]{1,8})\s*$/im.exec(stdout);
	if (!match) return null;
	return { source: 'windows-boot-id', value: String(Number.parseInt(match[1], 16)) };
}

export function parseMachineId(raw: string | null): string | null {
	const value = raw?.trim() ?? '';
	return MACHINE_ID.test(value) ? value.toLowerCase() : null;
}

export function normalizeHostname(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const value = raw.trim().toLowerCase();
	return value && value.length <= MAX_HOSTNAME_LENGTH ? value : null;
}

function answered(result: Awaited<ReturnType<CommandRunner['run']>>): boolean {
	return result.code === 0 && result.timedOut !== true && !result.spawnError;
}
