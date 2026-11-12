import { describe, expect, it, vi } from 'vitest';
import {
	createBootIdentityProbe,
	DARWIN_SYSCTL_PATH,
	LINUX_BOOT_ID_PATH,
	LINUX_MACHINE_ID_PATH,
	readBootIdentity,
	sameMachine,
	WINDOWS_BOOT_ID_KEY,
	type BootIdentityIo
} from './boot-identity';
import type { CommandRunner } from './capabilities';

type RunResult = Awaited<ReturnType<CommandRunner['run']>>;
type FileAnswer = string | null | Error;

const LINUX_BOOT_ID = '4f3c0a52-8d1e-4b7a-9c2f-61d5e0b7a9c3';
const MACHINE_ID = '0123456789abcdef0123456789abcdef';
const DARWIN_UUID = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const REG_OUTPUT =
	'\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters\r\n' +
	'    BootId    REG_DWORD    0x36\r\n\r\n';

function io(
	platform: string,
	overrides: {
		/** Per path; a function answers each read in turn. */
		files?: Record<string, FileAnswer | (() => FileAnswer)>;
		existing?: string[] | Error;
		env?: Record<string, string>;
		hostname?: string;
		osRelease?: () => string;
		run?: Partial<RunResult> | Error;
		uptimeSec?: () => number;
	} = {}
) {
	const reads: string[] = [];
	const runs: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
	const value: BootIdentityIo = {
		platform,
		readFile: async (filePath) => {
			reads.push(filePath);
			const entry = overrides.files?.[filePath];
			const answer = typeof entry === 'function' ? entry() : entry;
			if (answer instanceof Error) throw answer;
			return answer ?? null;
		},
		exists: async (filePath) => {
			if (overrides.existing instanceof Error) throw overrides.existing;
			return (overrides.existing ?? []).includes(filePath);
		},
		env: overrides.env ?? {},
		runner: {
			run: async (command, args, options) => {
				runs.push({ command, args, timeoutMs: options?.timeoutMs });
				if (overrides.run instanceof Error) throw overrides.run;
				return { code: 0, stdout: '', stderr: '', ...overrides.run };
			}
		},
		hostname: () => overrides.hostname ?? 'Build-Box-01',
		osRelease: overrides.osRelease ?? (() => '6.8.0-49-generic'),
		uptimeSec: overrides.uptimeSec ?? (() => 120)
	};
	return { io: value, reads, runs };
}

const linuxFiles = { [LINUX_BOOT_ID_PATH]: `${LINUX_BOOT_ID}\n`, [LINUX_MACHINE_ID_PATH]: `${MACHINE_ID}\n` };

describe('boot identity — Linux', () => {
	it('reads the kernel boot_id, with the host name and machine id of the machine it is a boot of', async () => {
		const h = io('linux', { files: linuxFiles });
		await expect(readBootIdentity(h.io)).resolves.toEqual({
			source: 'linux-boot-id',
			value: LINUX_BOOT_ID,
			hostname: 'build-box-01',
			machineId: MACHINE_ID
		});
		expect(h.reads).toEqual([LINUX_BOOT_ID_PATH, LINUX_MACHINE_ID_PATH]);
		expect(h.runs).toEqual([]);
	});

	it('leaves the machine id out when it cannot be read', async () => {
		for (const machineId of [null, new Error('EACCES'), 'uninitialized\n']) {
			const h = io('linux', {
				files: { [LINUX_BOOT_ID_PATH]: LINUX_BOOT_ID, [LINUX_MACHINE_ID_PATH]: machineId }
			});
			await expect(readBootIdentity(h.io)).resolves.toEqual({
				source: 'linux-boot-id',
				value: LINUX_BOOT_ID,
				hostname: 'build-box-01'
			});
		}
	});

	it('is null when the boot_id is missing, unreadable or not a UUID', async () => {
		for (const bootId of [null, new Error('EACCES'), 'not-a-uuid\n', '']) {
			const h = io('linux', { files: { [LINUX_BOOT_ID_PATH]: bootId, [LINUX_MACHINE_ID_PATH]: MACHINE_ID } });
			await expect(readBootIdentity(h.io)).resolves.toBeNull();
		}
	});

	it('is null inside a container, whose boot, host name and state volume prove nothing about one machine', async () => {
		for (const marker of ['/.dockerenv', '/run/.containerenv', '/run/systemd/container']) {
			const h = io('linux', { files: linuxFiles, existing: [marker] });
			await expect(readBootIdentity(h.io)).resolves.toBeNull();
			expect(h.reads).toEqual([]);
		}
		for (const env of [{ KUBERNETES_SERVICE_HOST: '10.96.0.1' }, { container: 'podman' }] as Record<
			string,
			string
		>[]) {
			await expect(readBootIdentity(io('linux', { files: linuxFiles, env }).io)).resolves.toBeNull();
		}
		// A check that cannot answer counts as a container.
		await expect(
			readBootIdentity(io('linux', { files: linuxFiles, existing: new Error('EACCES') }).io)
		).resolves.toBeNull();
	});

	it('is null under WSL: `wsl --shutdown` is a new boot of the distro, not of the host', async () => {
		for (const release of ['5.15.167.4-microsoft-standard-WSL2', '4.4.0-19041-Microsoft']) {
			const h = io('linux', { files: linuxFiles, osRelease: () => release });
			await expect(readBootIdentity(h.io)).resolves.toBeNull();
			expect(h.reads).toEqual([]);
		}
		for (const env of [{ WSL_DISTRO_NAME: 'Ubuntu' }, { WSL_INTEROP: '/run/WSL/1_interop' }] as Record<
			string,
			string
		>[]) {
			await expect(readBootIdentity(io('linux', { files: linuxFiles, env }).io)).resolves.toBeNull();
		}
		const unreadable = () => {
			throw new Error('uname failed');
		};
		await expect(
			readBootIdentity(io('linux', { files: linuxFiles, osRelease: unreadable }).io)
		).resolves.toBeNull();
	});

	it('is null without a host name', async () => {
		await expect(readBootIdentity(io('linux', { files: linuxFiles, hostname: '  ' }).io)).resolves.toBeNull();
	});
});

describe('boot identity — macOS', () => {
	it('asks sysctl (by absolute path) for the boot session UUID', async () => {
		const h = io('darwin', { run: { stdout: `${DARWIN_UUID}\n` } });
		await expect(readBootIdentity(h.io)).resolves.toEqual({
			source: 'darwin-boot-session-uuid',
			value: DARWIN_UUID.toLowerCase(),
			hostname: 'build-box-01'
		});
		expect(h.runs).toEqual([
			{ command: DARWIN_SYSCTL_PATH, args: ['-n', 'kern.bootsessionuuid'], timeoutMs: 10_000 }
		]);
		expect(h.reads).toEqual([]);
	});

	it('is null when sysctl fails, times out, cannot start, or answers something else', async () => {
		const answers: Array<Partial<RunResult> | Error> = [
			{ code: 1, stdout: '', stderr: 'unknown oid' },
			{ code: 0, stdout: DARWIN_UUID, timedOut: true },
			{ code: 1, stdout: '', spawnError: 'ENOENT' },
			{ code: 0, stdout: '{ sec = 1794454075, usec = 0 } Thu Nov 12 03:27:55 2026' },
			new Error('spawn failed')
		];
		for (const run of answers) {
			await expect(readBootIdentity(io('darwin', { run }).io)).resolves.toBeNull();
		}
	});
});

describe('boot identity — Windows', () => {
	it('reads the BootId counter with reg.exe', async () => {
		const h = io('win32', { run: { stdout: REG_OUTPUT }, hostname: 'EVERDESK4' });
		await expect(readBootIdentity(h.io)).resolves.toEqual({
			source: 'windows-boot-id',
			value: '54',
			hostname: 'everdesk4'
		});
		expect(h.runs).toEqual([
			{ command: 'reg', args: ['query', WINDOWS_BOOT_ID_KEY, '/v', 'BootId'], timeoutMs: 10_000 }
		]);
	});

	it('is null when the value is absent, reg fails or times out', async () => {
		const answers: Array<Partial<RunResult> | Error> = [
			{
				code: 1,
				stdout: '',
				stderr: 'ERROR: The system was unable to find the specified registry key or value.'
			},
			{ code: 0, stdout: REG_OUTPUT, timedOut: true },
			{ code: 0, stdout: '    BootId    REG_SZ    54\r\n' },
			{ code: 0, stdout: '' },
			new Error('spawn failed')
		];
		for (const run of answers) {
			await expect(readBootIdentity(io('win32', { run }).io)).resolves.toBeNull();
		}
	});

	it('is null in a Kubernetes pod', async () => {
		const h = io('win32', { run: { stdout: REG_OUTPUT }, env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' } });
		await expect(readBootIdentity(h.io)).resolves.toBeNull();
		expect(h.runs).toEqual([]);
	});
});

describe('boot identity — other platforms, the machine and the probe', () => {
	it('is null, reading nothing, on a platform without a kernel boot identity', async () => {
		const h = io('freebsd', { files: linuxFiles, run: { stdout: DARWIN_UUID } });
		await expect(readBootIdentity(h.io)).resolves.toBeNull();
		expect(h.reads).toEqual([]);
		expect(h.runs).toEqual([]);
	});

	it('names the same machine only for the same host name and machine id', () => {
		const a = { source: 'linux-boot-id' as const, value: 'x', hostname: 'box', machineId: MACHINE_ID };
		expect(sameMachine(a, { ...a, value: 'y' })).toBe(true);
		expect(sameMachine(a, { ...a, hostname: 'other-box' })).toBe(false);
		expect(sameMachine(a, { ...a, machineId: 'f'.repeat(32) })).toBe(false);
		expect(sameMachine(a, { source: a.source, value: 'y', hostname: a.hostname })).toBe(false);
	});

	it('keeps an identity it read for the whole process', async () => {
		const h = io('linux', { files: linuxFiles });
		const probe = createBootIdentityProbe(h.io);
		const [first, second] = await Promise.all([probe.identity(), probe.identity()]);
		expect(second).toEqual(first);
		await expect(probe.identity()).resolves.toMatchObject({ value: LINUX_BOOT_ID });
		expect(h.reads.filter((path) => path === LINUX_BOOT_ID_PATH)).toHaveLength(1);
	});

	it('does NOT keep a failed read: the next call (the worker arming its marker) reads again', async () => {
		let attempt = 0;
		const h = io('linux', {
			files: {
				[LINUX_BOOT_ID_PATH]: () => (++attempt === 1 ? new Error('EIO while still booting') : LINUX_BOOT_ID),
				[LINUX_MACHINE_ID_PATH]: MACHINE_ID
			}
		});
		const probe = createBootIdentityProbe(h.io);

		await expect(probe.identity()).resolves.toBeNull();
		await expect(probe.identity()).resolves.toMatchObject({ source: 'linux-boot-id', value: LINUX_BOOT_ID });
		await probe.identity();
		expect(h.reads.filter((path) => path === LINUX_BOOT_ID_PATH)).toHaveLength(2);
	});

	it('reports uptime, and null for one it cannot trust', () => {
		expect(createBootIdentityProbe(io('linux', { uptimeSec: () => 41_472.9 }).io).uptimeSec()).toBe(41_472.9);
		expect(createBootIdentityProbe(io('linux', { uptimeSec: () => Number.NaN }).io).uptimeSec()).toBeNull();
		expect(createBootIdentityProbe(io('linux', { uptimeSec: () => -1 }).io).uptimeSec()).toBeNull();
		const throwing = vi.fn(() => {
			throw new Error('uv_uptime failed');
		});
		expect(createBootIdentityProbe(io('linux', { uptimeSec: throwing }).io).uptimeSec()).toBeNull();
	});
});
