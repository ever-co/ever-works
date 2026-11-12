import { posix, win32 } from 'node:path';
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
	// that provably belongs to an EARLIER boot of THIS machine may go, and
	// nothing else may.
	const BOOT_A: BootIdentity = {
		source: 'linux-boot-id',
		value: '4f3c0a52-8d1e-4b7a-9c2f-61d5e0b7a9c3',
		hostname: 'everdesk4-vm',
		machineId: '0123456789abcdef0123456789abcdef'
	};
	const BOOT_B: BootIdentity = { ...BOOT_A, value: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' };
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

	/** The memory disk plus the rename and hard link the clearance claims with. */
	function claimingFs() {
		const h = memoryFs();
		const renames: Array<[string, string]> = [];
		const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
		h.fs.rename = async (from, to) => {
			renames.push([from, to]);
			const content = h.files.get(from);
			if (content === undefined) throw missing(from);
			h.files.delete(from);
			h.files.set(to, content);
		};
		h.fs.link = async (existing, newPath) => {
			const content = h.files.get(existing);
			if (content === undefined) throw missing(existing);
			if (h.files.has(newPath)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
			h.files.set(newPath, content);
		};
		h.fs.readDirectory = async (dirPath) =>
			[...h.files.keys()]
				.filter((path) => h.fs.dirname(path) === dirPath)
				.map((path) => path.slice(dirPath.length + 1));
		const claims = () =>
			[...h.files.keys()].filter((path) => /\.worker-session\.[^/]+\.reboot-clear$/.test(path)).sort();
		return { ...h, renames, claims };
	}

	/** A disk holding the marker a session armed at ARMED in `boot`. */
	async function armedIn(boot: BootIdentity | null) {
		const h = claimingFs();
		await bootGate(h.fs, probe(boot), ARMED, 'session-before-reboot').acquire();
		return h;
	}

	function markerWith(boot: unknown): string {
		return JSON.stringify({ version: 1, sessionId: 'other', since: new Date(ARMED).toISOString(), boot });
	}

	it('records the boot and its machine in the marker, which an older reader still parses as before', async () => {
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

	it('finds and clears a marker from an earlier boot of this machine, after which a new session acquires', async () => {
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
		// Claimed with one rename, then the claim removed: never an unlink of the marker path.
		expect(h.renames).toHaveLength(1);
		expect(h.renames[0][0]).toBe(MARKER_PATH);
		expect(h.removes).toEqual([h.renames[0][1]]);
		expect(h.claims()).toEqual([]);

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

	it("never clears ANOTHER machine's marker found in a shared config directory", async () => {
		// A roaming profile or a volume that followed a pod: the other machine's
		// session may still be running, whatever this machine's boot says.
		const otherHost = await armedIn({ ...BOOT_A, hostname: 'everdesk3' });
		await expect(bootGate(otherHost.fs, probe(BOOT_B), RESTARTED).findPreviousBootSession()).resolves.toBeNull();

		const otherMachineId = await armedIn({ ...BOOT_A, machineId: 'f'.repeat(32) });
		await expect(
			bootGate(otherMachineId.fs, probe(BOOT_B), RESTARTED).findPreviousBootSession()
		).resolves.toBeNull();

		const lostMachineId = await armedIn({ source: BOOT_A.source, value: BOOT_A.value, hostname: BOOT_A.hostname });
		await expect(
			bootGate(lostMachineId.fs, probe(BOOT_B), RESTARTED).findPreviousBootSession()
		).resolves.toBeNull();
		for (const h of [otherHost, otherMachineId, lostMachineId]) expect(h.files.has(MARKER_PATH)).toBe(true);
	});

	it('reads a boot without its machine as no boot', async () => {
		const h = claimingFs();
		h.files.set(MARKER_PATH, markerWith({ source: BOOT_A.source, value: BOOT_A.value }));
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);

		await expect(gate.findPreviousBootSession()).resolves.toBeNull();
		await expect(gate.acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/previous worker session/i) }
		});
	});

	it('keeps the quarantine for a marker that records no boot (an older node)', async () => {
		const h = claimingFs();
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
		const corrupt = claimingFs();
		corrupt.files.set(MARKER_PATH, '{"version":1,"sessionId":"torn","boot":{"source":"linux-boot-id"');
		const gate = bootGate(corrupt.fs, probe(BOOT_B), RESTARTED);
		await expect(gate.findPreviousBootSession()).resolves.toBeNull();
		await expect(gate.acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/unreadable|corrupt|incomplete/i) }
		});
		expect(corrupt.files.has(MARKER_PATH)).toBe(true);

		const unreadable = claimingFs();
		unreadable.fs.readFile = async () => {
			throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
		};
		await expect(bootGate(unreadable.fs, probe(BOOT_B), RESTARTED).findPreviousBootSession()).resolves.toBeNull();
	});

	it('reads a malformed boot as no boot: the marker still blocks and never clears itself', async () => {
		const h = claimingFs();
		h.files.set(MARKER_PATH, markerWith({ source: 'wall-clock', value: '2026-11-11T19:00:00Z', hostname: 'x' }));
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
			bootGate(
				h.fs,
				probe({ ...BOOT_A, source: 'windows-boot-id', value: '55' }),
				RESTARTED
			).findPreviousBootSession()
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

	it('two racing starts: a marker armed between the judgement and the removal survives', async () => {
		const h = await armedIn(BOOT_A);
		const slow = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const fast = bootGate(h.fs, probe(BOOT_B), RESTARTED, 'session-fast');
		const previous = await slow.findPreviousBootSession();
		expect(previous).not.toBeNull();

		// The other start clears the judged marker and its worker arms its own
		// right after the slow one's first touch of the marker in its clearance
		// (its look at the marker, or its claim): the worst moment for it.
		let raced = false;
		const race = async () => {
			raced = true;
			await fast.clearPreviousBootSession((await fast.findPreviousBootSession())!);
			await fast.acquire();
		};
		const { readFile, rename } = h.fs;
		h.fs.readFile = async (path) => {
			const content = await readFile(path);
			if (path === MARKER_PATH && !raced) await race();
			return content;
		};
		h.fs.rename = async (from, to) => {
			if (from === MARKER_PATH && !raced) await race();
			await rename!(from, to);
		};

		await slow.clearPreviousBootSession(previous!);

		expect(raced).toBe(true);
		expect(JSON.parse(h.files.get(MARKER_PATH)!).sessionId).toBe('session-fast');
		expect(h.claims()).toEqual([]);
		// And the live session can still release what it armed.
		await expect(fast.release('session-fast')).resolves.toBeUndefined();
	});

	it('a marker another start already claimed counts as cleared', async () => {
		const h = await armedIn(BOOT_A);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const previous = await gate.findPreviousBootSession();
		h.files.delete(MARKER_PATH);

		await expect(gate.clearPreviousBootSession(previous!)).resolves.toBe(true);
		expect(h.removes).toEqual([]);
	});

	it('puts a claimed live marker back by exclusive create where hard links are unsupported', async () => {
		const h = await armedIn(BOOT_A);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const previous = await gate.findPreviousBootSession();
		const live = markerWith(BOOT_B);
		h.files.set(MARKER_PATH, live);
		h.fs.link = async () => {
			throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
		};

		await expect(gate.clearPreviousBootSession(previous!)).resolves.toBe(false);
		expect(h.files.get(MARKER_PATH)).toBe(live);
		expect(h.claims()).toEqual([]);
	});

	it('keeps the claim, and says so, when a third marker appeared before the claimed one could go back', async () => {
		const h = await armedIn(BOOT_A);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const previous = await gate.findPreviousBootSession();
		const live = markerWith(BOOT_B);
		h.files.set(MARKER_PATH, live);
		const third = markerWith({ ...BOOT_B, value: 'third' });
		const link = h.fs.link!;
		h.fs.link = async (existing, newPath) => {
			h.files.set(MARKER_PATH, third);
			await link(existing, newPath);
		};

		await expect(gate.clearPreviousBootSession(previous!)).rejects.toThrow(
			/claimed during reboot clearance is kept/
		);
		expect(h.files.get(MARKER_PATH)).toBe(third);
		expect(h.claims().map((claim) => h.files.get(claim))).toEqual([live]);

		// The third session releases its marker normally; the claimed one still blocks the next worker.
		h.files.delete(MARKER_PATH);
		await expectLeftoverClaimBlocks(h);
	});

	it('leaves the marker where the filesystem cannot claim it atomically', async () => {
		const h = memoryFs();
		await bootGate(h.fs, probe(BOOT_A), ARMED).acquire();
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const previous = await gate.findPreviousBootSession();
		expect(previous).not.toBeNull();

		await expect(gate.clearPreviousBootSession(previous!)).resolves.toBe(false);
		expect(h.files.has(MARKER_PATH)).toBe(true);
		expect(h.removes).toEqual([]);
	});

	/** A claim left beside an empty marker path quarantines the next worker, and only clear-quarantine lifts it. */
	async function expectLeftoverClaimBlocks(h: ReturnType<typeof claimingFs>) {
		expect(h.files.has(MARKER_PATH)).toBe(false);
		expect(h.claims()).toHaveLength(1);
		const next = bootGate(h.fs, probe(BOOT_B), RESTARTED + 60_000, 'session-next');
		const quarantine = expect.objectContaining({
			reason: expect.stringMatching(/interrupted reboot clearance left a worker safety marker at .*reboot-clear/)
		});
		await expect(next.acquire()).resolves.toEqual({ kind: 'blocked', state: quarantine });
		await expect(next.inspect()).resolves.toEqual(quarantine);
		// A claim holding THIS boot's (a racing session's) marker is not the reboot's to clear.
		await expect(next.findPreviousBootSession()).resolves.toBeNull();
		expect(h.files.has(MARKER_PATH)).toBe(false);

		// clear-quarantine removes the leftover claim too, and the next worker acquires.
		await next.clear();
		expect(h.claims()).toEqual([]);
		await expect(next.acquire()).resolves.toEqual({ kind: 'acquired', sessionId: 'session-next' });
	}

	it('a start killed between claiming a live marker and putting it back leaves a claim that blocks', async () => {
		const h = await armedIn(BOOT_A);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const previous = await gate.findPreviousBootSession();
		// A racing start armed its marker after the judgement...
		h.files.set(MARKER_PATH, markerWith(BOOT_B));
		// ...and this one dies right before the put-back.
		h.fs.link = () => new Promise<void>(() => undefined);

		void gate.clearPreviousBootSession(previous!);
		await vi.waitFor(() => expect(h.claims()).toHaveLength(1), { timeout: 500 });

		await expectLeftoverClaimBlocks(h);
	});

	it('with no hard links and an unreadable claim, the claim stays and blocks', async () => {
		const h = await armedIn(BOOT_A);
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);
		const previous = await gate.findPreviousBootSession();
		h.files.set(MARKER_PATH, markerWith(BOOT_B));
		h.fs.link = undefined;
		const { readFile } = h.fs;
		h.fs.readFile = async (path) => {
			if (path.endsWith('.reboot-clear')) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
			return readFile(path);
		};

		await expect(gate.clearPreviousBootSession(previous!)).rejects.toThrow(
			/claimed during reboot clearance is kept/
		);
		h.fs.readFile = readFile;

		await expectLeftoverClaimBlocks(h);
	});

	it('a claim left by a clearance of an EARLIER boot is judged like the marker, and cleared', async () => {
		// Killed after claiming the previous boot's own marker: the claim holds
		// that marker, and the next start may finish the job.
		const h = claimingFs();
		const claim = `${MARKER_PATH}.0f0e0d0c-0b0a-4908-8706-050403020100.reboot-clear`;
		h.files.set(claim, markerWith(BOOT_A));
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED, 'session-after-reboot');

		const previous = await gate.findPreviousBootSession();
		expect(previous?.files).toEqual([{ path: claim, raw: markerWith(BOOT_A) }]);
		await expect(gate.clearPreviousBootSession(previous!)).resolves.toBe(true);
		expect(h.claims()).toEqual([]);
		await expect(gate.acquire()).resolves.toEqual({ kind: 'acquired', sessionId: 'session-after-reboot' });
	});

	it('clears nothing unless EVERY file is from an earlier boot of this machine', async () => {
		const h = await armedIn(BOOT_A);
		const claim = `${MARKER_PATH}.0f0e0d0c-0b0a-4908-8706-050403020100.reboot-clear`;
		h.files.set(claim, markerWith(BOOT_B));
		const gate = bootGate(h.fs, probe(BOOT_B), RESTARTED);

		await expect(gate.findPreviousBootSession()).resolves.toBeNull();
		await expect(gate.acquire()).resolves.toMatchObject({ kind: 'blocked' });
		expect(h.files.has(MARKER_PATH)).toBe(true);
		expect(h.claims()).toEqual([claim]);
	});

	it("only the marker's own claims count: temp files and other files beside it do not block", async () => {
		const h = claimingFs();
		h.files.set(`${MARKER_PATH}.1234.tmp`, 'staging');
		h.files.set(`${CONFIG_PATH}.reboot-clear`, 'not a claim');
		h.files.set(`${MARKER_PATH}.reboot-clear`, 'no uuid: not a claim');

		await expect(bootGate(h.fs, probe(BOOT_B), RESTARTED, 'fresh').acquire()).resolves.toEqual({
			kind: 'acquired',
			sessionId: 'fresh'
		});
	});
});

describe('leftover claims are found whatever the config path looks like (2026-11-12 follow-ups)', () => {
	const CLAIM_TAIL = '.worker-session.0f0e0d0c-0b0a-4908-8706-050403020100.reboot-clear';
	const LIVE = JSON.stringify({ version: 1, sessionId: 'racing', since: '2026-11-12T03:30:00.000Z' });

	/**
	 * A disk with real path semantics for `pathApi`, optionally ignoring case
	 * as NTFS and APFS do (lookups fold case; listings keep the stored name).
	 */
	function disk(pathApi: typeof posix, ignoreCase = false) {
		const fold = (path: string) => (ignoreCase ? path.toLowerCase() : path);
		const files = new Map<string, { path: string; content: string }>();
		const fs: ConfigFileSystem = {
			readFile: async (path) => files.get(fold(path))?.content ?? null,
			writeFile: async (path, content) => void files.set(fold(path), { path, content }),
			createFileExclusive: async (path, content) => {
				if (files.has(fold(path))) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
				files.set(fold(path), { path, content });
			},
			mkdir: async () => undefined,
			chmod: async () => undefined,
			restrict: async () => undefined,
			remove: async (path) => void files.delete(fold(path)),
			rename: async (from, to) => {
				const entry = files.get(fold(from));
				if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
				files.delete(fold(from));
				files.set(fold(to), { path: to, content: entry.content });
			},
			readDirectory: async (dir) =>
				[...files.values()]
					.filter((entry) => fold(pathApi.dirname(entry.path)) === fold(dir))
					.map((entry) => pathApi.basename(entry.path)),
			dirname: (path) => pathApi.dirname(path)
		};
		return {
			fs,
			has: (path: string) => files.has(fold(path)),
			put: (path: string, content: string) => fs.writeFile(path, content)
		};
	}

	function gateOn(fs: ConfigFileSystem, configPath: string, platform: string) {
		return createConfigWorkerSafetyGate(fs, configPath, { platform, createSessionId: () => 'next' });
	}

	it('a bare config file name (EVER_WORKS_NODE_CONFIG=node-config.json): the claim beside it still blocks', async () => {
		const h = disk(posix);
		await h.put(`node-config.json${CLAIM_TAIL}`, LIVE);
		const gate = gateOn(h.fs, 'node-config.json', 'linux');

		await expect(gate.acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringContaining(`node-config.json${CLAIM_TAIL}`) }
		});
		await gate.clear();
		expect(h.has(`node-config.json${CLAIM_TAIL}`)).toBe(false);
		await expect(gate.acquire()).resolves.toEqual({ kind: 'acquired', sessionId: 'next' });
	});

	it('a Windows config path: the claim beside it blocks, and clear-quarantine removes it', async () => {
		const h = disk(win32, true);
		const config = 'C:\\Users\\worker\\AppData\\Roaming\\ever-works-node\\node-config.json';
		await h.put(`${config}${CLAIM_TAIL}`, LIVE);
		const gate = gateOn(h.fs, config, 'win32');

		await expect(gate.acquire()).resolves.toMatchObject({ kind: 'blocked' });
		await gate.clear();
		await expect(gate.acquire()).resolves.toEqual({ kind: 'acquired', sessionId: 'next' });
	});

	it('Windows and macOS ignore case: a claim made under a differently-cased config path still blocks', async () => {
		for (const [pathApi, platform, madeUnder, configPath] of [
			[
				win32,
				'win32',
				'C:\\Users\\Worker\\AppData\\Roaming\\ever-works-node\\Node-Config.json',
				'c:\\users\\worker\\appdata\\roaming\\ever-works-node\\node-config.json'
			],
			[
				posix,
				'darwin',
				'/Users/worker/.config/ever-works-node/NODE-CONFIG.json',
				'/Users/worker/.config/ever-works-node/node-config.json'
			]
		] as const) {
			const h = disk(pathApi, true);
			await h.put(`${madeUnder}${CLAIM_TAIL}`, LIVE);
			const gate = gateOn(h.fs, configPath, platform);

			await expect(gate.inspect()).resolves.toMatchObject({
				reason: expect.stringMatching(/interrupted reboot clearance/)
			});
			await expect(gate.acquire()).resolves.toMatchObject({ kind: 'blocked' });
			await gate.clear();
			expect(h.has(`${madeUnder}${CLAIM_TAIL}`)).toBe(false);
		}
	});

	it("Linux file systems keep case: a differently-cased file is another config's file, not this one's", async () => {
		const h = disk(posix);
		await h.put(`/srv/ever-works-node/NODE-CONFIG.json${CLAIM_TAIL}`, LIVE);

		await expect(gateOn(h.fs, '/srv/ever-works-node/node-config.json', 'linux').acquire()).resolves.toEqual({
			kind: 'acquired',
			sessionId: 'next'
		});
	});
});
