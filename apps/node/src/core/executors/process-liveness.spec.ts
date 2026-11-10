import { describe, expect, it } from 'vitest';
import {
	defaultProcReader,
	isZombieProcess,
	parseProcStat,
	processGroupHasLiveMember,
	type ProcReader
} from './process-liveness';

/** `/proc/<pid>/stat` as Linux writes it: pid (comm) state ppid pgrp session ... */
function stat(pid: number, comm: string, state: string, ppid: number, pgrp: number): string {
	return `${pid} (${comm}) ${state} ${ppid} ${pgrp} ${pgrp} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n`;
}

function reader(entries: Record<string, string>, listable = true): ProcReader {
	return {
		listPids: () => (listable ? Object.keys(entries) : undefined),
		readStat: (pid) => entries[pid]
	};
}

describe('parseProcStat', () => {
	it('reads state and process group after the command name', () => {
		expect(parseProcStat(stat(4242, 'node', 'S', 1, 4240))).toEqual({ state: 'S', pgrp: 4240 });
	});

	it('survives a command name with spaces and parentheses', () => {
		expect(parseProcStat(stat(7, 'my (weird) cmd', 'Z', 1, 5))).toEqual({ state: 'Z', pgrp: 5 });
	});

	it('rejects text that is not a stat line', () => {
		expect(parseProcStat('')).toBeUndefined();
		expect(parseProcStat('4242 node S 1 4240')).toBeUndefined();
		expect(parseProcStat('4242 (node) S 1 not-a-number')).toBeUndefined();
	});
});

describe('isZombieProcess', () => {
	it('is true for an exited but unreaped process', () => {
		expect(isZombieProcess(10, reader({ '10': stat(10, 'node', 'Z', 1, 9) }))).toBe(true);
	});

	it('is false for a running or sleeping process', () => {
		expect(isZombieProcess(10, reader({ '10': stat(10, 'node', 'R', 1, 9) }))).toBe(false);
		expect(isZombieProcess(10, reader({ '10': stat(10, 'node', 'S', 1, 9) }))).toBe(false);
	});

	it('is false when /proc cannot say (another OS, or the entry is gone)', () => {
		expect(isZombieProcess(10, reader({}))).toBe(false);
	});
});

describe('processGroupHasLiveMember', () => {
	it('is false when the only members left are zombies re-parented to PID 1', () => {
		// The CI runner pod case: the shell and its child were SIGKILLed; the
		// grandchild's parent died with it, PID 1 does not reap, so it stays Z.
		const proc = reader({
			'1': stat(1, 'act', 'S', 0, 1),
			'40': stat(40, 'node', 'Z', 1, 38),
			'41': stat(41, 'node', 'Z', 1, 38),
			'99': stat(99, 'vitest', 'S', 1, 99)
		});
		expect(processGroupHasLiveMember(38, proc)).toBe(false);
	});

	it('is true while one member of the group still runs', () => {
		const proc = reader({
			'40': stat(40, 'node', 'Z', 1, 38),
			'41': stat(41, 'node', 'S', 1, 38)
		});
		expect(processGroupHasLiveMember(38, proc)).toBe(true);
	});

	it('ignores processes of other groups', () => {
		expect(processGroupHasLiveMember(38, reader({ '99': stat(99, 'node', 'R', 1, 99) }))).toBe(false);
	});

	it('skips entries that vanish between the listing and the read', () => {
		const proc: ProcReader = {
			listPids: () => ['40', '41'],
			readStat: (pid) => (pid === '41' ? stat(41, 'node', 'Z', 1, 38) : undefined)
		};
		expect(processGroupHasLiveMember(38, proc)).toBe(false);
	});

	it('is unknown when /proc cannot be listed or a stat line cannot be parsed', () => {
		expect(processGroupHasLiveMember(38, reader({}, false))).toBeUndefined();
		expect(processGroupHasLiveMember(38, reader({ '40': 'garbage' }))).toBeUndefined();
	});
});

describe('defaultProcReader', () => {
	it.runIf(process.platform !== 'linux')('reports unknown off Linux', () => {
		expect(defaultProcReader.listPids()).toBeUndefined();
		expect(defaultProcReader.readStat(String(process.pid))).toBeUndefined();
	});

	it.runIf(process.platform === 'linux')('reads this process as running, in its own group', () => {
		const own = defaultProcReader.readStat(String(process.pid));
		expect(own).toBeDefined();
		expect(parseProcStat(own!)?.state).not.toBe('Z');
		expect(defaultProcReader.listPids()).toContain(String(process.pid));
	});
});
