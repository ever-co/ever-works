import {
	FLEET_JOB_STALE_LEASE_REASON,
	FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
	FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
	FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
	FLEET_PUSH_CREDENTIAL_USERNAME,
	fleetPushRemoteRepositoryId,
	type FleetJobFetchCredentialResponse
} from '@ever-works/contracts';
import type { Logger } from '../logger';
import { revokeScopedCredential, type PushCredentialFetch } from './push-credential';

/**
 * The node half of scoped FETCH credentials — the read twin of
 * `push-credential.ts`, and the "separate change" that file's sibling left
 * the fetch for.
 *
 * ## The gap
 *
 * A fleet node pushed with a repository-scoped installation token and still
 * CLONED with the machine's own Git credential helper. A node that is a
 * fenced VM has no Git credential at all, by design, so a job on a private
 * repository could not clone — even though the Ever Works GitHub App was
 * installed on it and the push would have worked.
 *
 * ## Where the credential lives, at every instant
 *
 * platform response → ONE private field on the session below →
 * `logger.protect()` → the `fetchCredential` object handed to a single
 * `provision` call of the repository it names → the environment of that
 * provision's `git fetch` children → gone.
 *
 * Never on the payload, never on disk, never in argv, never in a remote URL
 * or a Git config file, never in the model's environment and never in a log
 * line — the same list `push-credential.ts` keeps, by the same mechanism.
 *
 * ## It does not outlive the fetch
 *
 * The push credential is minted LATE (at finalize) so it never coexists
 * with the model. This one is needed EARLY (a clone comes first), so it
 * gets the mirror-image guarantee: the session is created for one
 * `provision` and disposed the moment that call returns, successful or
 * not. The tokens are revoked at GitHub and dropped from this process
 * BEFORE the model's first byte, so here too there is no instant at which
 * an untrusted process and the credential exist together.
 *
 * ## The ONE difference from push: fetch keeps its fallback
 *
 * `push-credential.ts` has no fallback, and says why: the only other way
 * to authenticate a push is the long-lived machine helper the slice exists
 * to stop using, so "degrade gracefully" would mean "change nothing".
 *
 * A fetch is the opposite case. It never needed a scoped credential to be
 * correct: a public repository clones without one, and a machine whose
 * operator configured a helper works on a repository the App is not
 * installed on. Refusing those would break runs that work today and close
 * no hole. So when there is no scoped credential for a repository, this
 * module answers "none" and the node fetches EXACTLY as it did before —
 * same command, same environment, nothing added:
 *
 *  - the platform has none to give (no App configured, no installation of
 *    this owner's covers the repository, a public repository on an account
 *    without the App, GitHub declined the mint);
 *  - the platform does not have the endpoint at all (an older API: `404`);
 *  - the platform could not be asked (network, `5xx`, rate limit) or its
 *    answer was unusable;
 *  - the repository is not an `https://github.com` URL, which a GitHub App
 *    token cannot authenticate anyway.
 *
 * What is NOT a fallback is a refusal that says the REQUEST is wrong. The
 * platform answers `401` when this node does not hold an active claim on
 * the job (not assigned to it, or no longer leased/running) and `409` when
 * the lease generation is stale. Neither falls back: a node that carried on
 * cloning after being told the job is not its own would be working on a
 * claim it does not have. A `401` fails the run with the reason; a `409` is
 * rethrown untouched, so the worker reads it as it does everywhere else —
 * abort, and do not report.
 *
 * ## What this does not cover
 *
 * The workspace reaper (`workspace-inventory.ts`) still reaches a remote
 * with the machine's own Git configuration. This credential is issued PER
 * JOB, against a lease, and the reaper runs outside any job. On a machine
 * with no Git credential it therefore cannot ask a private repository's
 * remote anything, its rule answers "unknown", and unknown means keep.
 */
export interface FetchCredentialClient {
	mintFetchCredential(jobId: string, leaseGeneration?: number): Promise<FleetJobFetchCredentialResponse>;
}

/** The scoped read credential, as one provision consumes it. */
export interface ScopedFetchCredential {
	readonly username: string;
	readonly token: string;
	/** The remote it is for, verbatim — the header is keyed to it. */
	readonly remoteUrl: string;
}

/** What the session decided for one remote. Exactly one field is non-null. */
export interface FetchCredentialDecision {
	readonly credential: ScopedFetchCredential | null;
	/**
	 * When there is no credential: why, as a clause an operator can act on.
	 * Authored here — never text the platform or a repository supplied.
	 */
	readonly unavailable: string | null;
}

/**
 * What {@link FleetTaskWorkspaceProvisioner} depends on, so the provisioner
 * needs no knowledge of the job channel and a test can drive every outcome
 * without a network.
 */
export interface FetchCredentialProvider {
	/**
	 * The scoped read credential for ONE remote, or the reason there is none.
	 *
	 * RESOLVES for every fallback (see the module header) and THROWS only
	 * for a refused claim ({@link FetchCredentialError}) or a stale lease
	 * (the client's own error, identity intact).
	 */
	credentialFor(remoteUrl: string): Promise<FetchCredentialDecision>;
	/** Told when a credential it issued was not handed to Git after all. */
	withheld?(remoteUrl: string, reason: string): void;
}

/**
 * Raised when this run may not fetch because the platform refused the
 * node's claim on the job. Its message is what the operator reads on the
 * Task, so it says why.
 */
export class FetchCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FetchCredentialError';
	}
}

export interface FetchCredentialSessionOptions {
	jobId: string;
	client: FetchCredentialClient;
	logger?: Logger;
	/** The claim generation this run holds; refused server-side when stale. */
	leaseGeneration?: number;
	/** Injected so the revoke is testable without a network. */
	fetchFn?: PushCredentialFetch;
}

type Loaded =
	| { readonly response: FleetJobFetchCredentialResponse; readonly fallback: null }
	| { readonly response: null; readonly fallback: string };

/**
 * One operator-readable clause per stable token the platform answers with.
 * The tokens are the push route's own: the conditions are the same
 * conditions, decided by the same resolver.
 */
export function describeFetchCredentialUnavailable(reason: string | undefined): string {
	switch (reason) {
		case FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON:
			return 'this deployment has no GitHub App configured';
		case FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON:
			return "no GitHub App installation this owner controls covers this repository (install the Ever Works app on it, or re-sync the installation's repository list)";
		case FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON:
			return 'GitHub declined to issue a scoped read token for this repository';
		default:
			return 'the platform issued no scoped read credential for this repository';
	}
}

/**
 * One provision's fetch credentials: asked for at most once, and dropped
 * for good at {@link FetchCredentialSession.dispose}.
 *
 * Asked ONCE for the whole workspace — the platform answers for the primary
 * and every mount in a single response — and LAZILY, on the first remote
 * that could use one, so a workspace with no `https://github.com` remote
 * never causes a token to exist.
 */
export class FetchCredentialSession implements FetchCredentialProvider {
	private loaded: Loaded | null = null;
	private inFlight: Promise<Loaded> | null = null;
	private disposed = false;

	constructor(private readonly options: FetchCredentialSessionOptions) {}

	async credentialFor(remoteUrl: string): Promise<FetchCredentialDecision> {
		if (this.disposed) {
			// Not a refusal: with the credential gone, the fetch is simply
			// the one this node always ran.
			return none('the scoped read credential for this run has already been released');
		}
		// The HOST is part of the identity, exactly as for a push: an
		// installation token means something to `github.com` and nowhere
		// else, and Git sends an extraheader on its very first request. So
		// the remote is parsed by the same function, and anything that is
		// not an https GitHub repository URL is never offered a credential —
		// and never causes the platform to be asked for one.
		const repositoryId = fleetPushRemoteRepositoryId(remoteUrl);
		if (!repositoryId) {
			return none(
				'this repository is not an https://github.com clone URL, which a GitHub App credential cannot authenticate'
			);
		}
		const loaded = await this.load();
		if (loaded.response === null) return none(loaded.fallback);

		// The remote this checkout fetches must be one the platform scoped a
		// token to. The URL comes from the job's own workspace and the
		// allowed set from platform state; this is where the two meet.
		const entry = loaded.response.credentials.find((candidate) => candidate.repositories.includes(repositoryId));
		if (!entry) {
			const reason = loaded.response.uncovered.find((candidate) => candidate.repository === repositoryId)?.reason;
			return none(describeFetchCredentialUnavailable(reason));
		}
		return {
			credential: {
				username: entry.username || FLEET_PUSH_CREDENTIAL_USERNAME,
				token: entry.token,
				remoteUrl
			},
			unavailable: null
		};
	}

	withheld(remoteUrl: string, reason: string): void {
		this.options.logger?.warn(
			`Fleet job ${this.options.jobId}: the scoped read credential for ${describeRemote(remoteUrl)} was not handed to Git (${reason}); ` +
				'that repository was fetched with this machine’s own Git configuration instead'
		);
	}

	/**
	 * Drop every credential and tell GitHub to stop honouring them.
	 *
	 * Idempotent and best-effort, exactly as `PushCredentialSession.dispose`
	 * is, and through the same revoke: the tokens are cleared from this
	 * session BEFORE the first `await`, each revoke is bounded, and a revoke
	 * that fails narrows nothing — a token still expires on GitHub's own
	 * clock within the hour and can only read the one repository it names.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const tokens = tokensOf(this.loaded?.response ?? null);
		this.loaded = null;
		this.inFlight = null;
		await this.revokeAll(tokens);
	}

	private async revokeAll(tokens: readonly string[]): Promise<void> {
		await Promise.all(tokens.map((token) => revokeScopedCredential(token, this.options)));
	}

	private load(): Promise<Loaded> {
		if (this.loaded) return Promise.resolve(this.loaded);
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.options.client.mintFetchCredential(this.options.jobId, this.options.leaseGeneration).then(
			(response) => {
				// A mint that lands AFTER disposal is not this session's to
				// keep — the same race `PushCredentialSession.load` closes.
				// Revoke what arrived and answer "none".
				if (this.disposed) {
					void this.revokeAll(tokensOf(response));
					return fallback('the scoped read credential for this run has already been released');
				}
				this.loaded = { response, fallback: null };
				this.options.logger?.info(
					`Fleet job ${this.options.jobId}: scoped read credential issued for ${
						response.credentials.length
					} repositor${response.credentials.length === 1 ? 'y' : 'ies'}` +
						(response.uncovered.length > 0
							? `; ${response.uncovered.length} will be fetched with this machine’s own Git configuration (${[
									...new Set(response.uncovered.map((entry) => entry.reason))
								].join(', ')})`
							: '')
				);
				return this.loaded;
			},
			(error: unknown) => {
				const kind = errorKind(error);
				// A stale lease keeps its own identity: the worker reads it as
				// "abort, and do not report". Never cached, never softened.
				if (kind === FLEET_JOB_STALE_LEASE_REASON) {
					this.inFlight = null;
					throw error;
				}
				// 401: this node does not hold an active claim on this job.
				// The request itself is wrong, so the run fails with the reason
				// instead of cloning for a job it was just told is not its own.
				if (kind === 'unauthorized') {
					this.inFlight = null;
					throw new FetchCredentialError(
						'the platform refused this node’s claim on the job when it asked for a scoped read credential ' +
							'(the job is not assigned to this node, or it is no longer active)'
					);
				}
				// Everything else is "no credential to be had", and a fetch
				// keeps its fallback (module header). 404 is an API that
				// predates the endpoint: expected, and not worth a warning.
				if (errorStatus(error) === 404) {
					this.options.logger?.info(
						`Fleet job ${this.options.jobId}: this platform does not issue scoped read credentials (its API predates the endpoint); fetching with this machine’s own Git configuration`
					);
					this.loaded = fallback('this platform’s API predates scoped read credentials');
					return this.loaded;
				}
				const detail = describeError(error);
				this.options.logger?.warn(
					`Fleet job ${this.options.jobId}: no scoped read credential could be obtained (${
						this.options.logger?.redact(detail) ?? detail
					}); fetching with this machine’s own Git configuration`
				);
				this.loaded = fallback(
					`the platform could not be asked for a scoped read credential (${kind ?? 'error'})`
				);
				return this.loaded;
			}
		);
		return this.inFlight;
	}
}

function none(unavailable: string): FetchCredentialDecision {
	return { credential: null, unavailable };
}

function fallback(reason: string): Loaded {
	return { response: null, fallback: reason };
}

function tokensOf(response: FleetJobFetchCredentialResponse | null): string[] {
	if (!response || !Array.isArray(response.credentials)) return [];
	return response.credentials
		.map((entry) => entry?.token)
		.filter((token): token is string => typeof token === 'string' && token.length > 0);
}

/**
 * Duck-typed, like `isStaleLeaseError` in the worker loop: the client is
 * injected, and a test double that answers a 401 should not have to
 * construct the real error class to be believed.
 */
function errorKind(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const kind = (error as { kind?: unknown }).kind;
	return typeof kind === 'string' ? kind : null;
}

function errorStatus(error: unknown): number | null {
	if (typeof error !== 'object' || error === null) return null;
	const status = (error as { status?: unknown }).status;
	return typeof status === 'number' ? status : null;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Host and path only, never userinfo — see the same helper in `push-credential.ts`. */
function describeRemote(remoteUrl: string): string {
	try {
		const url = new URL(remoteUrl);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return 'an unparseable URL';
	}
}
