import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import {
    DemoGithubRepoRepository,
    DemoUsageCounterRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { withDemoSandboxLock } from '@ever-works/agent/demo';
import type { DemoGithubRepo, User } from '@ever-works/agent/entities';
import {
    EverWorksGitProvider,
    EverWorksGitRequestError,
} from '@ever-works/agent/ever-works-providers';
import {
    canDeleteLedgerRepo,
    demoRepoDeletionConfig,
    demoRepoTargetRefusal,
    type DemoRepoDeletionRefusal,
} from './demo-repo-deletion';
import { DemoSandboxPurgeService, sandboxPurgeFailureKey } from './demo-sandbox-purge.service';

/** What one sweep did. */
export interface DemoSweepSummary {
    /** Expired sandboxes purged (user, workspace and Works gone). */
    sandboxes: number;
    /** Ledger repositories deleted on GitHub, or found already gone. */
    reposDeleted: number;
    /** Ledger repositories refused by the deletion rules (owner, prefix, id). */
    reposSkipped: number;
    /** Errors: a lookup, delete or purge that threw, and sandboxes held for an operator. */
    failures: number;
}

export const DEMO_SWEEPER_CRON = '*/15 * * * *';
export const DEMO_SWEEPER_LOCK_KEY = 'demo-sandbox-sweeper';
/**
 * Expired sandboxes a sweep acts on, oldest first — and the page size it reads them in.
 * Sandboxes held for an operator or deferred take no slot.
 */
export const DEMO_SWEEPER_BATCH = 20;
/** Pages of {@link DEMO_SWEEPER_BATCH} one sweep reads at most (200 sandboxes). */
export const DEMO_SWEEPER_MAX_PAGES = 10;
/** A ledger row that failed this many times holds its sandbox for an operator. */
export const DEMO_LEDGER_MAX_ATTEMPTS = 3;
/** A sandbox whose purge failed this many times is held for an operator (design §5.2 step 5.3). */
export const DEMO_PURGE_MAX_FAILURES = 3;
/**
 * How long a sandbox's count of failed purges lasts (`demo_usage_counters` window). Long enough
 * to hold it for an operator; when it lapses the sandbox gets {@link DEMO_PURGE_MAX_FAILURES}
 * fresh attempts.
 */
const PURGE_FAILURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long past its expiry a sandbox waits for an open generation before it is purged anyway.
 * A generation that started and never progressed is never closed by the stale-generation
 * cleanup (`WorkRepository.getUnfinishedGenerations` selects on `generationProgressedAt`), so
 * without a bound such a sandbox would never be swept.
 */
export const DEMO_GENERATION_DEFERRAL_MAX_MS = 2 * 60 * 60 * 1000;

/** Under the cron interval, so a stuck run cannot hold the lock past the next one by much. */
const SWEEP_MAX_LIFETIME_MS = 14 * 60 * 1000;

type SandboxOutcome = 'purged' | 'pending' | 'deferred' | 'held';

/**
 * What a sweep run makes of a repository 404. GitHub answers 404 both for a repository that is
 * gone and for a private one the platform PAT can no longer read (its owner left the org, a
 * fine-grained approval was revoked, the repository selection narrowed), while `GET /orgs/{org}`
 * stays 200 (org profiles are public) and demo repositories are private. A revoked or expired
 * PAT is not this case: it answers 401, which `getRepositoryId` throws and the row records as
 * a failure.
 */
type NotFoundVerdict =
    | { readonly kind: 'trusted' }
    /** No proof the PAT reads the org's private repositories: the row fails (`attempts` + 1). */
    | { readonly kind: 'untrusted'; readonly reason: string }
    /** The proof could not be asked (GitHub 5xx, rate limit, network): retried next sweep, uncounted. */
    | { readonly kind: 'unknown'; readonly reason: string };

const TRUSTED: NotFoundVerdict = { kind: 'trusted' };

/** One sweep run's trust in repository 404s (see `DemoSandboxSweeperService.notFoundTrust`). */
interface NotFoundTrust {
    /** A lookup of this run answered a ledger row's recorded id. */
    liveMatch(): void;
    /** The verdict on a repository 404 of this run. */
    verdict(): Promise<NotFoundVerdict>;
}

/**
 * Platform demo mode — deletes expired demo sandboxes and the GitHub repositories they
 * created (design §5.2.5). Registered only by `DemoModule.register()` with `DEMO` on, so the
 * cron does not exist on any other instance.
 *
 * Every 15 minutes, under the distributed lock `demo-sandbox-sweeper`, the expired demo
 * sandboxes are read oldest first, a page of 20 at a time on a stable (expiry, id) cursor
 * (`UserRepository.findExpiredDemo`), until 20 of them have been acted on, the list ends, or
 * {@link DEMO_SWEEPER_MAX_PAGES} pages were read. A sandbox held for an operator or deferred
 * takes no slot, so it can never starve the ones behind it. For each, while holding that
 * sandbox's `withDemoSandboxLock` (the lock its repository creates take, so none can slip in
 * mid-sweep):
 *   1. each pending ledger row: refused — warned, `attempts` + 1 — unless the owner is
 *      `DEMO_GITHUB_ORG` and the name starts with `DEMO_REPO_PREFIX`;
 *   2. its live GitHub id: none (404) is already gone (closed) — but only on proof the PAT reads
 *      the org's PRIVATE repositories, since GitHub answers 404 too for one it cannot read: a
 *      lookup of this run answered a row's recorded id, or else the canary does (the newest
 *      pending row of a sandbox that has not expired, looked up once a run, on the first 404
 *      without proof). Without proof every 404 of the run fails (`attempts` + 1, logged once);
 *      when the canary lookup itself errs (5xx, rate limit, network) its 404s are left
 *      uncounted for the next sweep. An id that differs from the recorded one is refused
 *      (`id mismatch`); otherwise the repository is deleted and the row closed
 *      (`canDeleteLedgerRepo` decides);
 *   3. only once no row of the sandbox is pending — and no generation of it is in flight (a
 *      worker could still make a repository), unless the sandbox expired more than
 *      {@link DEMO_GENERATION_DEFERRAL_MAX_MS} ago — `DemoSandboxPurgeService` removes its
 *      Works, workspace and user;
 *   4. a sandbox with a row at {@link DEMO_LEDGER_MAX_ATTEMPTS} attempts, or whose purge failed
 *      {@link DEMO_PURGE_MAX_FAILURES} times (counted in `demo_usage_counters`, so across runs
 *      and restarts, and cleared by the purge that succeeds), is logged at error level with its
 *      id and its last error and left for an operator: it takes no batch slot, and no GitHub
 *      call or purge is made for it again.
 * A failure in one sandbox never stops the batch. The org is never listed and nothing is
 * deleted by pattern: GitHub is asked only about ledger rows.
 */
@Injectable()
export class DemoSandboxSweeperService {
    private readonly logger = new Logger(DemoSandboxSweeperService.name);
    /** The last purge error of each sandbox, as this process saw it (for the held log). */
    private readonly lastPurgeErrors = new Map<string, string>();

    constructor(
        private readonly users: UserRepository,
        private readonly ledger: DemoGithubRepoRepository,
        private readonly everWorksGit: EverWorksGitProvider,
        private readonly purger: DemoSandboxPurgeService,
        private readonly taskLock: DistributedTaskLockService,
        private readonly counters: DemoUsageCounterRepository,
    ) {}

    @Cron(DEMO_SWEEPER_CRON, { name: DEMO_SWEEPER_LOCK_KEY })
    async handleCron(): Promise<void> {
        try {
            await this.taskLock.runExclusive(DEMO_SWEEPER_LOCK_KEY, () => this.sweep(), {
                ttlMs: SWEEP_MAX_LIFETIME_MS,
                maxLifetimeMs: SWEEP_MAX_LIFETIME_MS,
                onLocked: () =>
                    this.logger.debug('Skipping the demo sweep: another instance holds its lock'),
            });
        } catch (error) {
            this.logger.error(`The demo sweep failed: ${messageOf(error)}`);
        }
    }

    async sweep(now: Date = new Date()): Promise<DemoSweepSummary> {
        const summary: DemoSweepSummary = {
            sandboxes: 0,
            reposDeleted: 0,
            reposSkipped: 0,
            failures: 0,
        };
        if (!config.demo.isEnabled()) return summary;

        let scanned = 0;
        let acted = 0;
        let held = 0;
        let deferred = 0;
        let after: { expiresAt: Date; id: string } | undefined;
        const trust = this.notFoundTrust(now);
        scan: for (let page = 0; page < DEMO_SWEEPER_MAX_PAGES; page += 1) {
            const expired = await this.users.findExpiredDemo(now, DEMO_SWEEPER_BATCH, after);
            for (const user of expired) {
                scanned += 1;
                after = { expiresAt: user.anonymousExpiresAt as Date, id: user.id };
                const outcome = await this.sweepSandboxLocked(user, now, summary, trust);
                if (outcome === 'held') held += 1;
                else if (outcome === 'deferred') deferred += 1;
                else acted += 1;
                if (acted >= DEMO_SWEEPER_BATCH) break scan;
            }
            if (expired.length < DEMO_SWEEPER_BATCH) break;
        }

        if (held > 0 && acted === 0) {
            this.logger.error(
                `demo sweep: ${held} sandboxes held for an operator and nothing else to sweep ` +
                    `(${scanned} expired sandboxes read); resolve their ledger rows`,
            );
        }
        if (scanned > 0) {
            this.logger.log(
                `demo sweep: ${scanned} expired read, ${acted} acted on (${summary.sandboxes} purged), ` +
                    `${held} held, ${deferred} deferred, ${summary.reposDeleted} repositories deleted, ` +
                    `${summary.reposSkipped} skipped, ${summary.failures} failures`,
            );
        }
        return summary;
    }

    /**
     * The sweep run's {@link NotFoundTrust}. A 404 is trusted once any lookup of the run answered
     * a ledger row's recorded id: a ledger row exists only after GitHub created its repository
     * (201), so that answer proves the PAT reads the org's private repositories. Without such an
     * answer, the first 404 asks the canary ({@link askCanary}), once a run; every later 404 of
     * the run reuses its verdict, unless a lookup has answered a recorded id since.
     */
    private notFoundTrust(now: Date): NotFoundTrust {
        let proven = false;
        let canary: Promise<NotFoundVerdict> | undefined;
        return {
            liveMatch: () => {
                proven = true;
            },
            verdict: () => (proven ? Promise.resolve(TRUSTED) : (canary ??= this.askCanary(now))),
        };
    }

    /**
     * Looks up the canary: the newest pending ledger row with a recorded id whose sandbox has
     * NOT expired (`DemoGithubRepoRepository.newestLiveCanary`), so this run never deletes it.
     * Its recorded id answered is proof; a 404, another id, a refusal or no canary at all is not
     * (the 404s fail and count). A lookup that errs (5xx, rate limit, network) or a ledger read
     * that fails gives no verdict: the 404s are left uncounted for the next sweep. One GitHub
     * call at most, never the org's repository list; anything but proof is logged once.
     */
    private async askCanary(now: Date): Promise<NotFoundVerdict> {
        let canary: DemoGithubRepo | null;
        try {
            canary = await this.ledger.newestLiveCanary(config.demo.githubOrg(), now);
        } catch (error) {
            return this.unproven('unknown', `the canary could not be read: ${messageOf(error)}`);
        }
        if (!canary || demoRepoTargetRefusal(canary, demoRepoDeletionConfig()) !== null) {
            return this.unproven(
                'untrusted',
                'no lookup of this run answered a recorded id, and no live sandbox has a repository to check',
            );
        }

        const target = `${canary.owner}/${canary.name}`;
        let liveId: number | null;
        try {
            liveId = await this.everWorksGit.getRepositoryId(canary.owner, canary.name);
        } catch (error) {
            return this.unproven(
                isTransientGitHubFailure(error) ? 'unknown' : 'untrusted',
                `the canary ${target} could not be looked up: ${messageOf(error)}`,
            );
        }
        if (liveId !== null && liveId === canary.githubId) return TRUSTED;
        return this.unproven(
            'untrusted',
            liveId === null
                ? `the canary ${target} of live sandbox ${canary.sandboxUserId} answered 404`
                : `the canary ${target} answered id ${liveId}, recorded ${String(canary.githubId)}`,
        );
    }

    private unproven(kind: 'untrusted' | 'unknown', detail: string): NotFoundVerdict {
        this.logger.error(
            `demo sweep: a repository 404 is not proof it is gone (${detail}); ` +
                (kind === 'unknown'
                    ? 'the 404s of this run are left for the next sweep, no attempt counted'
                    : 'every 404 of this run counts as a failure, no ledger row is closed as gone'),
        );
        return { kind, reason: `404 not trusted: ${detail}` };
    }

    /** One sandbox under its create lock; an error is logged, counted, and takes a slot. */
    private async sweepSandboxLocked(
        user: User,
        now: Date,
        summary: DemoSweepSummary,
        trust: NotFoundTrust,
    ): Promise<SandboxOutcome | 'failed'> {
        try {
            return await withDemoSandboxLock(user.id, () =>
                this.sweepSandbox(user, now, summary, trust),
            );
        } catch (error) {
            summary.failures += 1;
            this.logger.error(`demo sweep: sandbox ${user.id} failed: ${messageOf(error)}`);
            return 'failed';
        }
    }

    private async sweepSandbox(
        user: User,
        now: Date,
        summary: DemoSweepSummary,
        trust: NotFoundTrust,
    ): Promise<SandboxOutcome> {
        const rows = await this.ledger.pendingForSandbox(user.id);
        const stuck = rows.filter((row) => row.attempts >= DEMO_LEDGER_MAX_ATTEMPTS);
        if (stuck.length > 0) {
            summary.failures += 1;
            this.logger.error(
                `demo sweep: sandbox ${user.id} is held for an operator — ledger row(s) ` +
                    `${stuck.map((row) => `${row.id} (${row.owner}/${row.name}: ${row.lastError})`).join(', ')} ` +
                    `failed ${DEMO_LEDGER_MAX_ATTEMPTS} times`,
            );
            return 'held';
        }

        const purgeFailures = await this.counters.peek(sandboxPurgeFailureKey(user.id), now);
        if (purgeFailures >= DEMO_PURGE_MAX_FAILURES) {
            summary.failures += 1;
            this.logger.error(
                `demo sweep: sandbox ${user.id} is held for an operator — its purge failed ` +
                    `${purgeFailures} times (last error: ${
                        this.lastPurgeErrors.get(user.id) ??
                        'logged when it was held; not seen since this process started'
                    })`,
            );
            return 'held';
        }

        for (const row of rows) {
            await this.sweepRepository(user, row, now, summary, trust);
        }

        if ((await this.ledger.pendingForSandbox(user.id)).length > 0) return 'pending';
        const generating = await this.purger.generationsInFlight(user.id);
        if (generating.length > 0) {
            const expiredFor = now.getTime() - (user.anonymousExpiresAt as Date).getTime();
            if (expiredFor <= DEMO_GENERATION_DEFERRAL_MAX_MS) {
                this.logger.log(
                    `demo sweep: sandbox ${user.id} has a generation in flight; purged later`,
                );
                return 'deferred';
            }
            this.logger.warn(
                `demo sweep: sandbox ${user.id} expired ${Math.round(expiredFor / 60_000)} min ago ` +
                    `and its generation never finished (Work ${generating.join(', ')}); purging it anyway`,
            );
        }

        try {
            await this.purger.purge(user);
        } catch (error) {
            await this.recordPurgeFailure(user, messageOf(error), now);
            throw error;
        }
        this.lastPurgeErrors.delete(user.id);
        summary.sandboxes += 1;
        this.logger.log(`demo sweep: sandbox ${user.id} (${user.username}) purged`);
        return 'purged';
    }

    /**
     * Counts a failed purge of `user` (persisted, so a sandbox whose purge keeps failing is held
     * for an operator after {@link DEMO_PURGE_MAX_FAILURES} and stops taking a batch slot).
     */
    private async recordPurgeFailure(user: User, error: string, now: Date): Promise<void> {
        this.lastPurgeErrors.set(user.id, error);
        try {
            const failures = await this.counters.increment(
                sandboxPurgeFailureKey(user.id),
                new Date(now.getTime() + PURGE_FAILURE_WINDOW_MS),
                now,
            );
            if (failures >= DEMO_PURGE_MAX_FAILURES) {
                this.logger.error(
                    `demo sweep: sandbox ${user.id} purge failed ${failures} times ` +
                        `(last error: ${error}); held for an operator`,
                );
            }
        } catch (countError) {
            this.logger.error(
                `demo sweep: sandbox ${user.id}: its failed purge could not be counted: ${messageOf(countError)}`,
            );
        }
    }

    /** Steps 1 and 2 for one ledger row of `user`. */
    private async sweepRepository(
        user: User,
        row: DemoGithubRepo,
        now: Date,
        summary: DemoSweepSummary,
        trust: NotFoundTrust,
    ): Promise<void> {
        const target = `${row.owner}/${row.name}`;
        if (row.sandboxUserId !== user.id) {
            throw new Error(`ledger row ${row.id} is not sandbox ${user.id}'s`);
        }

        const demo = demoRepoDeletionConfig();
        const refusal = demoRepoTargetRefusal(row, demo);
        if (refusal) {
            await this.skip(row, refusal, summary);
            return;
        }

        try {
            const liveId = await this.everWorksGit.getRepositoryId(row.owner, row.name);
            if (liveId === null) {
                // A 404 is "gone" only on proof the PAT reads the org's private repositories.
                const notFound = await trust.verdict();
                if (notFound.kind === 'unknown') {
                    // No verdict (the canary lookup erred): left for the next sweep, uncounted.
                    summary.failures += 1;
                    return;
                }
                if (notFound.kind === 'untrusted') {
                    summary.failures += 1;
                    await this.markFailed(row, notFound.reason);
                    return;
                }
                await this.ledger.markDeleted(row.id, now);
                summary.reposDeleted += 1;
                this.logger.log(`demo sweep: ${target} of sandbox ${user.id} was already gone`);
                return;
            }
            if (row.githubId !== null && row.githubId !== undefined && liveId === row.githubId) {
                trust.liveMatch();
            }

            const verdict = canDeleteLedgerRepo(row, liveId, demo);
            if ('reason' in verdict) {
                await this.skip(row, verdict.reason, summary, liveId);
                return;
            }

            const result = await this.everWorksGit.deleteRepository(row.owner, row.name);
            await this.ledger.markDeleted(row.id, now);
            summary.reposDeleted += 1;
            this.logger.log(
                `demo sweep: ${target} (id ${liveId}) of sandbox ${user.id}: ${result}`,
            );
        } catch (error) {
            summary.failures += 1;
            await this.markFailed(row, messageOf(error));
        }
    }

    private async skip(
        row: DemoGithubRepo,
        reason: DemoRepoDeletionRefusal,
        summary: DemoSweepSummary,
        liveId?: number,
    ): Promise<void> {
        summary.reposSkipped += 1;
        this.logger.warn(
            `demo sweep: not deleting ${row.owner}/${row.name} (ledger row ${row.id}, sandbox ` +
                `${row.sandboxUserId}, recorded id ${String(row.githubId)}` +
                `${liveId === undefined ? '' : `, live id ${liveId}`}): ${reason}`,
        );
        await this.markFailed(row, reason);
    }

    private async markFailed(row: DemoGithubRepo, error: string): Promise<void> {
        await this.ledger.markFailed(row.id, error);
        const attempts = row.attempts + 1;
        if (attempts >= DEMO_LEDGER_MAX_ATTEMPTS) {
            this.logger.error(
                `demo sweep: ledger row ${row.id} (${row.owner}/${row.name}) of sandbox ` +
                    `${row.sandboxUserId} has failed ${attempts} times (${error}); left for an operator`,
            );
        }
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * A canary lookup that gave no answer rather than a wrong one: GitHub's 5xx, its rate limits
 * (429, and the 403 its primary and secondary limits answer with), or no HTTP answer at all.
 */
function isTransientGitHubFailure(error: unknown): boolean {
    if (!(error instanceof EverWorksGitRequestError)) return true;
    return error.status >= 500 || error.status === 429 || error.status === 403;
}
