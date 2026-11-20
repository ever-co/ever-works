import { Injectable } from '@nestjs/common';
import { DemoGithubRepoRepository } from '@ever-works/agent/database';
import type { DemoRepoLedgerEntry, DemoRepoLedgerPort } from '@ever-works/agent/demo';

/**
 * Platform demo mode — the repository ledger (`DEMO_REPO_LEDGER`, design §5.2.4) on the
 * `demo_github_repos` table. `EverWorksGitProvider` and `GitFacadeService` record every
 * repository they create on a demo instance here; the Trigger workers reach it by name over
 * `remote/call` (`TriggerInternalController`'s one-member `record` facade). The demo sweeper
 * deletes exactly the rows recorded here, so a row is stored only when it is well formed.
 */
@Injectable()
export class DemoRepoLedgerService implements DemoRepoLedgerPort {
    constructor(private readonly repos: DemoGithubRepoRepository) {}

    async record(entry: DemoRepoLedgerEntry): Promise<void> {
        await this.repos.record(wellFormed(entry));
    }
}

/** The entry as stored, or a refusal: it may have come over the worker hop. */
function wellFormed(entry: DemoRepoLedgerEntry | undefined): DemoRepoLedgerEntry {
    const { sandboxUserId, owner, name, githubId } = (entry ?? {}) as Partial<DemoRepoLedgerEntry>;
    const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
    if (!text(sandboxUserId) || !text(owner) || !text(name)) {
        throw new Error(
            'Refusing a malformed demo ledger entry (sandbox, owner and name required)',
        );
    }
    if (githubId !== null && githubId !== undefined && !Number.isSafeInteger(githubId)) {
        throw new Error(
            'Refusing a malformed demo ledger entry (githubId must be an integer or null)',
        );
    }
    return { sandboxUserId, owner, name, githubId: githubId ?? null };
}
