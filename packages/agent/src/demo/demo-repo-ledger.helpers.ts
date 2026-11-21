import type { Logger } from '@nestjs/common';
import { getErrorMessage } from '../utils/error.util';
import {
    DEMO_REPO_LEDGER_UNBOUND_MESSAGE,
    DEMO_REPO_TOPIC,
    demoRepoLedgerForCreate,
    type DemoRepoLedgerPort,
} from './demo-repo-ledger.port';

/**
 * Platform demo mode — the two steps every repository create on a demo instance shares
 * (`EverWorksGitProvider.createRepository`, `GitFacadeService.createRepository*`), next to the
 * ledger port they serve. Each takes the caller's own logger, so every line keeps the caller's
 * log context.
 */

/**
 * A consumer's {@link demoRepoLedgerForCreate} with its log-once built in. The returned function
 * answers the ledger a create must record into (asked BEFORE the create makes any GitHub call);
 * the first time it finds none bound on a demo instance it logs
 * {@link DEMO_REPO_LEDGER_UNBOUND_MESSAGE} at error level, and every refusal throws
 * `demoRepoLedgerUnboundError()`. One gate per consumer instance: the flag is the gate's own.
 */
export function demoRepoLedgerGate(
    logger: Pick<Logger, 'error'>,
): (ledger: DemoRepoLedgerPort | undefined) => DemoRepoLedgerPort | undefined {
    let unboundLogged = false;
    return (ledger) =>
        demoRepoLedgerForCreate(ledger, () => {
            if (unboundLogged) return;
            unboundLogged = true;
            logger.error(DEMO_REPO_LEDGER_UNBOUND_MESSAGE);
        });
}

/** A repository a demo sandbox's create just made, and how to tag it and read its id. */
export interface CreatedDemoRepository {
    readonly ledger: DemoRepoLedgerPort;
    readonly logger: Pick<Logger, 'error' | 'warn'>;
    /** The demo sandbox (user id) the repository belongs to: the Work owner. */
    readonly sandboxUserId: string;
    readonly owner: string;
    readonly name: string;
    /**
     * Tags the repository with `DEMO_REPO_TOPIC`. Best effort: it should log and swallow its own
     * failures; one it lets through is logged at warn level here, and the record goes ahead.
     */
    readonly tag: () => Promise<void>;
    /** GitHub's numeric repository id, or `null` when it cannot be had. Read after the tag. */
    readonly githubId: () => Promise<number | null> | number | null;
}

/**
 * The end of a repository create on a demo instance, once GitHub has CREATED the repository
 * (never one a call merely found, ruling R23):
 *
 *   1. it is tagged with the demo topic, BEFORE the record, so a repository whose record fails
 *      is still findable. Best effort: a tag that throws is logged at warn level and never
 *      stops the record (an untagged repository the ledger holds is still swept);
 *   2. its GitHub id is read;
 *   3. it is recorded in the demo ledger for its sandbox. A repository that cannot be recorded
 *      could never be swept, so a failed record is logged at error level, naming the repository
 *      for an operator to remove by hand (the topic finds it), and rethrown: the create fails.
 */
export async function tagAndRecordDemoRepository(repository: CreatedDemoRepository): Promise<void> {
    const { ledger, logger, sandboxUserId, owner, name } = repository;
    try {
        await repository.tag();
    } catch (error) {
        logger.warn(
            `Demo repository ${owner}/${name} not tagged ${DEMO_REPO_TOPIC}: ${getErrorMessage(error)}`,
        );
    }
    const githubId = await repository.githubId();
    try {
        await ledger.record({ sandboxUserId, owner, name, githubId });
    } catch (error) {
        logger.error(
            `Created demo repository ${owner}/${name} (id ${String(githubId)}) for user ${sandboxUserId} ` +
                `but could not record it in the demo ledger; the sweeper will not delete it: ${getErrorMessage(
                    error,
                )}`,
        );
        throw error;
    }
}
