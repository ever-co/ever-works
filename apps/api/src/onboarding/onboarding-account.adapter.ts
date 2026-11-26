import { randomUUID } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { isAxiosError } from 'axios';
import {
    AuthAccountRepository,
    GitHubAppUserLinkRepository,
    UserRepository,
} from '@ever-works/agent/database';
import type { OnboardingAccountUpsert } from '@ever-works/agent/onboarding';
import { type AccountEmailMatch, findAccountByEmail } from '@src/auth/services/account-email-match';
import { listVerifiedGitHubEmails } from '@src/auth/utils/github-email.utils';
import { UsernameAllocatorService } from '@src/users/services/username-allocator.service';

/**
 * Api-side implementation of `OnboardingAccountUpsert` (T9b).
 *
 * Mirrors the existing `GitHubAppOnboardingService.findOrCreateLocalUser`
 * pattern: looks up the link table → falls back to the auth account by
 * provider account id → falls back to a VERIFIED email → creates a fresh
 * user when nothing matches. Either way we end up with a user row plus an
 * `auth_accounts` row that records the GitHub identity and the latest
 * access token (encrypted at rest by the repository).
 *
 * The email the caller sends (`POST /api/onboarding` is public) is only a
 * claim. It joins an existing user only when GitHub reports it verified for
 * the caller's own account AND that user's email is verified; otherwise the
 * new account gets the noreply address, and the claimed email stays only on
 * the onboarding row (`contactEmail`). A GitHub provider account or App user
 * link the user already has for a DIFFERENT GitHub identity is never
 * re-pointed at the caller's.
 *
 * The resulting `accountId` is the User UUID — the same value used as
 * `userId` everywhere else in the platform.
 */
@Injectable()
export class OnboardingAccountAdapter implements OnboardingAccountUpsert {
    private readonly logger = new Logger(OnboardingAccountAdapter.name);

    /** Wait before the one retry of a transient `GET /user/emails` failure. */
    private readonly emailCheckRetryDelayMs = 500;

    constructor(
        private readonly users: UserRepository,
        private readonly authAccounts: AuthAccountRepository,
        private readonly githubLinks: GitHubAppUserLinkRepository,
        private readonly usernameAllocator: UsernameAllocatorService,
        private readonly httpService: HttpService,
    ) {}

    async upsertFromGithub(input: {
        githubUserId: string;
        login: string;
        email?: string;
        avatarUrl?: string;
        accessToken: string;
    }): Promise<{ accountId: string }> {
        const existingLink = await this.githubLinks.findByGithubUserId(input.githubUserId);
        // Only `id` is read below, which every account found by email carries.
        let user: AccountEmailMatch | null = existingLink
            ? await this.users.findById(existingLink.userId)
            : null;

        if (!user) {
            const existingProviderAccount = await this.authAccounts.findProviderAccountByAccountId(
                'github',
                input.githubUserId,
            );
            if (existingProviderAccount) {
                user = await this.users.findById(existingProviderAccount.userId);
            }
        }

        // Set only when GitHub confirms the claimed address for the caller's account.
        let verifiedEmail: string | null = null;
        if (!user && input.email?.trim()) {
            verifiedEmail = await this.verifiedEmailOfCaller(input.email, input.accessToken);
            if (verifiedEmail) {
                // Exact first, then a unique case-insensitive match, as in the OAuth sign-in: a
                // claimed `Jane@Example.com` finds the stored `jane@example.com` instead of
                // creating a separate account and binding the GitHub identity to it. Accounts
                // that differ only in case are refused (SOCIAL_EMAIL_AMBIGUOUS) before any write.
                const byEmail = await findAccountByEmail(this.users, input.email);
                if (byEmail?.emailVerified) {
                    user = byEmail;
                } else if (byEmail) {
                    // Someone opened that account with the address and never verified it:
                    // joining it would hand the caller's GitHub identity and Work to it, and
                    // it to the caller (pre-hijacking). A separate account instead.
                    this.logger.warn(
                        `onboarding.email_match_refused userId=${byEmail.id} reason=account_email_unverified`,
                    );
                }
            }
        }

        if (!user) {
            const username = await this.resolveUniqueUsername(
                input.login || `agent-${input.githubUserId}`,
            );
            // Never the caller's claimed email: unverified, it would squat someone's address.
            const email = `agent-${input.githubUserId}@users.noreply.ever.works`;
            user = await this.users.create({
                username,
                email,
                password: randomUUID(), // never used for login — provider-only registration
                registrationProvider: 'github',
                avatar: input.avatarUrl || undefined,
                emailVerified: false,
                isActive: true,
                lastLoginAt: new Date(),
            } as any);
            this.logger.log(`onboarding.account_created userId=${user.id} login=${input.login}`);
        } else {
            this.logger.log(`onboarding.account_linked userId=${user.id} login=${input.login}`);
        }

        // `upsertProviderAccount` is keyed by (userId, providerId): a `github` row the user
        // already has for another GitHub identity would be re-pointed at this caller's id and
        // token. Keep it, and skip. A failed lookup skips too: it cannot rule that out.
        const githubAccountSkip = await this.otherIdentitySkipReason(
            () =>
                this.authAccounts
                    .findProviderAccount(user!.id, 'github')
                    .then((row) => row?.accountId ?? null),
            input.githubUserId,
        );
        if (githubAccountSkip) {
            this.logger.warn(
                `onboarding.account_link_skipped userId=${user.id} reason=${githubAccountSkip}`,
            );
        } else {
            await this.authAccounts
                .upsertProviderAccount({
                    userId: user.id,
                    providerId: 'github',
                    accountId: input.githubUserId,
                    username: input.login,
                    email: verifiedEmail,
                    accessToken: input.accessToken,
                    refreshToken: null,
                    accessTokenExpiresAt: null,
                    refreshTokenExpiresAt: null,
                    scope: null,
                    tokenType: 'Bearer',
                    metadata: {
                        providerUserId: input.githubUserId,
                        login: input.login,
                        onboardingChannel: 'agent-zero-friction',
                    },
                } as any)
                .catch((err) => {
                    this.logger.warn(
                        `onboarding.account_link_failed userId=${user!.id} reason=${describeError(err)}`,
                    );
                });
        }

        // `upsertLink` updates the user's existing link in place, whatever GitHub user it names.
        const appLinkSkip = await this.otherIdentitySkipReason(
            () =>
                this.githubLinks.findByUserId(user!.id).then((link) => link?.githubUserId ?? null),
            input.githubUserId,
        );
        if (appLinkSkip) {
            this.logger.warn(`onboarding.gh_link_skipped userId=${user.id} reason=${appLinkSkip}`);
        } else {
            await this.githubLinks
                .upsertLink({
                    userId: user.id,
                    githubUserId: input.githubUserId,
                    githubLogin: input.login,
                    githubNodeId: null,
                    accessToken: input.accessToken,
                    refreshToken: null,
                    accessTokenExpiresAt: null,
                    refreshTokenExpiresAt: null,
                    scope: null,
                } as any)
                .catch((err) => {
                    this.logger.warn(
                        `onboarding.gh_link_failed userId=${user!.id} reason=${describeError(err)}`,
                    );
                });
        }

        return { accountId: user.id };
    }

    /**
     * Why the identity write must be skipped (`other_github_identity`, or `lookup_failed`
     * when the user's current one cannot be read), or null when it may go ahead: the user has
     * no such row yet, or it already names this identity. Fails closed.
     */
    private async otherIdentitySkipReason(
        currentIdentity: () => Promise<string | null>,
        githubUserId: string,
    ): Promise<'other_github_identity' | 'lookup_failed' | null> {
        let current: string | null;
        try {
            current = await currentIdentity();
        } catch (err) {
            this.logger.warn(`onboarding.identity_lookup_failed reason=${describeError(err)}`);
            return 'lookup_failed';
        }
        return current !== null && current !== githubUserId ? 'other_github_identity' : null;
    }

    /**
     * The claimed address, lowercased, when GitHub reports it VERIFIED for the account behind
     * the caller's token (`GET /user/emails`, as the social sign-in reads it); otherwise null.
     * A token that cannot read the addresses, or a failed call, confirms nothing: the caller
     * then gets a separate account rather than somebody else's.
     *
     * A transient failure (5xx, 429 or a rate-limited 403, a timeout or a dropped connection)
     * is retried once. If it still fails, the caller gets a separate account, logged as
     * `onboarding.email_check_unavailable` so an operator can find and merge it later: no
     * reconciler retries an onboarding whose account was already created.
     */
    private async verifiedEmailOfCaller(
        email: string,
        accessToken: string,
    ): Promise<string | null> {
        const claimed = email.trim().toLowerCase();
        const list = () =>
            listVerifiedGitHubEmails(this.httpService, accessToken, { logger: this.logger });
        let verified: string[];
        try {
            verified = await list().catch(async (err) => {
                if (!isTransientGitHubError(err)) throw err;
                await new Promise((resolve) => setTimeout(resolve, this.emailCheckRetryDelayMs));
                return list();
            });
        } catch (err) {
            const code = isTransientGitHubError(err)
                ? 'onboarding.email_check_unavailable'
                : 'onboarding.email_check_failed';
            this.logger.warn(`${code} reason=${describeError(err)}`);
            return null;
        }
        if (!verified.includes(claimed)) {
            this.logger.debug('onboarding.email_not_verified_for_caller: not matched by email');
            return null;
        }
        return claimed;
    }

    /**
     * Pick a username slot that isn't taken yet.
     *
     * Sanitises `base` (alnum + `_` + `-` only, max 32 chars; falls back
     * to `'agent'` if everything was stripped), then probes the users
     * table for `${sanitized}`, `${sanitized}-2`, `${sanitized}-3`, …
     * up to suffix 50.
     *
     * If 50 sequential slots are all taken (extremely unlikely in
     * practice — implies a popular GitHub login plus an aggressively
     * concurrent onboarding flow), short-circuit to
     * `${sanitized}-${randomUUID().slice(0, 8)}` instead of looping
     * forever. The 8-hex-char suffix is enough entropy that a single
     * fall-through call effectively always lands in an unused slot.
     *
     * Race window: the lookup-then-insert is NOT atomic — between
     * `findByUsername` returning null and the eventual `users.create`,
     * a parallel onboarding could grab the same slot. The DB UNIQUE
     * constraint on `users.username` catches the race and the create
     * call throws; the caller is responsible for retrying onboarding
     * if the throw matters to them.
     */
    /**
     * EW-652 (Tenants & Organizations Phase 0) — delegate to the shared
     * `UsernameAllocatorService.allocateUsername`. The previous inline
     * loop's behavior (sanitize + suffix on collision + random fallback)
     * is preserved by the allocator with the same semantics and an
     * identical 10k-attempt safety valve. Method kept as a thin wrapper
     * so the file's public surface and existing test mocks stay stable.
     */
    private async resolveUniqueUsername(base: string): Promise<string> {
        return this.usernameAllocator.allocateUsername(base || 'agent');
    }
}

// Security: strip known GitHub token patterns from error messages before logging to prevent
// credential fragments leaking into log aggregators (Sentry, Datadog) via Octokit error text.
const GITHUB_TOKEN_PATTERN = /\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{10,}\b/g;

/**
 * A GitHub failure worth one retry: no answer at all (a timeout, a dropped connection), a
 * 5xx, a 429, or a 403 carrying GitHub's rate-limit markers.
 */
function isTransientGitHubError(err: unknown): boolean {
    if (!isAxiosError(err)) return false;
    const response = err.response;
    if (!response) return true;
    if (response.status >= 500 || response.status === 429) return true;
    const headers = response.headers ?? {};
    return (
        response.status === 403 &&
        (String(headers['x-ratelimit-remaining']) === '0' || headers['retry-after'] != null)
    );
}

function describeError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
}
