import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import type { Scheduler } from './heartbeat';
import { WorkerLoop, type JobLeaseCapableClient } from './worker-loop';

/**
 * The lease gate (`WorkerLoopOptions.leaseGate`): a lane that must not ask for
 * work right now — the local-AI lane with no provider up — makes no lease call
 * at all, says why, keeps ticking, and leases again the moment it opens. A
 * gate that throws is closed.
 */

function manualScheduler(): Scheduler & { runNext(): void; pending: number } {
	const queue: Array<{ id: number; callback: () => void }> = [];
	let nextId = 1;
	return {
		get pending(): number {
			return queue.length;
		},
		setTimeout(callback: () => void): unknown {
			const id = nextId++;
			queue.push({ id, callback });
			return id;
		},
		clearTimeout(handle: unknown): void {
			const index = queue.findIndex((entry) => entry.id === handle);
			if (index >= 0) queue.splice(index, 1);
		},
		runNext(): void {
			queue.shift()?.callback();
		}
	};
}

function job(): FleetJobView {
	return {
		id: 'job-1',
		kind: 'ai-completion',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: {},
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

function client(jobs: FleetJobView[][]): JobLeaseCapableClient & { leaseCalls: number } {
	let index = 0;
	const value = {
		get leaseCalls(): number {
			return index;
		},
		lease: async () => jobs[Math.min(index++, jobs.length - 1)] ?? [],
		heartbeat: vi.fn(async () => null),
		complete: vi.fn(async () => true)
	};
	return value as never;
}

describe('WorkerLoop — the lease gate', () => {
	it('makes no lease call while the gate is closed, and leases once it opens', async () => {
		let reason: string | null = 'no local AI provider is up';
		const lease = client([[job()], []]);
		const scheduler = manualScheduler();
		const loop = new WorkerLoop({ client: lease, scheduler, leaseGate: () => reason });
		const run = vi.fn(async () => ({ ok: true }));
		loop.register('ai-completion', run);

		await loop.start();
		expect(lease.leaseCalls).toBe(0);
		expect(loop.getState()).toMatchObject({ state: 'throttled', throttleReason: 'no local AI provider is up' });
		expect(scheduler.pending).toBe(1);

		reason = null;
		scheduler.runNext();
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
		expect(lease.leaseCalls).toBeGreaterThanOrEqual(1);
		expect(loop.getState().throttleReason).toBeNull();
		await loop.stop();
	});

	it('reads a gate that throws as closed', async () => {
		const lease = client([[job()]]);
		const loop = new WorkerLoop({
			client: lease,
			scheduler: manualScheduler(),
			leaseGate: () => {
				throw new Error('monitor unavailable');
			}
		});
		await loop.start();
		expect(lease.leaseCalls).toBe(0);
		expect(loop.getState().throttleReason).toBe('lease gate failed: monitor unavailable');
		await loop.stop();
	});

	it('changes nothing for a loop without a gate', async () => {
		const lease = client([[]]);
		const loop = new WorkerLoop({ client: lease, scheduler: manualScheduler() });
		await loop.start();
		expect(lease.leaseCalls).toBe(1);
		expect(loop.getState().throttleReason ?? null).toBeNull();
		await loop.stop();
	});
});
