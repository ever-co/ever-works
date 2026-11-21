import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DemoGithubRepo } from '../../entities/demo-github-repo.entity';
import { User } from '../../entities/user.entity';

/** Ledger of GitHub repos created by demo sandboxes (see `DemoGithubRepo`). */
@Injectable()
export class DemoGithubRepoRepository {
    constructor(
        @InjectRepository(DemoGithubRepo)
        private readonly repository: Repository<DemoGithubRepo>,
    ) {}

    async record(row: {
        sandboxUserId: string;
        owner: string;
        name: string;
        githubId: number | null;
    }): Promise<DemoGithubRepo> {
        return this.repository.save(
            this.repository.create({
                sandboxUserId: row.sandboxUserId,
                owner: row.owner,
                name: row.name,
                githubId: row.githubId,
            }),
        );
    }

    /** Rows of one sandbox whose repository has not been deleted yet. */
    pendingForSandbox(sandboxUserId: string): Promise<DemoGithubRepo[]> {
        return this.repository.find({
            where: { sandboxUserId, deletedAt: IsNull() },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Platform demo mode — the sweeper's canary: the newest pending row of `owner` with a recorded
     * GitHub id whose sandbox (a demo user) has not expired at `now`, so the sweep that asks about
     * it never deletes it. A row is written only after GitHub created the repository (201), so the
     * platform PAT reading it back with that id proves the PAT reads the org's private
     * repositories. `null` when no row qualifies.
     */
    newestLiveCanary(owner: string, now: Date): Promise<DemoGithubRepo | null> {
        return (
            this.repository
                .createQueryBuilder('repo')
                .innerJoin(User, 'sandbox', 'sandbox.id = repo.sandboxUserId')
                .where('repo.owner = :owner', { owner })
                .andWhere('repo.deletedAt IS NULL')
                .andWhere('repo.githubId IS NOT NULL')
                .andWhere('sandbox.registrationProvider = :provider', { provider: 'demo' })
                // `anonymousExpiresAt` is stored as epoch milliseconds (`TimestampColumn`).
                .andWhere('sandbox.anonymousExpiresAt > :now', { now: now.getTime() })
                .orderBy('repo.createdAt', 'DESC')
                .addOrderBy('repo.id', 'DESC')
                .getOne()
        );
    }

    async markDeleted(id: string, at: Date): Promise<void> {
        await this.repository.update({ id }, { deletedAt: at, lastError: null });
    }

    /** Stores the error and bumps `attempts` in one statement. */
    async markFailed(id: string, error: string): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(DemoGithubRepo)
            .set({ lastError: error, attempts: () => '"attempts" + 1' })
            .where('id = :id', { id })
            .execute();
    }
}
