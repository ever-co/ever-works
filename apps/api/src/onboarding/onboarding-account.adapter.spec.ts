jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/onboarding', () => ({}));

import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { OnboardingAccountAdapter } from './onboarding-account.adapter';

describe('OnboardingAccountAdapter', () => {
    // Logger spies are restored even when an assertion fails, so they never leak into later tests.
    afterEach(() => {
        jest.restoreAllMocks();
    });

    const httpError = (status: number, headers: Record<string, string> = {}) =>
        new AxiosError(
            `Request failed with status code ${status}`,
            status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
            { headers: {} } as never,
            {},
            { status, statusText: 'error', data: {}, headers, config: { headers: {} } as never },
        );
    const warnings = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0])).join('\n');
    type Mocks = {
        users: {
            findById: jest.Mock;
            findByEmail: jest.Mock;
            findByUsername: jest.Mock;
            create: jest.Mock;
        };
        authAccounts: {
            findProviderAccountByAccountId: jest.Mock;
            findProviderAccount: jest.Mock;
            upsertProviderAccount: jest.Mock;
        };
        githubLinks: {
            findByGithubUserId: jest.Mock;
            findByUserId: jest.Mock;
            upsertLink: jest.Mock;
        };
        httpService: { get: jest.Mock };
        // EW-652: usernameAllocator replaces the previous inline
        // sanitization+collision loop. Normalization edge cases live in
        // the allocator's own spec; this mock just preserves the collision
        // semantics needed by the integration-level tests below.
        usernameAllocator: {
            allocateUsername: jest.Mock;
            normalize: jest.Mock;
            suggest: jest.Mock;
        };
    };

    const baseInput = {
        githubUserId: '12345',
        login: 'octocat',
        email: 'octo@example.com',
        avatarUrl: 'https://example.com/avatar.png',
        accessToken: 'gh_token',
    };

    const create = (
        overrides: {
            link?: { userId: string } | null;
            userById?: { id: string } | null;
            providerAccount?: { userId: string } | null;
            userByEmail?: { id: string; emailVerified?: boolean } | null;
            existingUsernames?: string[];
            /** What GitHub's `GET /user/emails` answers for the caller's token. */
            githubEmails?: Array<{ email: string; verified?: boolean }> | Error;
            /** The `github` provider row the resolved user already has. */
            githubAccount?: { accountId: string } | null;
            /** The GitHub App user link the resolved user already has. */
            appLink?: { githubUserId: string } | null;
        } = {},
    ): { adapter: OnboardingAccountAdapter; mocks: Mocks } => {
        const usernameQueue = new Set(overrides.existingUsernames ?? []);
        const mocks: Mocks = {
            users: {
                findById: jest
                    .fn()
                    .mockImplementation(async (id: string) =>
                        overrides.userById && overrides.userById.id === id
                            ? overrides.userById
                            : null,
                    ),
                findByEmail: jest.fn().mockResolvedValue(overrides.userByEmail ?? null),
                findByUsername: jest
                    .fn()
                    .mockImplementation(async (name: string) =>
                        usernameQueue.has(name) ? { id: 'taken', username: name } : null,
                    ),
                create: jest
                    .fn()
                    .mockImplementation(async (data: any) => ({ id: 'new-user-id', ...data })),
            },
            authAccounts: {
                findProviderAccountByAccountId: jest
                    .fn()
                    .mockResolvedValue(overrides.providerAccount ?? null),
                findProviderAccount: jest.fn().mockResolvedValue(overrides.githubAccount ?? null),
                upsertProviderAccount: jest.fn().mockResolvedValue(undefined),
            },
            githubLinks: {
                findByGithubUserId: jest.fn().mockResolvedValue(overrides.link ?? null),
                findByUserId: jest.fn().mockResolvedValue(overrides.appLink ?? null),
                upsertLink: jest.fn().mockResolvedValue(undefined),
            },
            httpService: {
                get: jest
                    .fn()
                    .mockReturnValue(
                        overrides.githubEmails instanceof Error
                            ? throwError(() => overrides.githubEmails)
                            : of({ data: overrides.githubEmails ?? [] }),
                    ),
            },
            usernameAllocator: {
                // Identity by default, plus the existing-username collision
                // semantics so the "appends -<n> when taken" test still works.
                allocateUsername: jest.fn().mockImplementation(async (base: string) => {
                    let candidate = base;
                    let suffix = 1;
                    while (usernameQueue.has(candidate)) {
                        suffix += 1;
                        candidate = `${base}-${suffix}`;
                    }
                    return candidate;
                }),
                normalize: jest.fn().mockImplementation((s: string) => s),
                suggest: jest.fn(),
            },
        };
        const adapter = new OnboardingAccountAdapter(
            mocks.users as any,
            mocks.authAccounts as any,
            mocks.githubLinks as any,
            mocks.usernameAllocator as any,
            mocks.httpService as any,
        );
        // No real wait before the one retry of a transient GitHub failure.
        (adapter as unknown as { emailCheckRetryDelayMs: number }).emailCheckRetryDelayMs = 0;
        return { adapter, mocks };
    };

    it('returns the linked user when github_app_user_link exists', async () => {
        const { adapter, mocks } = create({
            link: { userId: 'user-from-link' },
            userById: { id: 'user-from-link' },
        });

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result).toEqual({ accountId: 'user-from-link' });
        expect(mocks.githubLinks.findByGithubUserId).toHaveBeenCalledWith('12345');
        expect(mocks.users.findById).toHaveBeenCalledWith('user-from-link');
        expect(mocks.authAccounts.findProviderAccountByAccountId).not.toHaveBeenCalled();
        expect(mocks.users.findByEmail).not.toHaveBeenCalled();
        expect(mocks.httpService.get).not.toHaveBeenCalled();
        expect(mocks.users.create).not.toHaveBeenCalled();
    });

    it('falls back to auth_accounts provider lookup when no link exists', async () => {
        const { adapter, mocks } = create({
            link: null,
            providerAccount: { userId: 'user-from-provider' },
            userById: { id: 'user-from-provider' },
        });

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('user-from-provider');
        expect(mocks.authAccounts.findProviderAccountByAccountId).toHaveBeenCalledWith(
            'github',
            '12345',
        );
        expect(mocks.users.findByEmail).not.toHaveBeenCalled();
        expect(mocks.httpService.get).not.toHaveBeenCalled();
        expect(mocks.users.create).not.toHaveBeenCalled();
    });

    it('joins an existing VERIFIED user by an email GitHub verifies for the caller', async () => {
        const { adapter, mocks } = create({
            link: null,
            providerAccount: null,
            githubEmails: [{ email: 'Octo@Example.com', verified: true }],
            userByEmail: { id: 'user-from-email', emailVerified: true },
        });

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('user-from-email');
        expect(mocks.httpService.get).toHaveBeenCalledWith(
            'https://api.github.com/user/emails',
            expect.objectContaining({ headers: expect.any(Object) }),
        );
        expect(mocks.users.findByEmail).toHaveBeenCalledWith('octo@example.com');
        expect(mocks.users.create).not.toHaveBeenCalled();
        expect(mocks.authAccounts.upsertProviderAccount).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-from-email',
                accountId: '12345',
                email: 'octo@example.com',
            }),
        );
        expect(mocks.githubLinks.upsertLink).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-from-email', githubUserId: '12345' }),
        );
    });

    // `POST /api/onboarding` is public: `body.email` is only the caller's claim. Matched by it
    // alone, any caller with a GitHub token could attach their identity, token and a Work to
    // whoever owns that address.
    describe('a claimed email the caller cannot prove never reaches another account', () => {
        const expectSeparateAccount = (
            mocks: Mocks,
            result: { accountId: string },
            githubAccountEmail: string | null = null,
        ) => {
            expect(result.accountId).toBe('new-user-id');
            expect(mocks.users.create).toHaveBeenCalledTimes(1);
            expect(mocks.users.create.mock.calls[0][0]).toMatchObject({
                email: 'agent-12345@users.noreply.ever.works',
                emailVerified: false,
            });
            for (const [arg] of [
                ...mocks.authAccounts.upsertProviderAccount.mock.calls,
                ...mocks.githubLinks.upsertLink.mock.calls,
            ]) {
                expect(arg.userId).toBe('new-user-id');
            }
            // The GitHub row records an email only when GitHub verified it for the caller.
            expect(mocks.authAccounts.upsertProviderAccount.mock.calls[0][0].email).toBe(
                githubAccountEmail,
            );
        };

        it.each([
            [
                'not among the GitHub account emails',
                [{ email: 'caller@example.com', verified: true }],
            ],
            ['listed by GitHub but unverified', [{ email: 'octo@example.com', verified: false }]],
            ['a token with no email list', []],
        ])(
            'an email %s matches nobody, even a verified user who has it',
            async (_label, githubEmails) => {
                const { adapter, mocks } = create({
                    githubEmails,
                    userByEmail: { id: 'victim', emailVerified: true },
                });

                const result = await adapter.upsertFromGithub(baseInput);

                expect(mocks.users.findByEmail).not.toHaveBeenCalled();
                expectSeparateAccount(mocks, result);
            },
        );

        it('a verified GitHub email does not join a user whose OWN email is unverified', async () => {
            const { adapter, mocks } = create({
                githubEmails: [{ email: 'octo@example.com', verified: true }],
                userByEmail: { id: 'squatter', emailVerified: false },
            });
            const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

            const result = await adapter.upsertFromGithub(baseInput);

            expect(mocks.users.findByEmail).toHaveBeenCalledWith('octo@example.com');
            // The caller's own verified address, on the caller's own new account.
            expectSeparateAccount(mocks, result, 'octo@example.com');
            expect(warnings(warnSpy)).toContain(
                'email_match_refused userId=squatter reason=account_email_unverified',
            );
        });

        it.each([
            [
                'cannot read the email list (403)',
                new AxiosError(
                    'forbidden',
                    AxiosError.ERR_BAD_REQUEST,
                    { headers: {} } as never,
                    {},
                    {
                        status: 403,
                        statusText: 'Forbidden',
                        data: {},
                        headers: {},
                        config: { headers: {} } as never,
                    },
                ),
            ],
            ['fails to answer', new Error('socket hang up')],
        ])('a token that %s confirms nothing', async (_label, error) => {
            const { adapter, mocks } = create({
                githubEmails: error,
                userByEmail: { id: 'victim', emailVerified: true },
            });
            const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

            const result = await adapter.upsertFromGithub(baseInput);

            expect(mocks.users.findByEmail).not.toHaveBeenCalled();
            expectSeparateAccount(mocks, result);
            expect(warnings(warnSpy)).not.toContain('email_check_unavailable');
        });

        it('retries a transient failure once, and matches when the retry answers', async () => {
            const { adapter, mocks } = create({
                userByEmail: { id: 'owner', emailVerified: true },
            });
            mocks.httpService.get
                .mockReset()
                .mockReturnValueOnce(throwError(() => httpError(503)))
                .mockReturnValueOnce(of({ data: [{ email: 'octo@example.com', verified: true }] }));

            const result = await adapter.upsertFromGithub(baseInput);

            expect(mocks.httpService.get).toHaveBeenCalledTimes(2);
            expect(result.accountId).toBe('owner');
            expect(mocks.users.create).not.toHaveBeenCalled();
        });

        it.each([
            ['a 5xx', httpError(502)],
            ['a 429', httpError(429)],
            ['a rate-limited 403', httpError(403, { 'x-ratelimit-remaining': '0' })],
            [
                'a timeout',
                new AxiosError('timeout of 10000ms exceeded', AxiosError.ECONNABORTED, {
                    headers: {},
                } as never),
            ],
        ])(
            'still failing after the one retry (%s), it gives a separate account logged as email_check_unavailable',
            async (_label, error) => {
                const { adapter, mocks } = create({
                    githubEmails: error,
                    userByEmail: { id: 'owner', emailVerified: true },
                });
                const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

                const result = await adapter.upsertFromGithub(baseInput);

                expect(mocks.httpService.get).toHaveBeenCalledTimes(2);
                expect(mocks.users.findByEmail).not.toHaveBeenCalled();
                expectSeparateAccount(mocks, result);
                expect(warnings(warnSpy)).toContain('onboarding.email_check_unavailable');
            },
        );

        it('does not retry a failure that is not transient', async () => {
            const { adapter, mocks } = create({
                githubEmails: httpError(401),
                userByEmail: { id: 'owner', emailVerified: true },
            });
            const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

            const result = await adapter.upsertFromGithub(baseInput);

            expect(mocks.httpService.get).toHaveBeenCalledTimes(1);
            expectSeparateAccount(mocks, result);
            expect(warnings(warnSpy)).toContain('onboarding.email_check_failed');
        });
    });

    describe('never re-points a GitHub identity the user already has at the caller', () => {
        it('keeps a `github` provider row and an App user link for a DIFFERENT GitHub identity', async () => {
            const { adapter, mocks } = create({
                githubEmails: [{ email: 'octo@example.com', verified: true }],
                userByEmail: { id: 'owner', emailVerified: true },
                githubAccount: { accountId: 'owners-own-github-id' },
                appLink: { githubUserId: 'owners-own-github-id' },
            });
            const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

            const result = await adapter.upsertFromGithub(baseInput);

            expect(result.accountId).toBe('owner');
            expect(mocks.authAccounts.findProviderAccount).toHaveBeenCalledWith('owner', 'github');
            expect(mocks.githubLinks.findByUserId).toHaveBeenCalledWith('owner');
            expect(mocks.authAccounts.upsertProviderAccount).not.toHaveBeenCalled();
            expect(mocks.githubLinks.upsertLink).not.toHaveBeenCalled();
            expect(warnings(warnSpy)).toContain(
                'account_link_skipped userId=owner reason=other_github_identity',
            );
            expect(warnings(warnSpy)).toContain(
                'gh_link_skipped userId=owner reason=other_github_identity',
            );
        });

        it('skips both writes when the current identity cannot be read (fails closed)', async () => {
            const { adapter, mocks } = create({
                link: { userId: 'linked' },
                userById: { id: 'linked' },
            });
            mocks.authAccounts.findProviderAccount.mockRejectedValue(new Error('db unavailable'));
            mocks.githubLinks.findByUserId.mockRejectedValue(new Error('db unavailable'));
            const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

            const result = await adapter.upsertFromGithub(baseInput);

            expect(result.accountId).toBe('linked');
            expect(mocks.authAccounts.upsertProviderAccount).not.toHaveBeenCalled();
            expect(mocks.githubLinks.upsertLink).not.toHaveBeenCalled();
            expect(warnings(warnSpy)).toContain(
                'account_link_skipped userId=linked reason=lookup_failed',
            );
            expect(warnings(warnSpy)).toContain(
                'gh_link_skipped userId=linked reason=lookup_failed',
            );
        });

        it('applies to identity-first matches too, and still refreshes rows for the SAME identity', async () => {
            const { adapter, mocks } = create({
                link: { userId: 'linked' },
                userById: { id: 'linked' },
                githubAccount: { accountId: 'someone-else' },
                appLink: { githubUserId: '12345' },
            });

            const result = await adapter.upsertFromGithub(baseInput);

            expect(result.accountId).toBe('linked');
            expect(mocks.authAccounts.upsertProviderAccount).not.toHaveBeenCalled();
            expect(mocks.githubLinks.upsertLink).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'linked', githubUserId: '12345' }),
            );
        });

        it('refreshes a `github` provider row that already names this identity', async () => {
            const { adapter, mocks } = create({
                providerAccount: { userId: 'by-provider' },
                userById: { id: 'by-provider' },
                githubAccount: { accountId: '12345' },
            });

            await adapter.upsertFromGithub(baseInput);

            expect(mocks.authAccounts.upsertProviderAccount).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'by-provider', accountId: '12345' }),
            );
        });
    });

    it('skips email fallback when input.email is missing', async () => {
        const { adapter, mocks } = create({
            link: null,
            providerAccount: null,
        });

        await adapter.upsertFromGithub({ ...baseInput, email: undefined });

        expect(mocks.users.findByEmail).not.toHaveBeenCalled();
        expect(mocks.users.create).toHaveBeenCalledTimes(1);
    });

    it('creates a new user using login as username and the noreply email when nothing matches', async () => {
        const { adapter, mocks } = create({});

        const result = await adapter.upsertFromGithub(baseInput);

        expect(mocks.users.create).toHaveBeenCalledTimes(1);
        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('octocat');
        // The claimed email stays on the onboarding row (`contactEmail`), never on the account.
        expect(created.email).toBe('agent-12345@users.noreply.ever.works');
        expect(created.registrationProvider).toBe('github');
        expect(created.avatar).toBe('https://example.com/avatar.png');
        expect(created.emailVerified).toBe(false);
        expect(created.isActive).toBe(true);
        expect(created.lastLoginAt).toBeInstanceOf(Date);
        // password is randomUUID() — never used for login but must be set
        expect(typeof created.password).toBe('string');
        expect(created.password.length).toBeGreaterThan(0);
        expect(result.accountId).toBe('new-user-id');
    });

    it('falls back to a synthetic noreply email when input.email is not provided', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, email: undefined });

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.email).toBe('agent-12345@users.noreply.ever.works');
    });

    it('falls back to agent-<id> username when login is empty', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, login: '' });

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('agent-12345');
    });

    // EW-652: sanitization-specific assertions moved to
    // `username-allocator.service.spec.ts`. The adapter itself just hands the
    // raw `input.login` (or `agent-<gh-id>` fallback) to the allocator; the
    // allocator owns the normalization rules. The two tests below cover the
    // adapter↔allocator contract:
    //   1. The adapter delegates with the right base.
    //   2. Collision suffixing still produces the expected username in the
    //      created user row (covered by the mock allocator's queue logic).

    it('delegates the username to the allocator with the raw login as base', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, login: 'oct.o cat!' });

        // Adapter passes the raw login through — normalization happens in the
        // allocator (verified in its dedicated spec). The mock allocator here
        // is an identity, so the raw input survives into `users.create`.
        expect(mocks.usernameAllocator.allocateUsername).toHaveBeenCalledWith('oct.o cat!');
        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('oct.o cat!');
    });

    it('appends -<n> when username is taken (via allocator)', async () => {
        const { adapter, mocks } = create({ existingUsernames: ['octocat'] });

        await adapter.upsertFromGithub(baseInput);

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('octocat-2');
        // Allocator handles collision detection internally — the adapter no
        // longer calls userRepository.findByUsername itself.
        expect(mocks.usernameAllocator.allocateUsername).toHaveBeenCalledWith('octocat');
    });

    it('upserts the provider account row with the expected fields', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub(baseInput);

        expect(mocks.authAccounts.upsertProviderAccount).toHaveBeenCalledTimes(1);
        const arg = mocks.authAccounts.upsertProviderAccount.mock.calls[0][0];
        expect(arg.userId).toBe('new-user-id');
        expect(arg.providerId).toBe('github');
        expect(arg.accountId).toBe('12345');
        expect(arg.username).toBe('octocat');
        // Unproven (GitHub did not verify it for the caller), so not recorded.
        expect(arg.email).toBeNull();
        expect(arg.accessToken).toBe('gh_token');
        expect(arg.tokenType).toBe('Bearer');
        expect(arg.metadata).toEqual({
            providerUserId: '12345',
            login: 'octocat',
            onboardingChannel: 'agent-zero-friction',
        });
        expect(arg.refreshToken).toBeNull();
        expect(arg.scope).toBeNull();
    });

    it('passes email=null to upsertProviderAccount when input.email omitted', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, email: undefined });

        const arg = mocks.authAccounts.upsertProviderAccount.mock.calls[0][0];
        expect(arg.email).toBeNull();
    });

    it('upserts the github link row with the expected fields', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub(baseInput);

        expect(mocks.githubLinks.upsertLink).toHaveBeenCalledTimes(1);
        const arg = mocks.githubLinks.upsertLink.mock.calls[0][0];
        expect(arg.userId).toBe('new-user-id');
        expect(arg.githubUserId).toBe('12345');
        expect(arg.githubLogin).toBe('octocat');
        expect(arg.accessToken).toBe('gh_token');
        expect(arg.refreshToken).toBeNull();
        expect(arg.githubNodeId).toBeNull();
        expect(arg.scope).toBeNull();
    });

    it('swallows errors from upsertProviderAccount (logs warn, returns accountId)', async () => {
        const { adapter, mocks } = create({});
        mocks.authAccounts.upsertProviderAccount.mockRejectedValue(new Error('db unavailable'));
        const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('new-user-id');
        expect(mocks.githubLinks.upsertLink).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0][0])).toContain('account_link_failed');
    });

    it('swallows errors from githubLinks.upsertLink (logs warn, returns accountId)', async () => {
        const { adapter, mocks } = create({});
        mocks.githubLinks.upsertLink.mockRejectedValue('plain string error');
        const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('new-user-id');
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0][0])).toContain('gh_link_failed');
        // describeError fallback for non-Error values: String(err)
        expect(String(warnSpy.mock.calls[0][0])).toContain('plain string error');
    });

    it('logs account_created when a new user is provisioned', async () => {
        const { adapter } = create({});
        const logSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'log');

        await adapter.upsertFromGithub(baseInput);

        expect(logSpy).toHaveBeenCalled();
        const msg = String(logSpy.mock.calls[0][0]);
        expect(msg).toContain('account_created');
        expect(msg).toContain('userId=new-user-id');
        expect(msg).toContain('login=octocat');
    });

    it('logs account_linked when an existing user is reused', async () => {
        const { adapter } = create({
            link: { userId: 'preexisting' },
            userById: { id: 'preexisting' },
        });
        const logSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'log');

        await adapter.upsertFromGithub(baseInput);

        const msgs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(msgs).toContain('account_linked');
        expect(msgs).toContain('userId=preexisting');
    });
});
