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
 * What an interrupted reboot clearance leaves behind (2026-11-12).
 *
 * The clearance first MOVES the marker to `<marker>.<uuid>.reboot-clear` (one
 * atomic rename) and only then looks at it, so a kill or a failure between
 * that move and the end leaves the marker under that name. Nothing else ever
 * writes such a name, and `acquire()`, `inspect()` and `clear()` treat it
 * exactly like the marker itself: an interrupted clearance fails closed.
 */
const CLAIM_SUFFIX = '.reboot-clear';

/** One file a reboot verdict covers: the marker, or a claim an interrupted clearance left. */
export interface PreviousBootFile {
	path: string;
	/** The exact bytes judged; clearance removes nothing else. */
	raw: string;
}

/**
 * Every worker-safety file found (the marker, and any claim an interrupted
 * clearance left) when EACH was armed in an EARLIER boot of this machine: the
 * reboot since then ended every process tree those sessions started.
 */
export interface PreviousBootSession {
	/** When the (first) judged session armed its marker. */
	since: string;
	/** When the current boot began (now minus uptime). */
	bootedAt: string;
	previousBoot: BootIdentity;
	currentBoot: BootIdentity;
	/** The marker first, then any leftover claims. */
	files: PreviousBootFile[];
}

/** The config-backed gate, plus the reboot clearance only `start` uses. */
export interface ConfigWorkerSafetyGate extends WorkerSafetyGate {
	/**
	 * The verdict when EVERY worker-safety file (the marker, and any claim an
	 * interrupted clearance left) PROVABLY belongs to an earlier boot of THIS
	 * machine, else null. Proof needs, for each file: a boot of the same
	 * machine (host name, and machine id where there is one) and of the same
	 * kind, whose value differs from this boot's; and this boot began after
	 * that file's session armed it (now minus uptime is later than its
	 * `since`). Nothing found, any file corrupt, unreadable, without a boot (an
	 * older node), another machine's or from this boot (a crash, a restart, a
	 * racing start), or a boot that cannot be read (always so in a container):
	 * null, and the quarantine stands. Never rejects.
	 */
	findPreviousBootSession(): Promise<PreviousBootSession | null>;
	/**
	 * Remove the files `findPreviousBootSession` judged, and nothing else.
	 *
	 * The marker is first claimed with one atomic rename, so a marker a racing
	 * start arms after the judgement is never unlinked; the claim is removed
	 * only if it holds the judged bytes, and anything else is put back (hard
	 * link, else exclusive create, never over a marker that appeared since).
	 * When that cannot finish (this process is killed, or the put-back is
	 * refused because yet another marker appeared) the claim stays beside the
	 * marker path, where `acquire()` and `inspect()` see it as a quarantine: a
	 * racing session's marker is never lost, though it may then take an
	 * explicit `clear-quarantine`.
	 *
	 * True when every judged file is gone; false when the marker on disk was
	 * not the judged one (nothing removed). Rejects on a filesystem failure,
	 * which always leaves the marker or its claim in place. A filesystem that
	 * cannot rename, remove and list (so could not find a claim again) clears
	 * nothing: false.
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
	const markerDir = fs.dirname(markerPath);
	const markerName = markerPath.slice(markerDir.length).replace(/^[\\/]+/, '');
	const separator = markerPath.charAt(markerDir.length) === '\\' ? '\\' : '/';
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
	 * caller does not remove it, and it still blocks) and the failure is
	 * reported.
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

	/** Claims an interrupted reboot clearance left beside the marker. */
	const leftoverClaims = async (): Promise<string[]> => {
		if (!fs.readDirectory) return [];
		let names: string[];
		try {
			names = await fs.readDirectory(markerDir);
		} catch (error) {
			throw prerequisite(`cannot list the worker safety marker's directory: ${detail(error)}`);
		}
		return names
			.filter(
				(name) =>
					name.startsWith(`${markerName}.`) &&
					name.endsWith(CLAIM_SUFFIX) &&
					name.length > markerName.length + 1 + CLAIM_SUFFIX.length
			)
			.sort()
			.map((name) => `${markerDir}${separator}${name}`);
	};

	/** The quarantine a leftover claim imposes, or null when there is none. */
	const leftoverClaimState = async (): Promise<WorkerSafetyState | null> => {
		const [claim] = await leftoverClaims();
		if (!claim) return null;
		let raw: string | null;
		try {
			raw = await fs.readFile(claim);
		} catch {
			raw = null;
		}
		const marker = raw === null ? null : parseMarker(raw);
		return {
			since: marker?.since ?? new Date(now()).toISOString(),
			reason: `An interrupted reboot clearance left a worker safety marker at ${claim}; verify every prior process tree and explicitly clear quarantine`
		};
	};

	const inspect = async (): Promise<WorkerSafetyState | null> => {
		const raw = await readRaw();
		if (raw !== null) return blockedState(raw, now());
		return leftoverClaimState();
	};

	/** Whether `marker` was armed in an earlier boot of this machine than `current` (booted at `bootedAtMs`). */
	const fromEarlierBoot = (
		marker: WorkerSessionMarker | null,
		current: BootIdentity,
		bootedAtMs: number
	): marker is WorkerSessionMarker & { boot: BootIdentity } =>
		!!marker?.boot &&
		// A different boot proves a reboot only of the SAME machine: a config
		// directory another machine also uses (a roaming profile, a moved
		// volume) may hold that machine's live marker.
		current.source === marker.boot.source &&
		sameMachine(current, marker.boot) &&
		current.value !== marker.boot.value &&
		// Second, independent proof: this boot began AFTER the marker was
		// armed. A boot identity that moved without a reboot (a counter
		// touched on resume, say) cannot clear a quarantine on its own.
		bootedAtMs > Date.parse(marker.since);

	return {
		async acquire(): Promise<WorkerSafetyAcquisition> {
			const existing = await readRaw();
			if (existing !== null) return { kind: 'blocked', state: blockedState(existing, now()) };
			const leftover = await leftoverClaimState();
			if (leftover) return { kind: 'blocked', state: leftover };
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
			// The marker, and any claim an interrupted reboot clearance left.
			const claims = await leftoverClaims();
			if ((await readRaw()) === null && claims.length === 0) return;
			if (!fs.remove) throw prerequisite('filesystem cannot clear the durable safety marker');
			await fs.remove(markerPath);
			for (const claim of claims) await fs.remove(claim);
			if ((await readRaw()) !== null || (await leftoverClaims()).length > 0) {
				throw prerequisite('worker safety marker still exists after explicit clearance');
			}
		},

		async findPreviousBootSession(): Promise<PreviousBootSession | null> {
			const files: PreviousBootFile[] = [];
			try {
				const raw = await readRaw();
				if (raw !== null) files.push({ path: markerPath, raw });
				for (const claim of await leftoverClaims()) {
					const content = await fs.readFile(claim);
					if (content !== null) files.push({ path: claim, raw: content });
				}
			} catch {
				return null;
			}
			if (files.length === 0) return null;
			const current = await bootIdentity();
			if (!current) return null;
			let uptimeSec: number | null;
			try {
				uptimeSec = options.bootIdentity?.uptimeSec() ?? null;
			} catch {
				uptimeSec = null;
			}
			if (uptimeSec === null || !Number.isFinite(uptimeSec) || uptimeSec < 0) return null;
			const bootedAtMs = now() - uptimeSec * 1000;
			if (!Number.isFinite(bootedAtMs)) return null;
			const judged: Array<WorkerSessionMarker & { boot: BootIdentity }> = [];
			for (const file of files) {
				const marker = parseMarker(file.raw);
				if (!fromEarlierBoot(marker, current, bootedAtMs)) return null;
				judged.push(marker);
			}
			return {
				since: judged[0].since,
				bootedAt: new Date(bootedAtMs).toISOString(),
				previousBoot: judged[0].boot,
				currentBoot: current,
				files
			};
		},

		async clearPreviousBootSession(session: PreviousBootSession): Promise<boolean> {
			const { rename, remove, readDirectory } = fs;
			if (!rename || !remove || !readDirectory) return false; // Leave everything (fail-closed).
			let allGone = true;
			for (const file of session.files) {
				if (file.path !== markerPath) {
					// A leftover claim. A claim name is never reused and nothing
					// else writes one, so its bytes cannot change under us.
					let content: string | null;
					try {
						content = await fs.readFile(file.path);
					} catch (error) {
						throw prerequisite(`cannot read ${file.path}: ${detail(error)}`);
					}
					if (content === null) continue; // Another start finished it.
					if (content !== file.raw) {
						allGone = false;
						continue;
					}
					await remove(file.path);
					continue;
				}
				// The marker: CLAIM it with one atomic rename, then look at what was
				// claimed. A read followed by an unlink would let a racing start arm
				// its own marker in between, and the unlink would remove it.
				const claim = `${markerPath}.${randomUUID()}${CLAIM_SUFFIX}`;
				try {
					await rename(markerPath, claim);
				} catch (error) {
					if (errorCode(error) === 'ENOENT') continue; // Already gone: another start cleared it.
					throw prerequisite(
						`could not claim the worker safety marker for reboot clearance: ${detail(error)}`
					);
				}
				let claimed: string | null;
				try {
					claimed = await fs.readFile(claim);
				} catch {
					claimed = null;
				}
				if (claimed === file.raw) {
					await remove(claim);
					continue;
				}
				// Not the marker that was judged (a racing start armed it after the
				// judged one went): put it back, and only then drop the claim.
				if (await putBack(claim, claimed)) await remove(claim);
				allGone = false;
			}
			return allGone;
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
