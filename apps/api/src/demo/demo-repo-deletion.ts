import { config } from '@ever-works/agent/config';
import type { DemoGithubRepo } from '@ever-works/agent/entities';

/**
 * Platform demo mode — the ONE decision that lets the demo sweeper delete a GitHub repository
 * (design §5.2.5). Demo repositories share `DEMO_GITHUB_ORG` with real customers'
 * repositories, so deleting the wrong one is the failure this feature must never have.
 *
 * A repository is deleted only when ALL hold:
 *   1. it is a ledger row of the sandbox being swept (structural: the sweeper reads only
 *      `DemoGithubRepoRepository.pendingForSandbox(sandbox)`, and checks the row's sandbox);
 *   2. its owner is exactly `DEMO_GITHUB_ORG`, which must be set;
 *   3. its name starts with `DEMO_REPO_PREFIX` (exactly, case included), which must be set;
 *   4. the live GitHub id equals the id the ledger recorded, when it recorded one (so a later,
 *      unrelated repository that took the name is never hit).
 * Pure: no I/O, the configuration is passed in.
 */

export interface DemoRepoDeletionConfig {
    readonly githubOrg: string;
    readonly repoPrefix: string;
}

/** Why a ledger row is not deleted; stored as the row's `lastError`. */
export type DemoRepoDeletionRefusal =
    | 'DEMO_GITHUB_ORG not set'
    | 'DEMO_REPO_PREFIX not set'
    | 'owner mismatch'
    | 'name prefix mismatch'
    | 'id mismatch';

export type DemoRepoDeletionVerdict =
    | { readonly delete: true }
    | { readonly delete: false; readonly reason: DemoRepoDeletionRefusal };

type LedgerRepo = Pick<DemoGithubRepo, 'owner' | 'name' | 'githubId'>;

/** The demo's deletion configuration, read from the env on every call. */
export function demoRepoDeletionConfig(): DemoRepoDeletionConfig {
    return { githubOrg: config.demo.githubOrg(), repoPrefix: config.demo.repoPrefix() };
}

/**
 * Conditions 2 and 3 — checked BEFORE any GitHub call (the sweeper never even looks up a
 * repository outside the demo org or without the prefix). `null` when they hold.
 */
export function demoRepoTargetRefusal(
    row: LedgerRepo,
    demo: DemoRepoDeletionConfig,
): DemoRepoDeletionRefusal | null {
    if (!demo.githubOrg) return 'DEMO_GITHUB_ORG not set';
    if (!demo.repoPrefix) return 'DEMO_REPO_PREFIX not set';
    if (row.owner !== demo.githubOrg) return 'owner mismatch';
    if (!row.name.startsWith(demo.repoPrefix)) return 'name prefix mismatch';
    return null;
}

/**
 * Whether the ledger row may be deleted now that GitHub answered `liveId` for its
 * coordinates (a repository that is gone never gets here: there is nothing to delete).
 */
export function canDeleteLedgerRepo(
    row: LedgerRepo,
    liveId: number,
    demo: DemoRepoDeletionConfig,
): DemoRepoDeletionVerdict {
    const refusal = demoRepoTargetRefusal(row, demo);
    if (refusal) return { delete: false, reason: refusal };
    if (!Number.isSafeInteger(liveId)) return { delete: false, reason: 'id mismatch' };
    if (row.githubId !== null && row.githubId !== undefined && row.githubId !== liveId) {
        return { delete: false, reason: 'id mismatch' };
    }
    return { delete: true };
}
