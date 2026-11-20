import { config } from '../config';
import { DemoFeatureDisabledError } from './demo-errors';

/**
 * Platform demo mode — injection token + contract for the demo's repository ledger
 * (design §5.2.4 "Repo ledger").
 *
 * Demo repositories live in the org that also holds real customers' repositories, so the demo
 * sweeper deletes ONLY what this ledger says a sandbox created — never by listing the org, never
 * by name pattern. Everything that creates a repository on a demo instance
 * (`EverWorksGitProvider.createRepository`, `GitFacadeService.createRepository*`) records the
 * repository here once GitHub has CREATED it — never a repository a call merely found (ruling
 * R23). The API binds the token to its `demo_github_repos` table; Trigger.dev workers (no DB)
 * bind a remote proxy to the same service.
 *
 * Unbound on a demo instance = every repository create is refused before any GitHub call
 * ({@link demoRepoLedgerUnboundError}, ruling R22): an unledgered repository could never be
 * swept.
 */
export interface DemoRepoLedgerEntry {
    /** The demo sandbox (user id) the repository belongs to: the Work owner. */
    readonly sandboxUserId: string;
    readonly owner: string;
    readonly name: string;
    /** GitHub's numeric repository id from the create response; `null` when the call did not report it. */
    readonly githubId: number | null;
}

export interface DemoRepoLedgerPort {
    record(entry: DemoRepoLedgerEntry): Promise<void>;
}

export const DEMO_REPO_LEDGER = 'DEMO_REPO_LEDGER' as const;

/** Logged (once per consumer) when a demo instance has no `DEMO_REPO_LEDGER` bound. */
export const DEMO_REPO_LEDGER_UNBOUND_MESSAGE =
    'Demo mode is on but DEMO_REPO_LEDGER is not bound: refusing every repository creation';

/** The refusal for a repository create on a demo instance with no `DEMO_REPO_LEDGER` bound. */
export function demoRepoLedgerUnboundError(): DemoFeatureDisabledError {
    return new DemoFeatureDisabledError('repository creation (ledger not configured)');
}

/**
 * The ledger a repository create on this instance must record into, asked BEFORE the create
 * makes any GitHub call:
 *   - the demo off: `undefined` (nothing is recorded);
 *   - the demo on: `ledger`, or — with none bound — `onUnbound()` runs (the caller's log-once)
 *     and {@link demoRepoLedgerUnboundError} is thrown.
 */
export function demoRepoLedgerForCreate(
    ledger: DemoRepoLedgerPort | undefined,
    onUnbound: () => void,
): DemoRepoLedgerPort | undefined {
    if (!config.demo.isEnabled()) return undefined;
    if (!ledger) {
        onUnbound();
        throw demoRepoLedgerUnboundError();
    }
    return ledger;
}
