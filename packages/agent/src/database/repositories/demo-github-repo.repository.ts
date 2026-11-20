import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DemoGithubRepo } from '../../entities/demo-github-repo.entity';

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
