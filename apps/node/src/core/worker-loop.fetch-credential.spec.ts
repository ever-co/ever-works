import { describe, expect, it, vi } from 'vitest';
import type { FleetJobFetchCredentialResponse, FleetJobView } from '@ever-works/contracts';
import { WorkerLoop, type JobLeaseCapableClient, type JobLeaseHandle } from './worker-loop';

/**
 * Scoped fetch credentials — the LEASE HANDLE's half.
 *
 * `mintFetchCredential` is the one credential call on the handle that is
 * OPTIONAL, and that is the feature's compatibility rule made into a type:
 * a publish has no version without its credential, so `mintPushCredential`
 * always exists and throws when the client cannot make the call; a fetch
 * without one is the fetch this node always ran, so a client that predates
 * the call yields a handle that simply does not carry it — and the runtime
 * then provisions exactly as before.
 */

const scheduler = { setTimeout: () => ({ scheduled: true }), clearTimeout: () => undefined };

function job(overrides: Partial<FleetJobView> = {}): FleetJobView {
	return {
		id: 'job-fetch-1',
		kind: 'acceptance-checks',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: { workspacePath: '/w', checks: [] },
		leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null,
		...overrides
	};
}

/** Runs one leased job and hands the executor's lease handle to `use`. */
async function withLeaseHandle(
	extra: Partial<JobLeaseCapableClient>,
	leased: FleetJobView,
	use: (lease: JobLeaseHandle | undefined) => Promise<void>
): Promise<void> {
	let offered = false;
	const complete = vi.fn(async () => true);
	const client = {
		lease: async () => {
			if (offered) return [];
			offered = true;
			return [leased];
		},
		heartbeat: async () => ({ ...leased, status: 'running' as const }),
		complete,
		...extra
	} as unknown as JobLeaseCapableClient;
	const loop = new WorkerLoop({ client, scheduler, leaseTtlSec: 30 });
	let failure: unknown = null;
	loop.register('acceptance-checks', async (_job, _signal, lease) => {
		try {
			await use(lease);
		} catch (error) {
			failure = error;
		}
		return { gateStatus: 'green' };
	});
	await loop.start();
	await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
	await loop.stop();
	if (failure) throw failure;
}

const answer: FleetJobFetchCredentialResponse = { credentials: [], uncovered: [] };

describe('WorkerLoop lease handle — scoped fetch credential', () => {
	it('asks for THIS run’s job at the generation THIS run holds', async () => {
		const mintFetchCredential = vi.fn(async () => answer);

		await withLeaseHandle({ mintFetchCredential }, job({ leaseGeneration: 7 }), async (lease) => {
			expect(typeof lease?.mintFetchCredential).toBe('function');
			await expect(lease?.mintFetchCredential?.()).resolves.toBe(answer);
		});

		// The id and the generation are the handle's, never the caller's: an
		// executor cannot ask for a credential against a claim it does not hold.
		expect(mintFetchCredential).toHaveBeenCalledTimes(1);
		expect(mintFetchCredential).toHaveBeenCalledWith('job-fetch-1', 7);
	});

	it('passes the client’s refusal through untouched, so the caller can tell 401 from 404 from 409', async () => {
		const refusal = Object.assign(new Error('refused'), { kind: 'unauthorized', status: 401 });

		await withLeaseHandle(
			{
				mintFetchCredential: async () => {
					throw refusal;
				}
			},
			job({ leaseGeneration: 3 }),
			async (lease) => {
				await expect(lease?.mintFetchCredential?.()).rejects.toBe(refusal);
			}
		);
	});

	it('carries NO mintFetchCredential when the client cannot make the call — the fetch falls back', async () => {
		// An embedder, or a client that predates the route. Where a publish
		// in the same position is refused, a fetch simply is not scoped.
		await withLeaseHandle({}, job({ leaseGeneration: 7 }), async (lease) => {
			expect(lease).toBeDefined();
			expect(lease?.mintFetchCredential).toBeUndefined();
			expect('mintFetchCredential' in (lease as object)).toBe(false);
			// The push half is unchanged: present, and refusing loudly.
			await expect(lease?.mintPushCredential()).rejects.toThrow(/predates the push-credential protocol/);
		});
	});
});
