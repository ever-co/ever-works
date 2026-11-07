import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { GitHubAppInstallationRepository, WorkRepository } from '@ever-works/agent/database';
import { config } from '@ever-works/agent/config';
import type { Work } from '@ever-works/agent/entities';
import {
    createGitHubAppHeaders,
    createGitHubAppJwt,
    requestGitHubAppInstallationAccessTokenDetails,
} from '@ever-works/agent/utils';

/** Runtime env key: the URL a site POSTs to for a fresh token. */
export const SITE_GIT_TOKEN_URL_ENV = 'EVER_WORKS_SITE_GIT_TOKEN_URL';
/** Runtime env key: the site's own broker credential (bearer). */
export const SITE_GIT_TOKEN_SECRET_ENV = 'EVER_WORKS_SITE_GIT_TOKEN_SECRET';

/** Prefix of a site broker secret, so a leaked one is recognisable in a scan. */
const SITE_SECRET_PREFIX = 'ewsgt_';
/** Domain separation for the HMAC: a derived value means nothing elsewhere. */
const SITE_SECRET_LABEL = 'ever-works/site-git-token/v1:';
const MIN_SIGNING_KEY_LENGTH = 32;
const DEFAULT_MANAGED_ORGS = ['ever-works', 'ever-works-cloud'];
/** A cached token is handed out again only while it has this much life left. */
const REUSE_MIN_REMAINING_MS = 20 * 60_000;
/** GitHub always expires an installation token within the hour. */
const FALLBACK_TOKEN_TTL_MS = 55 * 60_000;
const INSTALLATION_CACHE_TTL_MS = 10 * 60_000;
/** A bare GitHub repository name (no owner). */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Why the broker did not issue a token. Stable machine tokens: the
 * controller maps them to HTTP statuses and the deploy path to log lines.
 * None of them names an installation id, a key or a token.
 */
export type SiteGitTokenRefusal =
    | 'disabled'
    | 'not-configured'
    | 'unmanaged-owner'
    | 'invalid-repository'
    | 'no-installation'
    | 'mint-failed';

export class SiteGitTokenError extends Error {
    constructor(readonly reason: SiteGitTokenRefusal) {
        super(reason);
        this.name = 'SiteGitTokenError';
    }
}

export interface SiteGitTokenTarget {
    /** The data repo's owner (a managed org), lower-cased. */
    readonly owner: string;
    /** The data repo's bare name. */
    readonly repo: string;
    /** GitHub's numeric installation id for `owner`. */
    readonly installationId: string;
}

export interface MintedSiteGitToken {
    readonly token: string;
    /** ISO instant. */
    readonly expiresAt: string;
    /** `owner/repo` the token is narrowed to. */
    readonly repository: string;
}

/** What a site gets at deploy time when the broker applies. */
export interface BrokeredSiteGitEnv {
    readonly url: string;
    readonly secret: string;
    /**
     * A first token minted at deploy, so the site (and a build that runs
     * right after the deploy) works before its first broker call. Null when
     * that mint failed; the site then fetches one at runtime.
     */
    readonly bootstrap: MintedSiteGitToken | null;
}

/**
 * Per-site git credentials for directory sites (security audit 2026-11-07).
 *
 * ## The problem this closes
 *
 * A deployed directory site needs to clone, pull and push ITS OWN data
 * repository. Until now its `GH_TOKEN` was either the deploying user's OAuth
 * token (`repo`, `workflow`, `delete_repo` on every repository they own) or,
 * since #3109, one platform token per org. A per-org token reaches every
 * repository in that org, so one compromised site could rewrite every other
 * site's data, and in `ever-works-cloud` (one repo per customer) that is
 * cross-tenant.
 *
 * ## What this does instead
 *
 * The platform's GitHub App mints an installation token narrowed AT MINT
 * TIME to one repository (`repositories: ["<slug>-data"]`) and one
 * permission (`contents: write`; `metadata: read` is implied). It lives one
 * hour. The site refreshes it from `POST /api/sites/:workId/git-token`,
 * authenticated by a per-site secret.
 *
 * - **The per-site secret is derived, not stored**: HMAC-SHA256 of the Work
 *   id under `EVER_WORKS_SITE_GIT_TOKEN_KEY`. No column, no migration, and
 *   a new Work is covered the moment it is deployed. Rotating the key
 *   rotates every site's secret (each site picks the new one up at its next
 *   deploy). A leaked secret can only ever mint a token for that one Work's
 *   data repo.
 * - **The repository comes from platform state** (the Work row), never from
 *   the request. The request names only the Work, and the secret proves the
 *   caller is that Work's site.
 * - **Only managed orgs** (`EVER_WORKS_SITE_GIT_TOKEN_ORGS`, default
 *   `ever-works,ever-works-cloud`): those are the orgs whose installation the
 *   platform owns. A Work whose data repo lives anywhere else keeps the
 *   existing env-token path.
 * - **Off by default** (`EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED=true` turns
 *   it on). Off, or missing a piece, the deploy keeps today's behaviour.
 * - **No token is logged or stored.** Tokens live in process memory, cached
 *   per Work until 20 minutes before expiry so a busy site does not mint one
 *   per request.
 */
@Injectable()
export class SiteGitTokenService {
    private readonly logger = new Logger(SiteGitTokenService.name);
    private readonly tokenCache = new Map<
        string,
        { minted: MintedSiteGitToken; expiresAtMs: number }
    >();
    private readonly inflight = new Map<string, Promise<MintedSiteGitToken>>();
    private readonly installationCache = new Map<
        string,
        { installationId: string | null; cachedAtMs: number }
    >();

    constructor(
        private readonly installations: GitHubAppInstallationRepository,
        private readonly works: WorkRepository,
    ) {}

    /** `EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED=true`. Default off. */
    static isEnabled(): boolean {
        return (
            (process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED || '').trim().toLowerCase() ===
            'true'
        );
    }

    /** Orgs whose sites the broker serves, lower-cased. */
    static managedOrgs(): string[] {
        const raw = (process.env.EVER_WORKS_SITE_GIT_TOKEN_ORGS || '').trim();
        if (!raw) return [...DEFAULT_MANAGED_ORGS];
        return raw
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter((value) => value.length > 0);
    }

    /**
     * Which piece is missing for the broker to work, or null when none is.
     * Checked before anything else so a half-configured environment falls
     * back to today's path instead of handing sites a broker that refuses.
     */
    configurationGap(): SiteGitTokenRefusal | null {
        if (!SiteGitTokenService.isEnabled()) return 'disabled';
        if (!this.signingKey() || !this.brokerBaseUrl() || !this.appCredentials()) {
            return 'not-configured';
        }
        return null;
    }

    /** The site's broker secret, or null when no signing key is configured. */
    deriveSecret(workId: string): string | null {
        const key = this.signingKey();
        if (!key || !workId) return null;
        const mac = createHmac('sha256', key).update(`${SITE_SECRET_LABEL}${workId}`).digest('hex');
        return `${SITE_SECRET_PREFIX}${mac}`;
    }

    /** Constant-time check of a presented secret against the derived one. */
    verifySecret(workId: string, presented: string | undefined | null): boolean {
        const expected = this.deriveSecret(workId);
        if (!expected || typeof presented !== 'string') return false;
        const expectedBuf = Buffer.from(expected, 'utf8');
        const presentedBuf = Buffer.from(presented.trim(), 'utf8');
        // Compare against an equal-length buffer either way so the cost does
        // not depend on the presented length (same posture as
        // PlatformSecretGuard).
        const lengthsMatch = expectedBuf.length === presentedBuf.length;
        const comparison = lengthsMatch ? presentedBuf : Buffer.alloc(expectedBuf.length);
        const bytesMatch = timingSafeEqual(expectedBuf, comparison);
        return lengthsMatch && bytesMatch;
    }

    /** The URL a site POSTs to, or null when no base URL is configured. */
    brokerUrl(workId: string): string | null {
        const base = this.brokerBaseUrl();
        if (!base) return null;
        return `${base}/api/sites/${encodeURIComponent(workId)}/git-token`;
    }

    /**
     * The data repo this Work's site may receive a token for. Throws
     * {@link SiteGitTokenError}; makes no GitHub call except, on a cache
     * miss with no installation row, the App's own installation lookup.
     */
    async resolveTarget(work: Work): Promise<SiteGitTokenTarget> {
        const owner = (work.getRepoOwner('data') || '').trim().toLowerCase();
        if (!owner || !SiteGitTokenService.managedOrgs().includes(owner)) {
            throw new SiteGitTokenError('unmanaged-owner');
        }
        const repo = SiteGitTokenService.bareRepositoryName(work.getDataRepo(), owner);
        if (!repo) throw new SiteGitTokenError('invalid-repository');
        const installationId = await this.installationIdFor(owner);
        if (!installationId) throw new SiteGitTokenError('no-installation');
        return { owner, repo, installationId };
    }

    /** A token for this Work's data repo, from cache while it has life left. */
    async mintForWork(work: Work): Promise<MintedSiteGitToken> {
        const gap = this.configurationGap();
        if (gap) throw new SiteGitTokenError(gap);
        const target = await this.resolveTarget(work);
        const repository = `${target.owner}/${target.repo}`;

        const cached = this.tokenCache.get(work.id);
        if (
            cached &&
            cached.minted.repository === repository &&
            cached.expiresAtMs - Date.now() > REUSE_MIN_REMAINING_MS
        ) {
            return cached.minted;
        }
        const pending = this.inflight.get(work.id);
        if (pending) return pending;

        const request = this.mint(work.id, target).finally(() => {
            this.inflight.delete(work.id);
        });
        this.inflight.set(work.id, request);
        return request;
    }

    /**
     * Deploy time: the env this Work's site gets when the broker applies, or
     * null when it does not (disabled, half-configured, unmanaged owner, no
     * installation), in which case the caller keeps today's env-token path.
     * Never throws.
     */
    async siteEnvFor(work: Work): Promise<BrokeredSiteGitEnv | null> {
        const gap = this.configurationGap();
        if (gap === 'disabled') return null;
        if (gap) {
            this.logger.warn(
                `Site git token broker is enabled but not configured (needs EVER_WORKS_SITE_GIT_TOKEN_KEY, ` +
                    `a broker URL and the GitHub App); work ${work.id} keeps the env-token path`,
            );
            return null;
        }
        try {
            await this.resolveTarget(work);
        } catch (error) {
            const reason = error instanceof SiteGitTokenError ? error.reason : 'mint-failed';
            if (reason !== 'unmanaged-owner') {
                this.logger.error(
                    `Work ${work.id}: site git token broker cannot serve its data repo (${reason}); ` +
                        `keeping the env-token path`,
                );
            }
            return null;
        }
        const url = this.brokerUrl(work.id) as string;
        const secret = this.deriveSecret(work.id) as string;
        let bootstrap: MintedSiteGitToken | null = null;
        try {
            bootstrap = await this.mintForWork(work);
        } catch (error) {
            this.logger.error(
                `Work ${work.id}: bootstrap site git token not minted (${
                    error instanceof SiteGitTokenError ? error.reason : 'mint-failed'
                }); the site will fetch one from the broker at runtime`,
            );
        }
        return { url, secret, bootstrap };
    }

    /**
     * The broker endpoint. Returns null when the caller is not this Work's
     * site (bad or missing secret, unknown Work): the controller answers the
     * same 401 for both so a caller cannot enumerate Work ids. Throws
     * {@link SiteGitTokenError} when the caller IS the site but no token can
     * be issued.
     */
    async mintForSite(
        workId: string,
        presentedSecret: string | undefined | null,
    ): Promise<MintedSiteGitToken | null> {
        const gap = this.configurationGap();
        if (gap) throw new SiteGitTokenError(gap);
        // The secret is checked BEFORE the Work is read, so a guessing caller
        // costs one HMAC and no database round-trip.
        if (!this.verifySecret(workId, presentedSecret)) return null;
        const work = await this.works.findById(workId);
        if (!work) return null;
        const minted = await this.mintForWork(work);
        this.logger.log(
            `Work ${workId}: site git token issued for ${minted.repository} (expires ${minted.expiresAt})`,
        );
        return minted;
    }

    /**
     * `DATA_REPOSITORY` may be a bare name or a full URL; the token is minted
     * by bare name inside `owner`'s installation. A URL naming a different
     * owner or host is refused rather than reconciled.
     */
    static bareRepositoryName(raw: string, owner: string): string | null {
        let name = (raw || '').trim();
        if (/^https?:\/\//i.test(name) || name.startsWith('git@')) {
            const match = name.match(
                /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
            );
            if (!match || match[1].toLowerCase() !== owner) return null;
            name = match[2];
        }
        if (!REPOSITORY_NAME.test(name) || name === '.' || name === '..') return null;
        return name;
    }

    private async mint(workId: string, target: SiteGitTokenTarget): Promise<MintedSiteGitToken> {
        const credentials = this.appCredentials();
        if (!credentials) throw new SiteGitTokenError('not-configured');
        const repository = `${target.owner}/${target.repo}`;
        let result: { token: string; expiresAt: string | null };
        try {
            result = await requestGitHubAppInstallationAccessTokenDetails(
                target.installationId,
                credentials,
                {
                    repositoryNames: [target.repo],
                    // The ONE permission a site's data repo needs: clone, pull,
                    // commit and push. Never `workflows` (a site must not be
                    // able to add a workflow to its data repo), never
                    // `administration` (no delete / transfer / visibility).
                    permissions: { contents: 'write' },
                },
            );
        } catch (error) {
            // The message can name the installation; it stays in this log.
            this.logger.error(
                `Work ${workId}: site git token mint failed for ${repository}: ${
                    error instanceof Error ? error.message : 'unknown error'
                }`,
            );
            throw new SiteGitTokenError('mint-failed');
        }
        const parsed = result.expiresAt ? Date.parse(result.expiresAt) : Number.NaN;
        const expiresAtMs = Number.isFinite(parsed) ? parsed : Date.now() + FALLBACK_TOKEN_TTL_MS;
        const minted: MintedSiteGitToken = {
            token: result.token,
            expiresAt: new Date(expiresAtMs).toISOString(),
            repository,
        };
        this.tokenCache.set(workId, { minted, expiresAtMs });
        return minted;
    }

    /**
     * The App's installation id on `owner`: the platform's own installation
     * row first, then GitHub's `GET /orgs/{org}/installation` (an App-JWT
     * call), so an org whose installation row was never synced still works.
     * Cached for ten minutes, misses included.
     */
    private async installationIdFor(owner: string): Promise<string | null> {
        const cached = this.installationCache.get(owner);
        if (cached && Date.now() - cached.cachedAtMs < INSTALLATION_CACHE_TTL_MS) {
            return cached.installationId;
        }
        let installationId: string | null = null;
        try {
            const row = await this.installations.findActiveByAccountLogin(owner);
            if (row && !row.deletedAt && !row.suspendedAt && row.installationId) {
                installationId = String(row.installationId);
            }
        } catch (error) {
            this.logger.warn(
                `Installation lookup for ${owner} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        if (!installationId) installationId = await this.lookupInstallationOnGitHub(owner);
        this.installationCache.set(owner, { installationId, cachedAtMs: Date.now() });
        return installationId;
    }

    private async lookupInstallationOnGitHub(owner: string): Promise<string | null> {
        const credentials = this.appCredentials();
        if (!credentials) return null;
        try {
            const response = await fetch(
                `https://api.github.com/orgs/${encodeURIComponent(owner)}/installation`,
                { headers: createGitHubAppHeaders(createGitHubAppJwt(credentials)) },
            );
            if (!response.ok) return null;
            const body = (await response.json()) as {
                id?: number | string;
                suspended_at?: string | null;
            };
            if (body.suspended_at) return null;
            const id = body.id === undefined || body.id === null ? '' : String(body.id);
            return /^[0-9]+$/.test(id) ? id : null;
        } catch (error) {
            this.logger.warn(
                `GitHub installation lookup for ${owner} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    private signingKey(): string | null {
        const key = (process.env.EVER_WORKS_SITE_GIT_TOKEN_KEY || '').trim();
        return key.length >= MIN_SIGNING_KEY_LENGTH ? key : null;
    }

    /**
     * The platform API's public origin as a SITE reaches it:
     * `EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL`, else `PUBLIC_API_URL`, else
     * `PLATFORM_API_URL`. https only (the secret is a bearer), except
     * localhost for development.
     */
    private brokerBaseUrl(): string | null {
        const candidates = [
            process.env.EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL,
            process.env.PUBLIC_API_URL,
            process.env.PLATFORM_API_URL,
        ];
        for (const candidate of candidates) {
            const value = (candidate || '').trim().replace(/\/+$/, '');
            if (!value) continue;
            let parsed: URL;
            try {
                parsed = new URL(value);
            } catch {
                continue;
            }
            const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
            if (parsed.protocol === 'https:' || (local && parsed.protocol === 'http:')) {
                // The ORIGIN: the API mounts its routes at `/api/...` itself
                // (no global prefix), so a base that already ends in `/api`
                // must not become `/api/api/sites/...`.
                return parsed.origin;
            }
        }
        return null;
    }

    private appCredentials(): { appId: string; privateKey: string } | null {
        const appId = config.githubApp.getAppId();
        const privateKey = config.githubApp.getPrivateKey();
        if (!appId || !privateKey) return null;
        return { appId, privateKey };
    }
}
