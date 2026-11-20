import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { DemoGithubRepoRepository, UserRepository } from '@ever-works/agent/database';
import { withDemoSandboxLock } from '@ever-works/agent/demo';
import type { DemoGithubRepo, User } from '@ever-works/agent/entities';
import { EverWorksGitProvider } from '@ever-works/agent/ever-works-providers';
import {
    canDeleteLedgerRepo,
    demoRepoDeletionConfig,
    demoRepoTargetRefusal,
    type DemoRepoDeletionRefusal,
} from './demo-repo-deletion';
import { DemoSandboxPurgeService } from './demo-sandbox-purge.service';

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
 *   2. its live GitHub id: none (404) is already gone (closed); an id that differs from the
 *      recorded one is refused (`id mismatch`); otherwise the repository is deleted and the
 *      row closed (`canDeleteLedgerRepo` decides);
 *   3. only once no row of the sandbox is pending — and no generation of it is in flight (a
 *      worker could still make a repository), unless the sandbox expired more than
 *      {@link DEMO_GENERATION_DEFERRAL_MAX_MS} ago — `DemoSandboxPurgeService` removes its
 *      Works, workspace and user;
 *   4. a sandbox with a row at {@link DEMO_LEDGER_MAX_ATTEMPTS} attempts is logged at error
 *      level with its id and left for an operator: no GitHub call is made for it again.
 * A failure in one sandbox never stops the batch. The org is never listed and nothing is
 * deleted by pattern: GitHub is asked only about ledger rows.
 */
@Injectable()
export class DemoSandboxSweeperService {
    private readonly logger = new Logger(DemoSandboxSweeperService.name);

    constructor(
        private readonly users: UserRepository,
        private readonly ledger: DemoGithubRepoRepository,
        private readonly everWorksGit: EverWorksGitProvider,
        private readonly purger: DemoSandboxPurgeService,
        private readonly taskLock: DistributedTaskLockService,
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
        scan: for (let page = 0; page < DEMO_SWEEPER_MAX_PAGES; page += 1) {
            const expired = await this.users.findExpiredDemo(now, DEMO_SWEEPER_BATCH, after);
            for (const user of expired) {
                scanned += 1;
                after = { expiresAt: user.anonymousExpiresAt as Date, id: user.id };
                const outcome = await this.sweepSandboxLocked(user, now, summary);
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

    /** One sandbox under its create lock; an error is logged, counted, and takes a slot. */
    private async sweepSandboxLocked(
        user: User,
        now: Date,
        summary: DemoSweepSummary,
    ): Promise<SandboxOutcome | 'failed'> {
        try {
            return await withDemoSandboxLock(user.id, () => this.sweepSandbox(user, now, summary));
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

        for (const row of rows) {
            await this.sweepRepository(user, row, now, summary);
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

        await this.purger.purge(user);
        summary.sandboxes += 1;
        this.logger.log(`demo sweep: sandbox ${user.id} (${user.username}) purged`);
        return 'purged';
    }

    /** Steps 1 and 2 for one ledger row of `user`. */
    private async sweepRepository(
        user: User,
        row: DemoGithubRepo,
        now: Date,
        summary: DemoSweepSummary,
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
                await this.ledger.markDeleted(row.id, now);
                summary.reposDeleted += 1;
                this.logger.log(`demo sweep: ${target} of sandbox ${user.id} was already gone`);
                return;
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
