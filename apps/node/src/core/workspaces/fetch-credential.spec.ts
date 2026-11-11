import { describe, expect, it, vi } from 'vitest';
import {
	FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
	FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
	FLEET_PUSH_CREDENTIAL_REVOKE_URL,
	FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
	type FleetJobFetchCredentialResponse
} from '@ever-works/contracts';
import { FleetClientError } from '../fleet-client';
import { createLogger, type LogEntry } from '../logger';
import { FetchCredentialError, FetchCredentialSession, describeFetchCredentialUnavailable } from './fetch-credential';

/**
 * Scoped FETCH credentials — the node's session (the read twin of
 * `push-credential.spec.ts`).
 *
 * What a review will look for, and what these cases pin:
 *
 *  - a credential is offered to the remote the platform scoped it to and to
 *    NO other — host included, exactly as for a push;
 *  - "no credential" is an ANSWER here, never an error: every way the
 *    platform can have nothing to give resolves to a fallback, including an
 *    API that predates the endpoint (404);
 *  - the two refusals that say the REQUEST is wrong do not fall back: 401
 *    fails the run with a reason, 409 keeps its identity;
 *  - the tokens are revoked and forgotten at dispose, and never logged.
 */

const JOB_ID = '33333333-3333-4333-8333-333333333333';
const PRIMARY = 'https://github.com/ever-works/platform.git';
const MOUNT = 'https://github.com/ever-works/template.git';
const PRIMARY_TOKEN = 'ghs_primaryReadTokenSentinel0123456789abcd';
const MOUNT_TOKEN = 'ghs_mountReadTokenSentinel0123456789abcdef';

const answer = (overrides: Partial<FleetJobFetchCredentialResponse> = {}): FleetJobFetchCredentialResponse => ({
	credentials: [
		{
			token: PRIMARY_TOKEN,
			username: 'x-access-token',
			expiresAt: '2026-11-10T20:00:00.000Z',
			repositories: ['ever-works/platform']
		}
	],
	uncovered: [],
	...overrides
});

function harness(mint: () => Promise<FleetJobFetchCredentialResponse>) {
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	const unprotect = vi.spyOn(logger, 'unprotect');
	const client = { mintFetchCredential: vi.fn(mint) };
	const revokes: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
	const session = new FetchCredentialSession({
		jobId: JOB_ID,
		client,
		logger,
		leaseGeneration: 7,
		fetchFn: async (url, init) => {
			revokes.push({ url, method: init.method, headers: init.headers });
			return { ok: true, status: 204 };
		}
	});
	return { session, client, entries, revokes, unprotect, logger };
}

const logText = (entries: LogEntry[]): string => entries.map((entry) => `${entry.level} ${entry.message}`).join('\n');

describe('FetchCredentialSession — a credential reaches the remote it was scoped to, and no other', () => {
	it('answers the scoped credential for a covered remote, keyed to that exact URL', async () => {
		const { session, client } = harness(async () => answer());

		await expect(session.credentialFor(PRIMARY)).resolves.toEqual({
			credential: { username: 'x-access-token', token: PRIMARY_TOKEN, remoteUrl: PRIMARY },
			unavailable: null
		});
		// The claim this run holds, and nothing else.
		expect(client.mintFetchCredential).toHaveBeenCalledWith(JOB_ID, 7);
	});

	it('asks the platform ONCE for the whole workspace, however many repositories ask', async () => {
		const { session, client } = harness(async () =>
			answer({
				credentials: [
					...answer().credentials,
					{
						token: MOUNT_TOKEN,
						username: 'x-access-token',
						expiresAt: '',
						repositories: ['ever-works/template']
					}
				]
			})
		);

		// Concurrently and repeatedly: one HTTPS response, one set of tokens.
		const [first, second, again] = await Promise.all([
			session.credentialFor(PRIMARY),
			session.credentialFor(MOUNT),
			session.credentialFor(PRIMARY)
		]);

		expect(client.mintFetchCredential).toHaveBeenCalledTimes(1);
		expect(first.credential?.token).toBe(PRIMARY_TOKEN);
		expect(again.credential?.token).toBe(PRIMARY_TOKEN);
		// Each repository gets ITS OWN token: the one scoped to the primary
		// is never the one offered to the mount.
		expect(second.credential).toEqual({ username: 'x-access-token', token: MOUNT_TOKEN, remoteUrl: MOUNT });
	});

	it('covers each repository that can be covered and falls back for the rest', async () => {
		const { session } = harness(async () =>
			answer({
				uncovered: [{ repository: 'ever-works/template', reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON }]
			})
		);

		const primary = await session.credentialFor(PRIMARY);
		const mount = await session.credentialFor(MOUNT);

		expect(primary.credential?.token).toBe(PRIMARY_TOKEN);
		expect(mount.credential).toBeNull();
		// The reason is one an operator can act on — and it is this module's
		// own sentence, not text the platform sent.
		expect(mount.unavailable).toContain('install the Ever Works app');
	});

	it('never offers a token to a repository the platform did not scope it to', async () => {
		// The platform answered for `platform` only and said nothing at all
		// about this one. Silence is not a credential.
		const { session } = harness(async () => answer());

		const other = await session.credentialFor('https://github.com/ever-works/some-other-repo.git');

		expect(other.credential).toBeNull();
		expect(other.unavailable).toBe(describeFetchCredentialUnavailable(undefined));
	});

	// THE HOST IS PART OF THE IDENTITY — the push slice's own lesson (its
	// review, F1/F4). Git sends an extraheader on its very first request,
	// unprompted, so a remote that merely POINTS somewhere else would be
	// handed the token. Every one of these parses to `ever-works/platform`
	// by path alone.
	it.each([
		['a different forge', 'https://gitlab.com/ever-works/platform.git'],
		['a suffix lookalike', 'https://github.com.evil.tld/ever-works/platform'],
		['a prefix lookalike', 'https://evil-github.com/ever-works/platform.git'],
		['a non-default port', 'https://github.com:8443/ever-works/platform'],
		['plain http', 'http://github.com/ever-works/platform.git'],
		['an ssh remote', 'git@github.com:ever-works/platform.git'],
		['an ssh URL', 'ssh://git@github.com/ever-works/platform.git'],
		['a URL carrying userinfo', 'https://someone@github.com/ever-works/platform.git'],
		['a URL with a query', 'https://github.com/ever-works/platform.git?x=1'],
		['a deeper path', 'https://github.com/ever-works/platform/extra.git']
	])('offers nothing to %s — and does not even ask the platform', async (_label, remoteUrl) => {
		const { session, client } = harness(async () => answer());

		const decision = await session.credentialFor(remoteUrl);

		expect(decision.credential).toBeNull();
		expect(decision.unavailable).toContain('not an https://github.com clone URL');
		// No token is caused to exist for a workspace that cannot use one.
		expect(client.mintFetchCredential).not.toHaveBeenCalled();
	});

	it('accepts the URL forms that ARE the same GitHub repository', async () => {
		const { session } = harness(async () => answer());

		for (const remoteUrl of [
			'https://github.com/ever-works/platform',
			'https://github.com/Ever-Works/Platform.git',
			'https://GitHub.com/ever-works/platform.git'
		]) {
			const decision = await session.credentialFor(remoteUrl);
			expect(decision.credential?.token).toBe(PRIMARY_TOKEN);
			// Keyed to the URL the caller will actually fetch, verbatim.
			expect(decision.credential?.remoteUrl).toBe(remoteUrl);
		}
	});
});

describe('FetchCredentialSession — fetch keeps its fallback (the one difference from push)', () => {
	it.each([
		[FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON, 'no GitHub App configured'],
		[
			FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
			'no GitHub App installation this owner controls covers this repository'
		],
		[FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON, 'GitHub declined to issue a scoped read token']
	])('resolves — never throws — when the platform answers %s', async (reason, sentence) => {
		const { session } = harness(async () =>
			answer({ credentials: [], uncovered: [{ repository: 'ever-works/platform', reason: reason as never }] })
		);

		const decision = await session.credentialFor(PRIMARY);

		expect(decision.credential).toBeNull();
		expect(decision.unavailable).toContain(sentence);
	});

	it('an API that predates the endpoint (404) is a fallback, not a failure', async () => {
		// A new node against an OLDER platform: the route does not exist and
		// Nest answers 404. The run must go on exactly as it would have.
		const { session, client, entries } = harness(async () => {
			throw new FleetClientError('invalid-request', 'Request rejected by the API (HTTP 404)', 404);
		});

		const primary = await session.credentialFor(PRIMARY);
		const mount = await session.credentialFor(MOUNT);

		expect(primary).toEqual({
			credential: null,
			unavailable: 'this platform’s API predates scoped read credentials'
		});
		expect(mount.credential).toBeNull();
		// Asked once and remembered: an older platform is not re-asked per mount.
		expect(client.mintFetchCredential).toHaveBeenCalledTimes(1);
		// Expected, so it is not a warning on every job of an older deployment.
		expect(entries.filter((entry) => entry.level === 'warn')).toEqual([]);
		expect(logText(entries)).toContain('predates the endpoint');
	});

	it.each([
		['the platform is unreachable', new FleetClientError('network', 'Could not reach https://api.ever.works')],
		['the platform answers 5xx', new FleetClientError('server', 'API error (HTTP 503)', 503)],
		[
			'the edge refuses the request',
			new FleetClientError('forbidden', 'Request was refused by the API edge (403)', 403)
		],
		['the platform rate-limits', new FleetClientError('rate-limited', 'Rate limited by the API', 429)],
		[
			'the platform rejects the body',
			new FleetClientError('invalid-request', 'Request rejected by the API (HTTP 400)', 400)
		],
		[
			'the answer is unusable',
			new FleetClientError('malformed', 'Fetch credential response did not contain a credential list')
		],
		['something else entirely breaks', new Error('socket hang up')]
	])('falls back, with a warning, when %s', async (_label, error) => {
		const { session, client, entries } = harness(async () => {
			throw error;
		});

		const decision = await session.credentialFor(PRIMARY);
		await session.credentialFor(MOUNT);

		expect(decision.credential).toBeNull();
		expect(decision.unavailable).toContain('could not be asked');
		expect(client.mintFetchCredential).toHaveBeenCalledTimes(1);
		expect(entries.some((entry) => entry.level === 'warn')).toBe(true);
		expect(logText(entries)).toContain('fetching with this machine’s own Git configuration');
	});
});

describe('FetchCredentialSession — a refusal about the REQUEST does not fall back', () => {
	it('throws, with the reason, when the platform refuses this node’s claim on the job (401)', async () => {
		// Not assigned to this node, or no longer leased/running: the
		// platform collapses both to one 401, and both mean the node must not
		// go on cloning for this job.
		const { session } = harness(async () => {
			throw new FleetClientError('unauthorized', 'The platform refused this job', 401);
		});

		const error = await session.credentialFor(PRIMARY).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(FetchCredentialError);
		expect((error as Error).message).toContain('not assigned to this node, or it is no longer active');
	});

	it('believes a client double that answers 401 without the real error class', async () => {
		const { session } = harness(async () => {
			throw Object.assign(new Error('nope'), { kind: 'unauthorized' });
		});

		await expect(session.credentialFor(PRIMARY)).rejects.toBeInstanceOf(FetchCredentialError);
	});

	it('lets a stale lease (409) through with its identity intact', async () => {
		// The worker reads `kind: 'stale-lease'` as "abort, and do not
		// report". Wrapped, a void claim would be reported as a failure.
		const stale = new FleetClientError('stale-lease', 'The platform holds a newer lease on this job', 409);
		const { session } = harness(async () => {
			throw stale;
		});

		await expect(session.credentialFor(PRIMARY)).rejects.toBe(stale);
	});

	it('does not remember a refusal as "no credential": the next repository is refused too', async () => {
		const { session, client } = harness(async () => {
			throw new FleetClientError('unauthorized', 'The platform refused this job', 401);
		});

		await expect(session.credentialFor(PRIMARY)).rejects.toBeInstanceOf(FetchCredentialError);
		await expect(session.credentialFor(MOUNT)).rejects.toBeInstanceOf(FetchCredentialError);
		expect(client.mintFetchCredential).toHaveBeenCalledTimes(2);
	});
});

describe('FetchCredentialSession — the credential is dropped when the fetch ends', () => {
	it('revokes EVERY token at GitHub and forgets it', async () => {
		const { session, revokes, unprotect } = harness(async () =>
			answer({
				credentials: [
					...answer().credentials,
					{
						token: MOUNT_TOKEN,
						username: 'x-access-token',
						expiresAt: '',
						repositories: ['ever-works/template']
					}
				]
			})
		);
		await session.credentialFor(PRIMARY);

		await session.dispose();

		expect(revokes.map((entry) => [entry.method, entry.url])).toEqual([
			['DELETE', FLEET_PUSH_CREDENTIAL_REVOKE_URL],
			['DELETE', FLEET_PUSH_CREDENTIAL_REVOKE_URL]
		]);
		expect(revokes.map((entry) => entry.headers.Authorization).sort()).toEqual(
			[`Bearer ${PRIMARY_TOKEN}`, `Bearer ${MOUNT_TOKEN}`].sort()
		);
		// Out of the redactor too, or each run would pin a live token in this
		// process's heap for the rest of its uptime.
		expect(unprotect).toHaveBeenCalledWith(PRIMARY_TOKEN);
		expect(unprotect).toHaveBeenCalledWith(MOUNT_TOKEN);
	});

	it('after dispose answers "none" — a fetch then is simply the fetch this node always ran', async () => {
		const { session, client, revokes } = harness(async () => answer());
		await session.credentialFor(PRIMARY);
		await session.dispose();

		const decision = await session.credentialFor(PRIMARY);

		expect(decision).toEqual({
			credential: null,
			unavailable: 'the scoped read credential for this run has already been released'
		});
		// Not re-minted, and not revoked twice.
		expect(client.mintFetchCredential).toHaveBeenCalledTimes(1);
		await session.dispose();
		expect(revokes).toHaveLength(1);
	});

	it('revokes nothing when nothing was ever issued', async () => {
		const { session, client, revokes } = harness(async () => answer());

		await session.dispose();

		expect(client.mintFetchCredential).not.toHaveBeenCalled();
		expect(revokes).toEqual([]);
	});

	it('revokes a mint that lands AFTER disposal instead of keeping it', async () => {
		let release!: (value: FleetJobFetchCredentialResponse) => void;
		const { session, revokes } = harness(
			() =>
				new Promise<FleetJobFetchCredentialResponse>((resolve) => {
					release = resolve;
				})
		);
		const pending = session.credentialFor(PRIMARY);
		// Yield so the session has actually issued the request.
		await Promise.resolve();
		await session.dispose();

		release(answer());
		const decision = await pending;
		await vi.waitFor(() => expect(revokes).toHaveLength(1));

		expect(decision.credential).toBeNull();
		expect(revokes[0].headers.Authorization).toBe(`Bearer ${PRIMARY_TOKEN}`);
	});

	it('a revoke that fails never fails the run', async () => {
		const client = { mintFetchCredential: async () => answer() };
		const session = new FetchCredentialSession({
			jobId: JOB_ID,
			client,
			fetchFn: async () => {
				throw new Error('api.github.com is unreachable from this network');
			}
		});
		await session.credentialFor(PRIMARY);

		await expect(session.dispose()).resolves.toBeUndefined();
	});
});

describe('FetchCredentialSession — nothing about the token is logged', () => {
	it('writes the count and the reasons, never a credential', async () => {
		// The logger is deliberately NOT told to protect anything here, so
		// this proves the session never puts a token in a message — rather
		// than proving the redactor works.
		const { session, entries } = harness(async () =>
			answer({
				uncovered: [{ repository: 'ever-works/template', reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON }]
			})
		);

		await session.credentialFor(PRIMARY);
		await session.credentialFor(MOUNT);
		session.withheld(
			'https://user:secret-in-userinfo@github.com/ever-works/platform.git',
			'reason from the provider'
		);
		await session.dispose();

		const text = logText(entries);
		expect(text).toContain('scoped read credential issued for 1 repository');
		expect(text).toContain(FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON);
		expect(text).not.toContain(PRIMARY_TOKEN);
		// A remote is named by host and path only.
		expect(text).toContain('https://github.com/ever-works/platform.git');
		expect(text).not.toContain('secret-in-userinfo');
	});

	it('scrubs a transport error through the redactor before it is logged', async () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ sink: (entry) => entries.push(entry) });
		logger.protect('node-secret-value-that-must-not-leak');
		const session = new FetchCredentialSession({
			jobId: JOB_ID,
			logger,
			client: {
				mintFetchCredential: async () => {
					throw new Error('Could not reach https://api.ever.works: node-secret-value-that-must-not-leak');
				}
			}
		});

		await session.credentialFor(PRIMARY);

		expect(logText(entries)).not.toContain('node-secret-value-that-must-not-leak');
	});
});
