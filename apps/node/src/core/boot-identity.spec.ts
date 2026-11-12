import { describe, expect, it, vi } from 'vitest';
import {
	createBootIdentityProbe,
	DARWIN_SYSCTL_PATH,
	LINUX_BOOT_ID_PATH,
	readBootIdentity,
	WINDOWS_BOOT_ID_KEY,
	type BootIdentityIo
} from './boot-identity';
import type { CommandRunner } from './capabilities';

type RunResult = Awaited<ReturnType<CommandRunner['run']>>;

const LINUX_BOOT_ID = '4f3c0a52-8d1e-4b7a-9c2f-61d5e0b7a9c3';
const DARWIN_UUID = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
const REG_OUTPUT =
	'\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters\r\n' +
	'    BootId    REG_DWORD    0x36\r\n\r\n';

function io(
	platform: string,
	overrides: { file?: string | null | Error; run?: Partial<RunResult> | Error; uptimeSec?: () => number } = {}
) {
	const reads: string[] = [];
	const runs: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
	const value: BootIdentityIo = {
		platform,
		readFile: async (filePath) => {
			reads.push(filePath);
			if (overrides.file instanceof Error) throw overrides.file;
			return overrides.file === undefined ? null : overrides.file;
		},
		runner: {
			run: async (command, args, options) => {
				runs.push({ command, args, timeoutMs: options?.timeoutMs });
				if (overrides.run instanceof Error) throw overrides.run;
				return { code: 0, stdout: '', stderr: '', ...overrides.run };
			}
		},
		uptimeSec: overrides.uptimeSec ?? (() => 120)
	};
	return { io: value, reads, runs };
}

describe('boot identity — Linux', () => {
	it('reads the kernel boot_id', async () => {
		const h = io('linux', { file: `${LINUX_BOOT_ID}\n` });
		await expect(readBootIdentity(h.io)).resolves.toEqual({ source: 'linux-boot-id', value: LINUX_BOOT_ID });
		expect(h.reads).toEqual([LINUX_BOOT_ID_PATH]);
		expect(h.runs).toEqual([]);
	});

	it('is null when the file is missing, unreadable or not a UUID', async () => {
		await expect(readBootIdentity(io('linux', { file: null }).io)).resolves.toBeNull();
		await expect(readBootIdentity(io('linux', { file: new Error('EACCES') }).io)).resolves.toBeNull();
		await expect(readBootIdentity(io('linux', { file: 'not-a-uuid\n' }).io)).resolves.toBeNull();
		await expect(readBootIdentity(io('linux', { file: '' }).io)).resolves.toBeNull();
	});
});

describe('boot identity — macOS', () => {
	it('asks sysctl (by absolute path) for the boot session UUID', async () => {
		const h = io('darwin', { run: { stdout: `${DARWIN_UUID}\n` } });
		await expect(readBootIdentity(h.io)).resolves.toEqual({
			source: 'darwin-boot-session-uuid',
			value: DARWIN_UUID.toLowerCase()
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
		const h = io('win32', { run: { stdout: REG_OUTPUT } });
		await expect(readBootIdentity(h.io)).resolves.toEqual({ source: 'windows-boot-id', value: '54' });
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
});

describe('boot identity — other platforms and the probe', () => {
	it('is null, reading nothing, on a platform without a kernel boot identity', async () => {
		const h = io('freebsd', { file: LINUX_BOOT_ID, run: { stdout: DARWIN_UUID } });
		await expect(readBootIdentity(h.io)).resolves.toBeNull();
		expect(h.reads).toEqual([]);
		expect(h.runs).toEqual([]);
	});

	it('reads the identity once per process', async () => {
		const h = io('linux', { file: LINUX_BOOT_ID });
		const probe = createBootIdentityProbe(h.io);
		await probe.identity();
		await expect(probe.identity()).resolves.toEqual({ source: 'linux-boot-id', value: LINUX_BOOT_ID });
		expect(h.reads).toEqual([LINUX_BOOT_ID_PATH]);
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
