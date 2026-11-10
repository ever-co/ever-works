import { readdirSync, readFileSync } from 'fs';

/**
 * Zombie-aware liveness for the command runner's process-tree terminator.
 *
 * `kill(pid, 0)` and `kill(-pgid, 0)` succeed for a zombie: a process that has
 * exited but that its parent has not reaped yet. When the terminator SIGKILLs a
 * detached group, a grandchild whose parent died with it is re-parented to
 * PID 1. Where PID 1 does not reap orphans (a container without an init, such
 * as the in-cluster CI runner pod), that grandchild stays a zombie in the group
 * for as long as the pod lives. The group then never answers ESRCH, the
 * terminator gives up after its deadline, and a cancelled job reads as a tree
 * that "could not be terminated". A zombie runs no code and holds nothing but
 * its process-table entry, so it counts as gone here.
 *
 * Only Linux exposes the state this needs (`/proc/<pid>/stat`). Everywhere else
 * the reader reports "unknown" and the callers keep the plain `kill(2)` answer.
 */
export interface ProcReader {
	/** Numeric `/proc` entries, or `undefined` when `/proc` cannot be listed. */
	listPids(): string[] | undefined;
	/** Raw `/proc/<pid>/stat`, or `undefined` when the process is gone or unreadable. */
	readStat(pid: string): string | undefined;
}

export interface ProcStat {
	/** One-letter state: R, S, D, Z, T, t, X, I, ... */
	state: string;
	/** Process group id. */
	pgrp: number;
}

/**
 * Parse the fields this module needs from `/proc/<pid>/stat`. The command name
 * sits in parentheses and may itself contain spaces and parentheses, so the
 * fixed fields are read after the LAST `)`: `state ppid pgrp ...`.
 */
export function parseProcStat(stat: string): ProcStat | undefined {
	const end = stat.lastIndexOf(')');
	if (end < 0) return undefined;
	const fields = stat
		.slice(end + 1)
		.trim()
		.split(/\s+/);
	const [state, , pgrpField] = fields;
	const pgrp = Number(pgrpField);
	if (!state || !Number.isSafeInteger(pgrp)) return undefined;
	return { state, pgrp };
}

/** True when `/proc` says this pid is a zombie (`Z`) or dead (`X`); false when it runs or is unknown. */
export function isZombieProcess(pid: number, reader: ProcReader = defaultProcReader): boolean {
	const stat = reader.readStat(String(pid));
	if (stat === undefined) return false;
	const parsed = parseProcStat(stat);
	return parsed !== undefined && isTerminatedState(parsed.state);
}

/**
 * Whether any member of process group `pgid` still runs. `false` when every
 * member is a zombie (or none is left), `true` when one runs, and `undefined`
 * when `/proc` cannot answer: the caller then keeps its `kill(2)` result.
 */
export function processGroupHasLiveMember(pgid: number, reader: ProcReader = defaultProcReader): boolean | undefined {
	const pids = reader.listPids();
	if (pids === undefined) return undefined;
	for (const pid of pids) {
		const stat = reader.readStat(pid);
		if (stat === undefined) continue;
		const parsed = parseProcStat(stat);
		if (parsed === undefined) return undefined;
		if (parsed.pgrp === pgid && !isTerminatedState(parsed.state)) return true;
	}
	return false;
}

function isTerminatedState(state: string): boolean {
	return state === 'Z' || state === 'X' || state === 'x';
}

export const defaultProcReader: ProcReader = {
	listPids() {
		if (process.platform !== 'linux') return undefined;
		try {
			return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
		} catch {
			return undefined;
		}
	},
	readStat(pid) {
		if (process.platform !== 'linux') return undefined;
		try {
			return readFileSync(`/proc/${pid}/stat`, 'utf8');
		} catch {
			return undefined;
		}
	}
};
