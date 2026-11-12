import { randomUUID } from 'node:crypto';
import { publishFileExclusively } from './atomic-state-file';
import {
	BOOT_IDENTITY_SOURCES,
	normalizeHostname,
	sameMachine,
	type BootIdentity,
	type BootIdentityProbe
} from './boot-identity';
import { CONFIG_FILE_MODE, supportsAtomicWrites, type ConfigFileSystem } from './config-store';

const MARKER_VERSION = 1;

interface WorkerSessionMarker {
	version: typeof MARKER_VERSION;
	sessionId: string;
	since: string;
	/**
	 * The machine boot the session armed the marker in (2026-11-12). Optional
	 * and unversioned on purpose: an older node reads such a marker as before,
	 * and a marker without it (an older node's, or one armed while the boot
	 * could not be read) never clears itself.
	 */
	boot?: BootIdentity;
}

export interface WorkerSafetyState {
	since: string;
	reason: string;
}

export type WorkerSafetyAcquisition =
	| { kind: 'acquired'; sessionId: string }
	| { kind: 'blocked'; state: WorkerSafetyState };

export interface WorkerSafetyGate {
	acquire(): Promise<WorkerSafetyAcquisition>;
	release(sessionId: string): Promise<void>;
	inspect(): Promise<WorkerSafetyState | null>;
	/** Operator-confirmed removal; callers must verify the process tree first. */
	clear(): Promise<void>;
}

/**
 * An unreleased marker armed in an EARLIER boot of this machine: the reboot
 * since then ended every process tree that session started.
 */
export interface PreviousBootSession {
	/** When that session armed the marker. */
	since: string;
	/** When the current boot began (now minus uptime). */
	bootedAt: string;
	previousBoot: BootIdentity;
	currentBoot: BootIdentity;
	/** The exact marker bytes this verdict is about; clearance removes nothing else. */
	raw: string;
}

/** The config-backed gate, plus the reboot clearance only `start` uses. */
export interface ConfigWorkerSafetyGate extends WorkerSafetyGate {
	/**
	 * The unreleased marker when it PROVABLY belongs to an earlier boot of
	 * THIS machine, else null. Proof needs both: the marker records a boot
	 * of the same machine (host name, and machine id where there is one) and
	 * of the same kind, whose value differs from this boot's; and this boot
	 * began after the marker was armed (now minus uptime is later than its
	 * `since`). No marker, a corrupt or unreadable one, one without a boot (an
	 * older node), another machine's, the same boot (a crash or a restart), or
	 * a boot that cannot be read (always so in a container): null, and the
	 * quarantine stands. Never rejects.
	 */
	findPreviousBootSession(): Promise<PreviousBootSession | null>;
	/**
	 * Remove exactly the marker `findPreviousBootSession` judged: it is claimed
	 * with one atomic rename and removed only if the claimed bytes are the
	 * judged ones; anything else is put back. True when the judged marker is
	 * gone; false when it was not the marker on disk (nothing removed).
	 */
	clearPreviousBootSession(session: PreviousBootSession): Promise<boolean>;
}

export interface ConfigWorkerSafetyGateOptions {
	platform?: string;
	now?: () => number;
	createSessionId?: () => string;
	/** Records this boot in the marker and recognises a marker from an earlier one. Absent: neither. */
	bootIdentity?: BootIdentityProbe;
}

export class WorkerSafetyPrerequisiteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerSafetyPrerequisiteError';
	}
}

/** Deliberately adjacent to the config so a service restart finds the same guard. */
export function workerSafetyMarkerPath(configPath: string): string {
	return `${configPath}.worker-session`;
}

/**
 * Write-ahead crash guard for a worker process lifetime.
 *
 * Presence means a previous/current worker may own an unverified child tree.
 * The marker is created with exclusive-create before the first lease and is
 * removed only after a safe drain by the exact session that created it.
 */
export function createConfigWorkerSafetyGate(
	fs: ConfigFileSystem,
	configPath: string,
	options: ConfigWorkerSafetyGateOptions = {}
): ConfigWorkerSafetyGate {
	const markerPath = workerSafetyMarkerPath(configPath);
	const now = options.now ?? (() => Date.now());
	const createSessionId = options.createSessionId ?? randomUUID;
	const bootIdentity = async (): Promise<BootIdentity | null> => {
		try {
			return (await options.bootIdentity?.identity()) ?? null;
		} catch {
			return null;
		}
	};

	/**
	 * Put a claimed marker back at the marker path; false when the claim is
	 * gone (nothing to restore). Both ways refuse to replace a marker that
	 * appeared there meanwhile; when neither works the claim is KEPT (the
	 * caller does not remove it) and the failure is reported.
	 */
	const putBack = async (claim: string, content: string | null): Promise<boolean> => {
		if (fs.link) {
			try {
				await fs.link(claim, markerPath);
				return true;
			} catch (error) {
				if (errorCode(error) === 'ENOENT') return false;
				if (errorCode(error) === 'EEXIST') {
					throw prerequisite(`a worker safety marker claimed during reboot clearance is kept at ${claim}`);
				}
				// Hard links unsupported here: the exclusive create below.
			}
		}
		if (content === null || !fs.createFileExclusive) {
			throw prerequisite(`a worker safety marker claimed during reboot clearance is kept at ${claim}`);
		}
		try {
			await fs.createFileExclusive(markerPath, content);
		} catch (error) {
			throw prerequisite(
				`a worker safety marker claimed during reboot clearance is kept at ${claim}: ${detail(error)}`
			);
		}
		return true;
	};

	const readRaw = async (): Promise<string | null> => {
		try {
			return await fs.readFile(markerPath);
		} catch (error) {
			throw prerequisite(`cannot read worker safety marker: ${detail(error)}`);
		}
	};

	const inspect = async (): Promise<WorkerSafetyState | null> => {
		const raw = await readRaw();
		return raw === null ? null : blockedState(raw, now());
	};

	return {
		async acquire(): Promise<WorkerSafetyAcquisition> {
			const existing = await readRaw();
			if (existing !== null) return { kind: 'blocked', state: blockedState(existing, now()) };
			if (!fs.createFileExclusive) {
				throw prerequisite('filesystem does not provide atomic exclusive marker creation');
			}

			await fs.mkdir(fs.dirname(markerPath));
			const boot = await bootIdentity();
			const marker: WorkerSessionMarker = {
				version: MARKER_VERSION,
				sessionId: createSessionId(),
				since: new Date(now()).toISOString()
			};
			if (boot) marker.boot = boot;
			try {
				await publishMarker(fs, markerPath, `${JSON.stringify(marker)}\n`, options.platform);
			} catch (error) {
				// Exclusive creation may have made the final directory entry and
				// then crashed mid-write. Any resulting bytes (including zero) are
				// a durable fail-closed marker, never permission to retry work.
				const afterFailure = await readRaw();
				if (afterFailure !== null) {
					return { kind: 'blocked', state: blockedState(afterFailure, now()) };
				}
				throw prerequisite(`could not durably arm worker safety marker: ${detail(error)}`);
			}

			try {
				if (options.platform === 'win32') {
					if (!fs.restrict) throw new Error('owner-only Windows ACL support is unavailable');
					await fs.restrict(markerPath);
				} else {
					await fs.chmod(markerPath, CONFIG_FILE_MODE);
				}
			} catch (error) {
				// Never remove it here. A retry must observe the already-created
				// marker and stay blocked until an operator verifies and clears it.
				//
				// Boot-probe retry: the real `restrict` already retried a TIMED-OUT `icacls`
				// (growing deadlines, bounded) before rejecting, so reaching this
				// line means either a genuine refusal or a timeout on every
				// attempt. Both still fail closed; the message says which (a
				// timeout's reads `probe timed out: …`).
				throw prerequisite(`worker safety marker is not proven owner-only: ${detail(error)}`);
			}

			return { kind: 'acquired', sessionId: marker.sessionId };
		},

		async release(sessionId: string): Promise<void> {
			const raw = await readRaw();
			const marker = raw === null ? null : parseMarker(raw);
			if (!marker || marker.sessionId !== sessionId) {
				throw prerequisite('worker session does not own the durable safety marker');
			}
			if (!fs.remove) throw prerequisite('filesystem cannot remove the durable safety marker');
			await fs.remove(markerPath);
			if ((await readRaw()) !== null) {
				throw prerequisite('worker safety marker still exists after safe-session release');
			}
		},

		inspect,

		async clear(): Promise<void> {
			if ((await readRaw()) === null) return;
			if (!fs.remove) throw prerequisite('filesystem cannot clear the durable safety marker');
			await fs.remove(markerPath);
			if ((await readRaw()) !== null) {
				throw prerequisite('worker safety marker still exists after explicit clearance');
			}
		},

		async findPreviousBootSession(): Promise<PreviousBootSession | null> {
			let raw: string | null;
			try {
				raw = await readRaw();
			} catch {
				return null;
			}
			const marker = raw === null ? null : parseMarker(raw);
			if (raw === null || !marker?.boot) return null;
			const current = await bootIdentity();
			// A different boot proves a reboot only of the SAME machine: a config
			// directory another machine also uses (a roaming profile, a moved
			// volume) may hold that machine's live marker.
			if (
				!current ||
				current.source !== marker.boot.source ||
				!sameMachine(current, marker.boot) ||
				current.value === marker.boot.value
			) {
				return null;
			}
			// Second, independent proof: this boot began AFTER the marker was
			// armed. A boot identity that moved without a reboot (a counter
			// touched on resume, say) cannot clear a quarantine on its own.
			let uptimeSec: number | null;
			try {
				uptimeSec = options.bootIdentity?.uptimeSec() ?? null;
			} catch {
				uptimeSec = null;
			}
			if (uptimeSec === null || !Number.isFinite(uptimeSec) || uptimeSec < 0) return null;
			const bootedAtMs = now() - uptimeSec * 1000;
			if (!Number.isFinite(bootedAtMs) || !(bootedAtMs > Date.parse(marker.since))) return null;
			return {
				since: marker.since,
				bootedAt: new Date(bootedAtMs).toISOString(),
				previousBoot: marker.boot,
				currentBoot: current,
				raw
			};
		},

		async clearPreviousBootSession(session: PreviousBootSession): Promise<boolean> {
			// CLAIM the marker with one atomic rename, then look at what was
			// claimed. A read followed by an unlink is two steps, and a second
			// `start` racing this one could arm its own marker in between; the
			// unlink would then remove a LIVE marker. After the rename, the
			// marker path is never written by this function except to put back
			// a marker that turned out not to be the one judged.
			const { rename, remove } = fs;
			if (!rename || !remove) return false; // Cannot claim atomically: leave it (fail-closed).
			const claim = `${markerPath}.${randomUUID()}.reboot-clear`;
			try {
				await rename(markerPath, claim);
			} catch (error) {
				if (errorCode(error) === 'ENOENT') return true; // Already gone: another start cleared it.
				throw prerequisite(`could not claim the worker safety marker for reboot clearance: ${detail(error)}`);
			}
			let claimed: string | null;
			try {
				claimed = await fs.readFile(claim);
			} catch {
				claimed = null;
			}
			if (claimed === session.raw) {
				await remove(claim);
				return true;
			}
			// Not the marker that was judged (a racing start armed it after the
			// judged one went): put it back, and only then drop the claim.
			if (await putBack(claim, claimed)) await remove(claim);
			return false;
		}
	};
}

/**
 * Arm the marker COMPLETE or not at all (2026-10-28).
 *
 * It is armed before the first lease, so a kill while it is being written
 * means no work ran. Created in place, such a kill left an empty or torn
 * marker, which reads (correctly, since nothing can tell it apart from a
 * damaged one) as a quarantine an operator has to clear. So the marker is
 * staged in a flushed temp file and hard-linked into place: a link, unlike
 * a rename, refuses an existing target, so two workers racing still agree
 * on one owner (the loser sees `EEXIST` and reads the winner's marker).
 *
 * A filesystem that refuses the hard link (FAT, some network shares) falls
 * back to the exclusive in-place create, which keeps the fail-closed
 * behaviour above for its rare torn write.
 */
async function publishMarker(
	fs: ConfigFileSystem,
	markerPath: string,
	content: string,
	platform: string | undefined
): Promise<void> {
	const link = fs.link;
	if (supportsAtomicWrites(fs) && typeof link === 'function') {
		// Only a refusal of the LINK itself falls back. A failure while staging
		// the temp file (disk full, I/O error) is reported as it is: retrying it
		// as an in-place create is exactly the torn write this avoids.
		let linkError: unknown = null;
		const ops = {
			...fs,
			link: async (existing: string, newPath: string): Promise<void> => {
				try {
					await link(existing, newPath);
				} catch (error) {
					linkError = error;
					throw error;
				}
			}
		};
		try {
			await publishFileExclusively(ops, markerPath, content, { platform });
			return;
		} catch (error) {
			if (error !== linkError || errorCode(error) === 'EEXIST') throw error;
		}
	}
	// Still exclusive: a marker that appeared meanwhile makes this reject with EEXIST.
	await fs.createFileExclusive!(markerPath, content);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
}

function parseMarker(raw: string): WorkerSessionMarker | null {
	try {
		const candidate = JSON.parse(raw) as Partial<WorkerSessionMarker>;
		if (
			candidate.version !== MARKER_VERSION ||
			typeof candidate.sessionId !== 'string' ||
			!candidate.sessionId ||
			typeof candidate.since !== 'string' ||
			!Number.isFinite(Date.parse(candidate.since))
		) {
			return null;
		}
		const marker: WorkerSessionMarker = {
			version: MARKER_VERSION,
			sessionId: candidate.sessionId,
			since: new Date(candidate.since).toISOString()
		};
		// A malformed boot reads as no boot: the marker still blocks, and it
		// never clears itself.
		const boot = parseBoot(candidate.boot);
		if (boot) marker.boot = boot;
		return marker;
	} catch {
		return null;
	}
}

/** A boot without its machine proves nothing: it reads as no boot at all. */
function parseBoot(candidate: unknown): BootIdentity | null {
	if (!candidate || typeof candidate !== 'object') return null;
	const { source, value, hostname, machineId } = candidate as Partial<Record<keyof BootIdentity, unknown>>;
	if (typeof source !== 'string' || !BOOT_IDENTITY_SOURCES.includes(source as BootIdentity['source'])) return null;
	if (typeof value !== 'string' || !value || value.length > 200) return null;
	const host = normalizeHostname(hostname);
	if (!host || host !== hostname) return null;
	const boot: BootIdentity = { source: source as BootIdentity['source'], value, hostname: host };
	if (machineId !== undefined) {
		if (typeof machineId !== 'string' || !machineId || machineId.length > 200) return null;
		boot.machineId = machineId;
	}
	return boot;
}

function blockedState(raw: string, now: number): WorkerSafetyState {
	const marker = parseMarker(raw);
	if (!marker) {
		return {
			since: new Date(now).toISOString(),
			reason: 'Worker safety marker is unreadable, corrupt, or incomplete; verify every prior process tree and explicitly clear quarantine'
		};
	}
	return {
		since: marker.since,
		reason: 'Previous worker session did not release its safety marker; verify every prior process tree and explicitly clear quarantine'
	};
}

function prerequisite(message: string): WorkerSafetyPrerequisiteError {
	return new WorkerSafetyPrerequisiteError(`Worker safety prerequisite failed: ${message}`);
}

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
