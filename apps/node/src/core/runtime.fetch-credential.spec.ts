import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_PUSH_CREDENTIAL_REVOKE_URL } from '@ever-works/contracts';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike } from './fleet-client';
import { createLogger, type LogEntry } from './logger';
import type { NodeConfig } from './types';

/**
 * The join between the lease and the SCOPED FETCH CREDENTIAL — the read
 * twin of the "agent-task scoped push credential" block in
 * `runtime.spec.ts`, kept in its own file so the two can change apart.
 *
 * The whole production wiring lives in one closure in `runtime.ts`:
 * creating the session from the lease, handing it to `provision`, and
 * disposing it when `provision` returns. Each of these mutations leaves the
 * session and provisioner specs green and is caught only here:
 *
 *   1. not passing `{ fetchCredentials }` to `provision` — every private
 *      repository on a fenced node is unclonable again, silently;
 *   2. dropping the `finally` — every run leaves live read tokens for the
 *      owner's repositories un-revoked, and alive while the model runs;
 *   3. adding a field to the request — an older API then answers 400 and,
 *      depending on how that is read, breaks runs that work today.
 */

const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';
const JOB_ID = 'job-fetch-1';
const LEASED_AT = Date.parse('2026-11-10T09:00:00.000Z');
const REPO_URL = 'https://github.com/ever-works/platform.git';
const FETCH_TOKEN = 'ghs_runtimeWiringFetchToken0123456789abcde';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

const runner: CommandRunner = {
	run: async (command) =>
		command === 'git' ? { code: 0, stdout: 'git version 2.4', stderr: '' } : { code: 127, stdout: '', stderr: '' }
};

interface FetchHarness {
	/** In the order they happened. */
	events: string[];
	/** What `provision` was called with, per call. */
	provisionArgs: unknown[][];
	/** What the session answered for the repository, per call. */
	decisions: unknown[];
	/** Every body the node POSTed to the fetch-credential route. */
	credentialRequests: Array<{ url: string; body: Record<string, unknown> }>;
	revokes: Array<{ url: string; authorization: string | undefined }>;
	completedBodies: Record<string, unknown>[];
	logs: LogEntry[];
}

/**
 * Runs ONE leased `agent-task` through the real runtime with the executor
 * stubbed to call `provisionWorkspace`, a provisioner double that asks the
 * provider it was handed, and the REAL `FetchCredentialSession` over the
 * REAL job client — so what is asserted is the production path end to end,
 * short of git itself.
 */
async function withFetchSession(options: {
	credentialAnswer: { status: number; body: unknown };
	provisionThrows?: Error;
}): Promise<FetchHarness> {
	const harness: FetchHarness = {
		events: [],
		provisionArgs: [],
		decisions: [],
		credentialRequests: [],
		revokes: [],
		completedBodies: [],
		logs: []
	};
	let leased = false;
	const job = {
		id: JOB_ID,
		kind: 'agent-task',
		status: 'leased',
		nodeId: NODE_ID,
		requiredCapabilities: [],
		payload: { taskId: 'task-fetch', steps: [] },
		leaseExpiresAt: new Date(LEASED_AT + 60_000).toISOString(),
		leaseGeneration: 4,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
	const fetchFn: FetchLike = async (url, init) => {
		if (url.endsWith('/api/fleet/jobs/lease')) {
			const jobs = leased ? [] : [job];
			leased = true;
			return { ok: true, status: 200, text: async () => JSON.stringify({ jobs }) };
		}
		if (url.endsWith('/heartbeat')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ ok: true, job: { ...job, status: 'running' } })
			};
		}
		if (url.endsWith('/fetch-credential')) {
			harness.credentialRequests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
			return {
				ok: options.credentialAnswer.status < 400,
				status: options.credentialAnswer.status,
				text: async () => JSON.stringify(options.credentialAnswer.body)
			};
		}
		if (url.endsWith('/complete')) {
			harness.completedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, job: {} }) };
		}
		throw new Error(`unexpected request: ${url}`);
	};
	// The session revokes through the global `fetch`. Stubbed, so this spec
	// never reaches GitHub — and so the revoke itself can be asserted.
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
			harness.revokes.push({ url: String(url), authorization: init?.headers?.Authorization });
			harness.events.push('revoke');
			return { ok: true, status: 204 };
		})
	);

	vi.resetModules();
	vi.doMock('./executors/agent-task', async () => ({
		// Everything the real module exports, so a new import in `runtime.ts`
		// cannot silently stop this stub from running (see the note on the
		// same mock in `runtime.spec.ts`), with the executor replaced.
		...(await vi.importActual<Record<string, unknown>>('./executors/agent-task')),
		runAgentTaskJob: async (_job: unknown, agentIo: Record<string, unknown>) => {
			const provisionWorkspace = agentIo.provisionWorkspace as (
				taskId: string,
				spec: unknown,
				signal?: AbortSignal
			) => Promise<unknown>;
			await provisionWorkspace('task-fetch', {
				repositoryId: 'ever-works/platform',
				repoUrl: REPO_URL,
				baseRef: 'main',
				branch: 'task/x'
			});
			// The model step would start here.
			harness.events.push('provisionWorkspace:returned');
			return {};
		}
	}));
	try {
		const { FetchCredentialSession } = await import('./workspaces/fetch-credential');
		const realDispose = FetchCredentialSession.prototype.dispose;
		vi.spyOn(FetchCredentialSession.prototype, 'dispose').mockImplementation(async function (
			this: InstanceType<typeof FetchCredentialSession>
		) {
			harness.events.push('dispose:start');
			await realDispose.call(this);
			harness.events.push('dispose:end');
		});

		const { createNodeRuntime } = await import('./runtime');
		const logger = createLogger({ sink: (entry) => harness.logs.push(entry) });
		const config: NodeConfig = {
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		};
		const runtime = createNodeRuntime(
			config,
			{
				fetchFn,
				runner,
				environment,
				logger,
				version: '0.1.0',
				scheduler: { setTimeout: () => ({ scheduled: true }), clearTimeout: () => undefined },
				now: () => LEASED_AT,
				monotonicNow: () => LEASED_AT
			},
			{
				workerEnabled: true,
				workspaceProvisioner: {
					provision: async (...args: unknown[]) => {
						harness.provisionArgs.push(args);
						harness.events.push('provision:start');
						const provider = (
							args[3] as
								| { fetchCredentials?: { credentialFor(url: string): Promise<unknown> } }
								| undefined
						)?.fetchCredentials;
						if (provider) harness.decisions.push(await provider.credentialFor(REPO_URL));
						harness.events.push('provision:end');
						if (options.provisionThrows) throw options.provisionThrows;
						return { path: '/w', repositoryId: 'ever-works/platform' };
					}
				} as never
			}
		);
		await runtime.worker?.start();
		await runtime.worker?.drained();
		await runtime.worker?.stop();
	} finally {
		vi.restoreAllMocks();
		vi.resetModules();
	}
	return harness;
}

const covered = {
	status: 200,
	body: {
		credentials: [
			{
				token: FETCH_TOKEN,
				username: 'x-access-token',
				expiresAt: '2026-11-10T10:00:00.000Z',
				repositories: ['ever-works/platform']
			}
		],
		uncovered: []
	}
};

describe('createNodeRuntime — agent-task scoped fetch credential', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('hands provision a fetch-credential provider backed by THIS job’s lease', async () => {
		// Mutation 1 above.
		const harness = await withFetchSession({ credentialAnswer: covered });

		expect(harness.provisionArgs).toHaveLength(1);
		const [taskId, spec, , provisionOptions] = harness.provisionArgs[0];
		expect(taskId).toBe('task-fetch');
		expect(spec).toMatchObject({ repoUrl: REPO_URL });
		expect(
			typeof (provisionOptions as { fetchCredentials?: { credentialFor?: unknown } }).fetchCredentials
				?.credentialFor
		).toBe('function');
		// And it works: the platform's answer reaches the provisioner as a
		// credential keyed to the repository's own URL.
		expect(harness.decisions).toEqual([
			{ credential: { username: 'x-access-token', token: FETCH_TOKEN, remoteUrl: REPO_URL }, unavailable: null }
		]);
	});

	it('asks with the claim and NOTHING else — a body an older API cannot reject', async () => {
		// Mutation 3 above. The global ValidationPipe runs `whitelist` +
		// `forbidNonWhitelisted`, so this is an EXACT object.
		const harness = await withFetchSession({ credentialAnswer: covered });

		expect(harness.credentialRequests).toHaveLength(1);
		expect(harness.credentialRequests[0].url).toBe(
			`https://api.ever.works/api/fleet/jobs/${JOB_ID}/fetch-credential`
		);
		expect(harness.credentialRequests[0].body).toEqual({ nodeId: NODE_ID, secret: SECRET, leaseGeneration: 4 });
	});

	it('revokes and drops the credential BEFORE provisionWorkspace returns — before the model can start', async () => {
		// Mutation 2 above, success path.
		const harness = await withFetchSession({ credentialAnswer: covered });

		expect(harness.events).toEqual([
			'provision:start',
			'provision:end',
			'dispose:start',
			'revoke',
			'dispose:end',
			'provisionWorkspace:returned'
		]);
		expect(harness.revokes).toEqual([
			{ url: FLEET_PUSH_CREDENTIAL_REVOKE_URL, authorization: `Bearer ${FETCH_TOKEN}` }
		]);
		expect(harness.completedBodies).toHaveLength(1);
		expect(harness.completedBodies[0].success).toBe(true);
	});

	it('revokes and drops it when provisioning THROWS', async () => {
		// Mutation 2 above, failure path: a failed fetch, a refused claim and
		// a cancel all leave through the same `finally`.
		const harness = await withFetchSession({
			credentialAnswer: covered,
			provisionThrows: new Error('Git fetch or workspace provisioning failed')
		});

		expect(harness.events).toEqual(['provision:start', 'provision:end', 'dispose:start', 'revoke', 'dispose:end']);
		expect(harness.revokes).toHaveLength(1);
		// Disposal does not swallow the failure.
		expect(harness.completedBodies).toHaveLength(1);
		expect(harness.completedBodies[0].success).toBe(false);
	});

	it('an API that predates the route (404) does NOT fail the run', async () => {
		const harness = await withFetchSession({
			credentialAnswer: {
				status: 404,
				body: { message: `Cannot POST /api/fleet/jobs/${JOB_ID}/fetch-credential` }
			}
		});

		// The provider answered "none", the provision went ahead, and the run
		// reported success — exactly what an older node does on that API.
		expect(harness.decisions).toEqual([
			{ credential: null, unavailable: 'this platform’s API predates scoped read credentials' }
		]);
		expect(harness.completedBodies).toHaveLength(1);
		expect(harness.completedBodies[0].success).toBe(true);
		// Nothing was minted, so there is nothing to revoke.
		expect(harness.revokes).toEqual([]);
	});

	it('never writes the token to a log line', async () => {
		const harness = await withFetchSession({ credentialAnswer: covered });

		const text = harness.logs.map((entry) => entry.message).join('\n');
		expect(text).toContain('scoped read credential issued for 1 repository');
		expect(text).not.toContain(FETCH_TOKEN);
	});
});
