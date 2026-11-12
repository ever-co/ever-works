import { describe, expect, it, vi } from 'vitest';
import { killableDisk, type DiskOp } from './__fixtures__/killable-disk';
import type { BootIdentity, BootIdentityProbe } from './boot-identity';
import type { ConfigFileSystem } from './config-store';
import { createConfigWorkerSafetyGate, workerSafetyMarkerPath } from './worker-safety-store';

const CONFIG_PATH = 'C:/Users/worker/AppData/Roaming/ever-works-node/node-config.json';
const MARKER_PATH = `${CONFIG_PATH}.worker-session`;

function memoryFs() {
	const files = new Map<string, string>();
	const creates: string[] = [];
	const removes: string[] = [];
	const restrictions: string[] = [];
	let createFailure: 'none' | 'before' | 'partial' = 'none';

	const fs: ConfigFileSystem = {
		readFile: async (filePath) => files.get(filePath) ?? null,
		writeFile: async (filePath, content) => void files.set(filePath, content),
		createFileExclusive: async (filePath, content) => {
			creates.push(filePath);
			if (files.has(filePath)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
			if (createFailure === 'before') throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
			if (createFailure === 'partial') {
				files.set(filePath, '');
				throw Object.assign(new Error('crash during marker write'), { code: 'EIO' });
			}
			files.set(filePath, content);
		},
		mkdir: async () => undefined,
		chmod: async () => undefined,
		restrict: async (filePath) => void restrictions.push(filePath),
		remove: async (filePath) => {
			removes.push(filePath);
			files.delete(filePath);
		},
		dirname: (filePath) => filePath.replace(/[\\/][^\\/]*$/, '')
	};

	return {
		fs,
		files,
		creates,
		removes,
		restrictions,
		failCreate: (failure: typeof createFailure) => (createFailure = failure)
	};
}

function gate(fs: ConfigFileSystem, sessionId: string) {
	return createConfigWorkerSafetyGate(fs, CONFIG_PATH, {
		platform: 'win32',
		now: () => Date.parse('2026-08-22T23:45:00.000Z'),
		createSessionId: () => sessionId
	});
}

describe('config-backed worker safety gate', () => {
	it('atomically arms an owner-only marker before work and blocks a reconstructed worker', async () => {
		const h = memoryFs();
		const first = gate(h.fs, 'session-first');

		await expect(first.acquire()).resolves.toEqual({ kind: 'acquired', sessionId: 'session-first' });
		expect(h.creates).toEqual([MARKER_PATH]);
		expect(h.restrictions).toEqual([MARKER_PATH]);
		expect(h.files.get(MARKER_PATH)).toContain('session-first');

		await expect(gate(h.fs, 'session-second').acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/previous worker session/i) }
		});
		expect(h.creates).toEqual([MARKER_PATH]);
	});

	it('treats corrupt and partially-written markers as durable quarantine', async () => {
		const corrupt = memoryFs();
		corrupt.files.set(MARKER_PATH, '{partial');
		await expect(gate(corrupt.fs, 'never-created').acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/unreadable|corrupt|incomplete/i) }
		});
		expect(corrupt.creates).toEqual([]);

		const partial = memoryFs();
		partial.failCreate('partial');
		await expect(gate(partial.fs, 'partial-session').acquire()).resolves.toMatchObject({
			kind: 'blocked'
		});
		expect(partial.files.has(MARKER_PATH)).toBe(true);
	});

	it('fails before leasing when exclusive durable marker creation cannot be proven', async () => {
		const h = memoryFs();
		h.failCreate('before');

		await expect(gate(h.fs, 'not-durable').acquire()).rejects.toThrow(/durably arm|safety prerequisite/i);
		expect(h.files.has(MARKER_PATH)).toBe(false);
	});

	it('releases only the exact owning session and supports explicit operator clearance', async () => {
		const h = memoryFs();
		const owner = gate(h.fs, 'owner-session');
		await owner.acquire();

		await expect(owner.release('different-session')).rejects.toThrow(/does not own/i);
		expect(h.files.has(MARKER_PATH)).toBe(true);
		await expect(owner.release('owner-session')).resolves.toBeUndefined();
		expect(h.files.has(MARKER_PATH)).toBe(false);

		h.files.set(MARKER_PATH, 'crash-partial');
		await expect(owner.clear()).resolves.toBeUndefined();
		expect(h.files.has(MARKER_PATH)).toBe(false);
		expect(h.removes).toEqual([MARKER_PATH, MARKER_PATH]);
	});

	it('leaves the marker fail-closed if owner-only restriction fails', async () => {
		const h = memoryFs();
		h.fs.restrict = vi.fn(async () => {
			throw new Error('ACL update failed');
		});

		await expect(gate(h.fs, 'acl-session').acquire()).rejects.toThrow(/owner-only|ACL update failed/i);
		expect(h.files.has(workerSafetyMarkerPath(CONFIG_PATH))).toBe(true);
		await expect(gate(h.fs, 'retry-session').acquire()).resolves.toMatchObject({ kind: 'blocked' });
	});
});

describe('the worker-session marker is published atomically (2026-10-28)', () => {
	// The marker is armed before the first lease, so a kill while it is being
	// written means no work ran. A half-written marker used to quarantine the
	// node anyway (fail-closed on unreadable bytes) until an operator cleared
	// it; now it is complete when it appears, or it is not there at all.
	const markerContent = (op: DiskOp): boolean => op.content?.includes('session-killed') === true;

	it('a kill while the marker is being written leaves NO marker, so the next start acquires', async () => {
		const h = killableDisk();
		h.killAt((op) => (markerContent(op) ? 'partial' : null));

		void gate(h.fs, 'session-killed').acquire();
		await vi.waitFor(() => expect(h.killed).toBe(true), { timeout: 500 });

		expect(h.files.has(MARKER_PATH)).toBe(false);
		const restarted = killableDisk({}, { files: h.files });
		await expect(gate(restarted.fs, 'session-next').acquire()).resolves.toEqual({
			kind: 'acquired',
			sessionId: 'session-next'
		});
		expect(restarted.files.get(MARKER_PATH)).toContain('session-next');
	});

	it('links a complete, flushed temp file into place exclusively, then proves the marker owner-only', async () => {
		const h = killableDisk();

		await expect(gate(h.fs, 'session-first').acquire()).resolves.toEqual({
			kind: 'acquired',
			sessionId: 'session-first'
		});

		const ops = h.ops.filter((op) => op.op !== 'mkdir').map((op) => [op.op, op.to ?? op.path]);
		const temp = h.ops.find((op) => op.op === 'create')!.path;
		expect(temp.startsWith(`${MARKER_PATH}.`) && temp.endsWith('.tmp')).toBe(true);
		expect(ops).toEqual([
			['create', temp],
			['write', temp],
			['link', MARKER_PATH],
			['remove', temp],
			['restrict', MARKER_PATH]
		]);
		expect(h.files.get(MARKER_PATH)).toContain('session-first');
		expect(h.acl.get(MARKER_PATH)).toBe('owner-only');
		expect(h.temps()).toEqual([]);
	});

	it('a marker another worker published first blocks this one, and the temp is cleaned up', async () => {
		const h = killableDisk();
		await gate(h.fs, 'session-other').acquire();
		// The race: this worker read "no marker" just before the other one linked it.
		let firstRead = true;
		const racing: ConfigFileSystem = {
			...h.fs,
			readFile: async (path) => {
				if (firstRead && path === MARKER_PATH) {
					firstRead = false;
					return null;
				}
				return h.files.get(path) ?? null;
			}
		};

		await expect(gate(racing, 'session-raced').acquire()).resolves.toMatchObject({ kind: 'blocked' });
		expect(h.files.get(MARKER_PATH)).toContain('session-other');
		expect(h.temps()).toEqual([]);
	});

	it('falls back to the direct exclusive create where hard links are unsupported', async () => {
		const h = killableDisk();
		h.failLinks('ENOTSUP');

		await expect(gate(h.fs, 'session-fat').acquire()).resolves.toEqual({
			kind: 'acquired',
			sessionId: 'session-fat'
		});
		expect(h.files.get(MARKER_PATH)).toContain('session-fat');
		expect(h.ops.some((op) => op.op === 'create' && op.path === MARKER_PATH)).toBe(true);
		expect(h.temps()).toEqual([]);
	});
});

describe('a quarantine a reboot left behind (2026-11-12)', () => {
	// A crash leaves the marker on purpose: the dead session's process tree may
	// still run. A reboot ends every process of the previous boot, so a marker
	// that provably belongs to an EARLIER boot may go, and nothing else may.
	const BOOT_A: BootIdentity = { source: 'linux-boot-id', value: '4f3c0a52-8d1e-4b7a-9c2f-61d5e0b7a9c3' };
	const BOOT_B: BootIdentity = { source: 'linux-boot-id', value: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
	const ARMED = Date.parse('2026-11-11T20:00:00.000Z');
	const RESTARTED = Date.parse('2026-11-12T03:30:00.000Z');

	function probe(identity: BootIdentity | null | Error, uptimeSec: number | null = 120): BootIdentityProbe {
		return {
			identity: async () => {
				if (identity instanceof Error) throw identity;
				return identity;
			},
			uptimeSec: () => uptimeSec
		};
	}

	function bootGate(fs: ConfigFileSystem, bootIdentity: BootIdentityProbe, at: number, sessionId = 'session') {
		return createConfigWorkerSafetyGate(fs, CONFIG_PATH, {
			platform: 'win32',
			now: () => at,
			createSessionId: () => sessionId,
			bootIdentity
		});
	}

	/** A memory disk holding the marker a session armed at ARMED in `boot`. */
	async function armedIn(boot: BootIdentity | null) {
		const h = memoryFs();
		await bootGate(h.fs, probe(boot), ARMED, 'session-before-reboot').acquire();
		return h;
	}

	it('records the boot in the marker, which an older reader still parses as before', async () => {
		const h = await armedIn(BOOT_A);
		const marker = JSON.parse(h.files.get(MARKER_PATH)!);
		expect(marker).toEqual({
			version: 1,
			sessionId: 'session-before-reboot',
			since: new Date(ARMED).toISOString(),
			boot: BOOT_A
		});
		// The owning session still releases it: the extra field changes nothing.
		await expect(bootGate(h.fs, probe(BOOT_A), ARMED).release('session-before-reboot')).resolves.toBeUndefined();
		expect(h.files.has(MARKER_PATH)).toBe(false);
	});

	it('records no boot when it cannot be read', async () => {
		const unreadable = await armedIn(null);
		expect(JSON.parse(unreadable.files.get(MARKER_PATH)!)).not.toHaveProperty('boot');

		const throwing = memoryFs();
		await bootGate(throwing.fs, probe(new Error('sysctl hung')), ARMED).acquire();
		expect(JSON.parse(throwing.files.get(MARKER_PATH)!)).not.toHaveProperty('boot');
	});

	it('finds and clears a marker from an earlier boot, after which a new session acquires', async () => {
		const h = await armedIn(BOOT_A);
		const afterReboot = bootGate(h.fs, probe(BOOT_B, 120), RESTARTED, 'session-after-reboot');

		const previous = await afterReboot.findPreviousBootSession();
		expect(previous).toMatchObject({
			since: new Date(ARMED).toISOString(),
			bootedAt: new Date(RESTARTED - 120_000).toISOString(),
			previousBoot: BOOT_A,
			currentBoot: BOOT_B
		});
		await expect(afterReboot.clearPreviousBootSession(previous!)).resolves.toBe(true);
		expect(h.files.has(MARKER_PATH)).toBe(false);
		expect(h.removes).toEqual([MARKER_PATH]);

		await expect(afterReboot.acquire()).resolves.toEqual({ kind: 'acquired', sessionId: 'session-after-reboot' });
		expect(JSON.parse(h.files.get(MARKER_PATH)!).boot).toEqual(BOOT_B);
	});

	it('keeps the quarantine for a crash or restart within the SAME boot', async () => {
		const h = await armedIn(BOOT_A);
		const sameBoot = bootGate(h.fs, probe(BOOT_A, 9_000), RESTARTED);

		await expect(sameBoot.findPreviousBootSession()).resolves.toBeNull();
		await expect(sameBoot.acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/previous worker session/i) }
		});
		expect(h.removes).toEqual([]);
	});

	it('keeps the quarantine for a marker that records no boot (an older node)', async () => {
		const h = memoryFs();
		h.files.set(
			MARKER_PATH,
			JSON.stringify({ version: 1, sessionId: 'legacy', since: new Date(ARMED).toISOString() })
		);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);

		await expect(gate.findPreviousBootSession()).resolves.toBeNull();
		await expect(gate.acquire()).resolves.toMatchObject({ kind: 'blocked' });
		expect(h.files.has(MARKER_PATH)).toBe(true);
	});

	it('keeps the quarantine for a corrupt or unreadable marker', async () => {
		const corrupt = memoryFs();
		corrupt.files.set(MARKER_PATH, '{"version":1,"sessionId":"torn","boot":{"source":"linux-boot-id"');
		const gate = bootGate(corrupt.fs, probe(BOOT_B), RESTARTED);
		await expect(gate.findPreviousBootSession()).resolves.toBeNull();
		await expect(gate.acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/unreadable|corrupt|incomplete/i) }
		});
		expect(corrupt.files.has(MARKER_PATH)).toBe(true);

		const unreadable = memoryFs();
		unreadable.fs.readFile = async () => {
			throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
		};
		await expect(bootGate(unreadable.fs, probe(BOOT_B), RESTARTED).findPreviousBootSession()).resolves.toBeNull();
	});

	it('reads a malformed boot as no boot: the marker still blocks and never clears itself', async () => {
		const h = memoryFs();
		h.files.set(
			MARKER_PATH,
			JSON.stringify({
				version: 1,
				sessionId: 'odd-boot',
				since: new Date(ARMED).toISOString(),
				boot: { source: 'wall-clock', value: '2026-11-11T19:00:00Z' }
			})
		);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);

		await expect(gate.findPreviousBootSession()).resolves.toBeNull();
		await expect(gate.acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/previous worker session/i) }
		});
	});

	it('keeps the quarantine when the current boot cannot be read or is of another kind', async () => {
		const h = await armedIn(BOOT_A);
		await expect(bootGate(h.fs, probe(null), RESTARTED).findPreviousBootSession()).resolves.toBeNull();
		await expect(
			bootGate(h.fs, probe(new Error('reg.exe timed out')), RESTARTED).findPreviousBootSession()
		).resolves.toBeNull();
		await expect(
			bootGate(h.fs, probe({ source: 'windows-boot-id', value: '55' }), RESTARTED).findPreviousBootSession()
		).resolves.toBeNull();
		expect(h.files.has(MARKER_PATH)).toBe(true);
	});

	it('needs the uptime to agree: this boot must have begun AFTER the marker was armed', async () => {
		const h = await armedIn(BOOT_A);
		// The identity moved, but the uptime says this boot began before the
		// marker was armed: no reboot is proven, so nothing clears.
		const longUptime = (RESTARTED - ARMED) / 1000 + 60;
		await expect(
			bootGate(h.fs, probe(BOOT_B, longUptime), RESTARTED).findPreviousBootSession()
		).resolves.toBeNull();
		await expect(bootGate(h.fs, probe(BOOT_B, null), RESTARTED).findPreviousBootSession()).resolves.toBeNull();
		expect(h.files.has(MARKER_PATH)).toBe(true);
	});

	it('removes only the bytes it judged: a marker armed meanwhile stays', async () => {
		const h = await armedIn(BOOT_A);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const previous = await gate.findPreviousBootSession();
		expect(previous).not.toBeNull();

		// Another start cleared it and armed its own marker in this boot first.
		const live = JSON.stringify({
			version: 1,
			sessionId: 'live',
			since: new Date(RESTARTED).toISOString(),
			boot: BOOT_B
		});
		h.files.set(MARKER_PATH, live);

		await expect(gate.clearPreviousBootSession(previous!)).resolves.toBe(false);
		expect(h.files.get(MARKER_PATH)).toBe(live);
		expect(h.removes).toEqual([]);
	});
});
