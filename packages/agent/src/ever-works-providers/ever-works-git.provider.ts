import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { config } from '../config';
import {
    DEMO_REPO_LEDGER,
    DEMO_REPO_LEDGER_UNBOUND_MESSAGE,
    DEMO_REPO_TOPIC,
    demoRepoLedgerForCreate,
    type DemoRepoLedgerPort,
} from '../demo/demo-repo-ledger.port';
import { assertDemoRepositoryName } from '../demo/demo-work-policy';
import { trimEdgeChars } from '../utils/text.utils';
import {
    EverWorksGitDeletionRefusedError,
    EverWorksGitDisabledError,
    EverWorksGitMisconfiguredError,
    EverWorksGitRequestError,
    type EverWorksGitRepoRef,
    type EverWorksProviderWorkRef,
} from './types';

const GITHUB_API_BASE = 'https://api.github.com';
const REPO_NAME_MAX_LENGTH = 100;

/** Function shape used to call GitHub. Overridable in tests. */
export type EverWorksGitHttpFetch = typeof fetch;

/** The transport override `getRepositoryId` / `deleteRepository` take (for tests). */
interface GitHubCallOptions {
    readonly fetchImpl?: EverWorksGitHttpFetch;
}

interface CreateRepositoryOptions {
    readonly work: EverWorksProviderWorkRef;
    /** Override the org from env (for tests). */
    readonly orgOverride?: string;
    /** Inject a fetch implementation (for tests). */
    readonly fetchImpl?: EverWorksGitHttpFetch;
    /** Override visibility from env (for tests). */
    readonly visibilityOverride?: 'private' | 'public';
}

interface GitHubRepoApiResponse {
    readonly id: number;
    readonly name: string;
    readonly full_name: string;
    readonly html_url: string;
    readonly clone_url: string;
    readonly private: boolean;
    readonly owner: { readonly login: string };
}

interface GitHubErrorApiResponse {
    readonly message?: string;
    readonly errors?: ReadonlyArray<{ readonly code?: string; readonly message?: string }>;
}

/**
 * Creates repositories under the Ever Works customers GitHub org using a
 * server-held PAT. Backs the "Ever Works Git" storage choice from the
 * onboarding wizard.
 *
 * This provider is intentionally narrow — it only handles repository
 * provisioning. The downstream push / commit flow keeps using the existing
 * git facade once the repo exists; the platform PAT is exposed to that flow
 * via a separate accessor so we keep one PAT surface.
 *
 * Platform demo mode: every repository it creates is recorded in the demo repository ledger
 * (`DEMO_REPO_LEDGER`), and with the demo on and no ledger bound it creates nothing. The
 * sweeper's `getRepositoryId` / `deleteRepository` live here too, beside the PAT they use;
 * `deleteRepository` deletes only a demo repository (see there).
 */
@Injectable()
export class EverWorksGitProvider {
    private readonly logger = new Logger(EverWorksGitProvider.name);
    private ledgerUnboundLogged = false;

    constructor(
        // Platform demo mode — bound by the API's global `DemoModule` only when `DEMO` is
        // on. Unbound with the demo on, every create is refused (ruling R22).
        @Optional()
        @Inject(DEMO_REPO_LEDGER)
        private readonly ledger?: DemoRepoLedgerPort,
    ) {}

    /** True when both the feature flag and the required PAT/org are present. */
    isEnabled(): boolean {
        return (
            config.everWorks.git.isEnabled() &&
            config.everWorks.git.getPat().length > 0 &&
            config.everWorks.git.getOrg().length > 0
        );
    }

    /** Return the configured customer org (e.g. `'ever-works-cloud'`). */
    getOrg(): string {
        return config.everWorks.git.getOrg();
    }

    /**
     * Compute the target repo name for a Work. Pattern: `{user-slug}-{work-slug}`.
     * A 7-char suffix derived from the Work UUID is appended when the caller
     * indicates a collision so retries are deterministic.
     */
    buildRepoName(work: EverWorksProviderWorkRef, withCollisionSuffix = false): string {
        const userPart = (work.userSlug ?? '').trim() || work.userId.slice(0, 8);
        const base = `${slugify(userPart)}-${slugify(work.slug)}`.replace(/-{2,}/g, '-');
        const trimmed = trimRepoName(base);

        if (!withCollisionSuffix) {
            return trimmed;
        }

        const suffix = `-${work.id.replace(/-/g, '').slice(0, 7)}`;
        return trimRepoName(trimmed, suffix.length) + suffix;
    }

    /**
     * Create a new repository in the customers org for the given Work.
     *
     * Behaviour:
     *  - Rejects with `EverWorksGitDisabledError` when the env flag is off
     *    or the PAT is missing.
     *  - First try: `{user-slug}-{work-slug}`.
     *  - On `422 name already exists`, retries once with a `-{shortId}` suffix.
     *  - Any other non-2xx response throws `EverWorksGitRequestError` so the
     *    caller can map it to a typed API error.
     *  - On a demo instance (`DEMO`), throws `DemoFeatureDisabledError` before
     *    calling GitHub when a name does not start with `DEMO_REPO_PREFIX`, or
     *    when no `DEMO_REPO_LEDGER` is bound; a repository GitHub created (201)
     *    is recorded in the ledger for the Work owner (`work.userId`) with its
     *    GitHub id before it is returned.
     */
    async createRepository(options: CreateRepositoryOptions): Promise<EverWorksGitRepoRef> {
        if (!this.isEnabled() && !options.orgOverride) {
            throw new EverWorksGitDisabledError();
        }

        const org = options.orgOverride ?? this.getOrg();
        if (!org) {
            throw new EverWorksGitMisconfiguredError('customer GitHub org is empty');
        }

        const pat = config.everWorks.git.getPat();
        if (!pat && !options.fetchImpl) {
            // fetchImpl can be a fully-mocked transport in tests; otherwise we
            // need a real PAT to talk to GitHub.
            throw new EverWorksGitMisconfiguredError('customer GitHub PAT is empty');
        }

        // Platform demo mode — asked before the first GitHub call (ruling R22).
        const ledger = demoRepoLedgerForCreate(this.ledger, () => this.logLedgerUnboundOnce());

        const visibility = options.visibilityOverride ?? config.everWorks.git.getVisibility();
        const fetchImpl = options.fetchImpl ?? fetch;

        const firstName = this.buildRepoName(options.work);
        const first = await this.tryCreate({
            org,
            pat,
            visibility,
            fetchImpl,
            name: firstName,
            description: options.work.description,
        });
        if (first.kind === 'ok') {
            return this.recordCreated(ledger, options.work, first.repo, { pat, fetchImpl });
        }
        if (first.kind !== 'name_taken') throw first.error;

        const fallbackName = this.buildRepoName(options.work, true);
        const second = await this.tryCreate({
            org,
            pat,
            visibility,
            fetchImpl,
            name: fallbackName,
            description: options.work.description,
        });
        if (second.kind === 'ok') {
            return this.recordCreated(ledger, options.work, second.repo, { pat, fetchImpl });
        }
        if (second.kind === 'name_taken') {
            throw new EverWorksGitRequestError(
                422,
                `Both ${firstName} and ${fallbackName} are taken in org ${org}.`,
            );
        }
        throw second.error;
    }

    private async tryCreate(args: {
        org: string;
        pat: string;
        visibility: 'private' | 'public';
        fetchImpl: EverWorksGitHttpFetch;
        name: string;
        description?: string;
    }): Promise<
        | { kind: 'ok'; repo: EverWorksGitRepoRef }
        | { kind: 'name_taken' }
        | { kind: 'error'; error: EverWorksGitRequestError }
    > {
        // Platform demo mode: every repository this creates must carry the demo
        // prefix, the one the sweeper deletes by. Checked here, on every name
        // before it is sent, so the collision retry is held to it too.
        assertDemoRepositoryName(args.name);

        const url = `${GITHUB_API_BASE}/orgs/${encodeURIComponent(args.org)}/repos`;
        const response = await args.fetchImpl(url, {
            method: 'POST',
            headers: {
                ...githubHeaders(args.pat),
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                name: args.name,
                description: args.description ?? '',
                private: args.visibility === 'private',
                auto_init: true,
                has_issues: true,
                has_projects: false,
                has_wiki: false,
            }),
        });

        if (response.status === 201) {
            const body = (await response.json()) as GitHubRepoApiResponse;
            return {
                kind: 'ok',
                repo: {
                    id: body.id,
                    owner: body.owner.login,
                    repo: body.name,
                    fullName: body.full_name,
                    htmlUrl: body.html_url,
                    cloneUrl: body.clone_url,
                    privateRepo: body.private,
                },
            };
        }

        const rawText = await safeReadText(response);
        if (response.status === 422 && rawText.includes('name already exists')) {
            return { kind: 'name_taken' };
        }

        let parsedMessage = `GitHub responded ${response.status}`;
        try {
            const parsed = JSON.parse(rawText) as GitHubErrorApiResponse;
            if (parsed?.message) parsedMessage = `${parsedMessage}: ${parsed.message}`;
        } catch {
            // body wasn't JSON — fall through with the raw status message.
        }

        return {
            kind: 'error',
            error: new EverWorksGitRequestError(response.status, parsedMessage, rawText),
        };
    }

    /**
     * Platform demo mode — the live GitHub id of `owner/name`, or `null` when GitHub answers
     * 404 (gone, or not visible to the PAT). Reads `GET /repos/{owner}/{name}` and follows no
     * redirect: a renamed or transferred repository answers 3xx, which is not the repository
     * asked for and throws, as does any other status, or a body naming another repository.
     */
    async getRepositoryId(
        owner: string,
        name: string,
        options: GitHubCallOptions = {},
    ): Promise<number | null> {
        const { pat, fetchImpl } = this.githubAccess(options);
        const response = await fetchImpl(repositoryUrl(owner, name), {
            method: 'GET',
            headers: githubHeaders(pat),
            redirect: 'manual',
        });

        if (response.status === 404) return null;
        if (response.status !== 200) {
            throw await requestError(response, `looking up ${owner}/${name}`);
        }

        const body = (await response.json()) as Partial<GitHubRepoApiResponse>;
        const sameRepository =
            typeof body.full_name === 'string' &&
            body.full_name.toLowerCase() === `${owner}/${name}`.toLowerCase();
        if (!sameRepository || !Number.isSafeInteger(body.id)) {
            throw new EverWorksGitRequestError(
                response.status,
                `GitHub answered ${String(body.full_name)} (id ${String(body.id)}) for ${owner}/${name}`,
            );
        }
        return body.id as number;
    }

    /**
     * Platform demo mode — delete `owner/name` with the platform PAT (`DELETE /repos/{owner}/
     * {name}`, no redirect followed): `'deleted'` on 204, `'gone'` on 404; any other answer
     * throws. Refuses before any GitHub call unless the demo is on, `DEMO_GITHUB_ORG` is set,
     * `owner` is exactly it and `name` starts with `DEMO_REPO_PREFIX`: the PAT can delete every
     * customer repository in the org, so this method can only ever reach a demo one. Which demo
     * repository is the demo sweeper's decision, from its ledger.
     */
    async deleteRepository(
        owner: string,
        name: string,
        options: GitHubCallOptions = {},
    ): Promise<'deleted' | 'gone'> {
        assertDemoDeletionTarget(owner, name);
        const { pat, fetchImpl } = this.githubAccess(options);
        const response = await fetchImpl(repositoryUrl(owner, name), {
            method: 'DELETE',
            headers: githubHeaders(pat),
            redirect: 'manual',
        });

        if (response.status === 204) return 'deleted';
        if (response.status === 404) return 'gone';
        throw await requestError(response, `deleting ${owner}/${name}`);
    }

    /**
     * A repository GitHub just created (201), on a demo instance (a ledger bound); a no-op with
     * the demo off. It is tagged with the demo topic first (best effort, see
     * {@link tagDemoRepository}), then recorded in the demo ledger. A repository that cannot be
     * recorded could never be swept, so the create fails — after an error naming it, for an
     * operator to remove by hand (the topic finds it).
     */
    private async recordCreated(
        ledger: DemoRepoLedgerPort | undefined,
        work: EverWorksProviderWorkRef,
        repo: EverWorksGitRepoRef,
        github: { pat: string; fetchImpl: EverWorksGitHttpFetch },
    ): Promise<EverWorksGitRepoRef> {
        if (!ledger) return repo;
        await this.tagDemoRepository(repo, github);
        const githubId = Number.isSafeInteger(repo.id) ? repo.id : null;
        try {
            await ledger.record({
                sandboxUserId: work.userId,
                owner: repo.owner,
                name: repo.repo,
                githubId,
            });
        } catch (error) {
            this.logger.error(
                `Created demo repository ${repo.fullName} (id ${String(githubId)}) for user ${work.userId} ` +
                    `but could not record it in the demo ledger; the sweeper will not delete it: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
            throw error;
        }
        return repo;
    }

    /**
     * Tags a repository this provider just created with {@link DEMO_REPO_TOPIC}
     * (`PUT /repos/{owner}/{name}/topics`, same PAT and transport as the create). The topics
     * endpoint replaces the whole list, which is safe here: the repository was created a moment
     * ago and has none. Best effort: a refusal or a failed call is logged at warn level and
     * never fails the create or the ledger record.
     */
    private async tagDemoRepository(
        repo: EverWorksGitRepoRef,
        github: { pat: string; fetchImpl: EverWorksGitHttpFetch },
    ): Promise<void> {
        try {
            const response = await github.fetchImpl(
                `${repositoryUrl(repo.owner, repo.repo)}/topics`,
                {
                    method: 'PUT',
                    headers: { ...githubHeaders(github.pat), 'content-type': 'application/json' },
                    body: JSON.stringify({ names: [DEMO_REPO_TOPIC] }),
                    redirect: 'manual',
                },
            );
            if (response.status >= 200 && response.status < 300) return;
            const error = await requestError(response, `tagging ${repo.owner}/${repo.repo}`);
            this.logger.warn(
                `Demo repository ${repo.fullName} not tagged ${DEMO_REPO_TOPIC}: ${error.message}`,
            );
        } catch (error) {
            this.logger.warn(
                `Demo repository ${repo.owner}/${repo.repo} not tagged ${DEMO_REPO_TOPIC}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private logLedgerUnboundOnce(): void {
        if (this.ledgerUnboundLogged) return;
        this.ledgerUnboundLogged = true;
        this.logger.error(DEMO_REPO_LEDGER_UNBOUND_MESSAGE);
    }

    /** The PAT and transport a lookup or delete uses, as `createRepository` resolves them. */
    private githubAccess(options: GitHubCallOptions): {
        pat: string;
        fetchImpl: EverWorksGitHttpFetch;
    } {
        const pat = config.everWorks.git.getPat();
        if (!pat && !options.fetchImpl) {
            throw new EverWorksGitMisconfiguredError('customer GitHub PAT is empty');
        }
        return { pat, fetchImpl: options.fetchImpl ?? fetch };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function githubHeaders(pat: string): Record<string, string> {
    return {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${pat}`,
        'x-github-api-version': '2022-11-28',
    };
}

function repositoryUrl(owner: string, name: string): string {
    return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

async function requestError(response: Response, action: string): Promise<EverWorksGitRequestError> {
    const rawText = await safeReadText(response);
    let message = `GitHub responded ${response.status} ${action}`;
    try {
        const parsed = JSON.parse(rawText) as GitHubErrorApiResponse;
        if (parsed?.message) message = `${message}: ${parsed.message}`;
    } catch {
        // not JSON (or empty, as a redirect is) — the status says enough.
    }
    return new EverWorksGitRequestError(response.status, message, rawText);
}

/** `deleteRepository`'s guard: a demo instance, the demo org exactly, the demo prefix. */
function assertDemoDeletionTarget(owner: string, name: string): void {
    if (!config.demo.isEnabled()) {
        throw new EverWorksGitDeletionRefusedError(owner, name, 'the demo is off');
    }
    const org = config.demo.githubOrg();
    if (!org) {
        throw new EverWorksGitDeletionRefusedError(owner, name, 'DEMO_GITHUB_ORG is not set');
    }
    if (owner !== org) {
        throw new EverWorksGitDeletionRefusedError(owner, name, `the owner is not ${org}`);
    }
    const prefix = config.demo.repoPrefix();
    if (!prefix || !name.startsWith(prefix)) {
        throw new EverWorksGitDeletionRefusedError(
            owner,
            name,
            `the name does not start with ${prefix}`,
        );
    }
}

/**
 * Edge hyphens go by a linear scan: `-` is kept as is here, so a slug can carry a
 * long hyphen run, and `/^-+|-+$/g` is retried from every offset of one that does
 * not end the value (seconds for 50,000 — CodeQL js/polynomial-redos).
 */
function slugify(input: string): string {
    return trimEdgeChars(input.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), '-', '-');
}

function trimRepoName(name: string, reservedSuffixLength = 0): string {
    const limit = REPO_NAME_MAX_LENGTH - reservedSuffixLength;
    if (name.length <= limit) return name;
    return name.slice(0, limit).replace(/-+$/, '');
}

async function safeReadText(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return '';
    }
}
