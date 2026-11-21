import type { Logger } from '@nestjs/common';
import type { CreateRepoOptions, GitRepository, IGitProviderPlugin } from '@ever-works/plugin';
import { getErrorMessage } from '../utils/error.util';
import { DEMO_REPO_TOPIC, type DemoRepoLedgerPort } from './demo-repo-ledger.port';
import { tagAndRecordDemoRepository } from './demo-repo-ledger.helpers';

/**
 * Platform demo mode — the demo repository ledger's part of `GitFacadeService`
 * (`createRepository` / `createRepositoryFromTemplate`), kept here so the facade only asks
 * {@link createLedgered} to run a create. Every line goes through the facade's own logger.
 */

type DemoGitFacadeLogger = Pick<Logger, 'error' | 'warn' | 'debug'>;

/** One repository create on a demo instance, with the ledger it records into. */
export interface DemoLedgeredCreate<T extends GitRepository | null> {
    readonly ledger: DemoRepoLedgerPort;
    readonly logger: DemoGitFacadeLogger;
    readonly plugin: IGitProviderPlugin;
    readonly token: string;
    readonly createOptions: CreateRepoOptions;
    /** The caller's `GitFacadeOptions.userId`: the sandbox the repository is created for. */
    readonly sandboxUserId: string | undefined;
    /** The provider call that creates the repository. */
    readonly create: () => Promise<T>;
}

/**
 * Runs `create` and records the repository in the demo ledger ONLY when this call created it
 * (ruling R23). The plugins answer an existing repository unchanged (GitHub's
 * `createRepository` / `createRepositoryFromTemplate` look it up first), so existence is read
 * BEFORE the create, where the plugin will look: the requested organization, else the token's
 * own account. A repository that was already there — a real customer repository in the shared
 * org, or the Work's repository the provider made and recorded with its id — never enters the
 * ledger.
 *
 * A created repository is tagged with the demo topic ({@link tagDemoRepository}, best effort)
 * and recorded with GitHub's id: the one the create itself reported (`GitRepository.id`, from
 * GitHub's create response), else read back from the plugin ({@link createdRepositoryId}). The
 * id is what pins the sweeper's deletion to the repository the sandbox created — nothing stops
 * another account of the shared org from taking a `demo-` name later — and a row without one is
 * never deleted (R28). `null` only when neither the create nor the plugin can supply it. A
 * create that answers no repository for one that was not there (GitHub's template create, when
 * the repository it just made is not readable yet — generation carries on with it) records the
 * requested coordinates. A call with no `sandboxUserId` names no sandbox to sweep the
 * repository for: it is created, unrecorded, with a warning. A failed record fails the call
 * (the repository would never be swept), after an error naming it
 * ({@link tagAndRecordDemoRepository}).
 */
export async function createLedgered<T extends GitRepository | null>(
    request: DemoLedgeredCreate<T>,
): Promise<T> {
    const { ledger, logger, plugin, token, createOptions, sandboxUserId, create } = request;
    if (!sandboxUserId) {
        const created = await create();
        logger.warn(
            `Demo mode: ${created?.fullName ?? createOptions.name} was created by a call that names no user, so it is not in the demo ledger and will not be swept`,
        );
        return created;
    }

    const targetOwner = createOptions.organization || (await plugin.getUser(token)).login;
    const existed = (await plugin.getRepository(targetOwner, createOptions.name, token)) !== null;
    const created = await create();
    if (existed) {
        return created;
    }

    const owner = created?.owner ?? targetOwner;
    const name = created?.name ?? createOptions.name;
    await tagAndRecordDemoRepository({
        ledger,
        logger,
        sandboxUserId,
        owner,
        name,
        tag: () => tagDemoRepository(plugin, token, owner, name, logger),
        githubId: async () =>
            numericRepositoryId(created?.id) ??
            (await createdRepositoryId(plugin, token, owner, name, logger)),
    });
    return created;
}

/**
 * Tags a repository this call created with {@link DEMO_REPO_TOPIC} through the plugin's
 * optional `addRepositoryTopics`. Best effort: a plugin without it, or a refusal, is logged at
 * warn level and never fails the create or the record.
 */
async function tagDemoRepository(
    plugin: IGitProviderPlugin,
    token: string,
    owner: string,
    name: string,
    logger: DemoGitFacadeLogger,
): Promise<void> {
    const addTopics = plugin.addRepositoryTopics;
    if (typeof addTopics !== 'function') {
        logger.warn(
            `Demo repository ${owner}/${name} not tagged ${DEMO_REPO_TOPIC}: provider ${plugin.id} cannot set topics`,
        );
        return;
    }
    try {
        await addTopics.call(plugin, owner, name, [DEMO_REPO_TOPIC], token);
    } catch (error) {
        logger.warn(
            `Demo repository ${owner}/${name} not tagged ${DEMO_REPO_TOPIC}: ${getErrorMessage(error)}`,
        );
    }
}

/**
 * GitHub's numeric id of a repository this call just created, read through the plugin's
 * optional `getRepositoryIdentity`; `null` (with a debug line) when the plugin cannot supply it:
 * no such read, the repository not readable yet, an answer for another repository, a
 * non-numeric id, or a failed read. Never fails the create.
 */
async function createdRepositoryId(
    plugin: IGitProviderPlugin,
    token: string,
    owner: string,
    name: string,
    logger: DemoGitFacadeLogger,
): Promise<number | null> {
    const unknown = (why: string): null => {
        logger.debug(`Demo ledger: no GitHub id for ${owner}/${name} (${why})`);
        return null;
    };
    const readIdentity = plugin.getRepositoryIdentity;
    if (typeof readIdentity !== 'function') {
        return unknown(`provider ${plugin.id} reports no repository id`);
    }
    try {
        const identity = await readIdentity.call(plugin, owner, name, token);
        if (!identity) return unknown('not readable yet');
        if (identity.fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
            return unknown(`the provider answered for ${identity.fullName}`);
        }
        return numericRepositoryId(identity.id) ?? unknown(`id ${identity.id} is not numeric`);
    } catch (error) {
        return unknown(getErrorMessage(error));
    }
}

/** A provider repository id (GitHub's numeric id, as a string) as a number; `null` otherwise. */
function numericRepositoryId(id: string | undefined): number | null {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return null;
    const value = Number(id);
    return Number.isSafeInteger(value) ? value : null;
}
