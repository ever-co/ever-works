jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class {},
    AuthAccountRepository: class {},
    OrganizationRepository: class {},
}));

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { UserConfirmedEvent } from '../../events';
import { AuthProvider } from '../../config/constants';
import type { SocialAuthUser } from '../types/social-auth.types';
import {
    SOCIAL_CLAIM_EMAIL_TAKEN_CODE,
    SOCIAL_CLAIM_IDENTITY_TAKEN_CODE,
    SOCIAL_CLAIM_OTHER_IDENTITY_CODE,
    SocialClaimService,
} from './social-claim.service';

describe('SocialClaimService (EW-617: save an anonymous account with GitHub / Google)', () => {
    const anonUser = (overrides: Record<string, unknown> = {}) => ({
        id: 'anon-1',
        username: 'anon-deadbeef',
        email: null,
        avatar: null,
        isAnonymous: true,
        anonymousExpiresAt: new Date('2026-11-25T00:00:00.000Z'),
        registrationProvider: 'anonymous',
        emailVerified: false,
        ...overrides,
    });

    const githubUser = (overrides: Partial<SocialAuthUser> = {}): SocialAuthUser => ({
        provider: AuthProvider.GITHUB as SocialAuthUser['provider'],
        providerUserId: '4242',
        email: 'visitor@example.com',
        displayName: 'Visitor',
        username: 'visitor',
        avatar: 'https://avatars.example/visitor.png',
        emailVerified: true,
        accessToken: 'gho_access',
        refreshToken: null,
        tokenType: 'bearer',
        scope: 'read:user,user:email',
        expiresAt: null,
        metadata: { login: 'visitor' },
        ...overrides,
    });

    const build = (user: Record<string, unknown> | null = anonUser()) => {
        // The row as the writes leave it, so a later write's result carries an earlier one.
        let row: Record<string, unknown> = { ...(user ?? {}) };
        // Whether a write ran inside `dataSource.transaction`, as the real one would scope it.
        let inTransaction = false;
        const writesInTransaction: string[] = [];
        const userRepository = {
            findById: jest.fn().mockResolvedValue(user),
            existsByEmailCaseInsensitive: jest.fn().mockResolvedValue(false),
            update: jest.fn(async (id: string, data: Record<string, unknown>): Promise<any> => {
                if (inTransaction)
                    writesInTransaction.push('isAnonymous' in data ? 'flip' : 'username');
                row = { ...row, id, ...data };
                return row;
            }),
            withManager: jest.fn(() => userRepository),
        };
        const authAccountRepository = {
            findProviderAccountByAccountId: jest.fn().mockResolvedValue(null),
            findProviderAccount: jest.fn().mockResolvedValue(null),
            upsertProviderAccount: jest.fn(async () => {
                if (inTransaction) writesInTransaction.push('link');
                return { id: 'acc-1' };
            }),
            withManager: jest.fn(() => authAccountRepository),
        };
        const dataSource = {
            transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) => {
                inTransaction = true;
                try {
                    return await work('tx-manager');
                } finally {
                    inTransaction = false;
                }
            }),
        };
        const authService = { sendVerificationEmail: jest.fn().mockResolvedValue(undefined) };
        const eventEmitter = { emit: jest.fn() };
        // The real allocator's normalize; availability is the test's to decide.
        const usernames = {
            normalize: jest.fn((input: string) =>
                input
                    .toLowerCase()
                    .replace(/[^a-z0-9-]+/g, '-')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, ''),
            ),
            allocateUsername: jest.fn(async (base: string) => base),
        };
        const service = new SocialClaimService(
            userRepository as never,
            authAccountRepository as never,
            authService as never,
            eventEmitter as never,
            usernames as never,
            dataSource as never,
        );
        return {
            dataSource,
            writesInTransaction,
            service,
            userRepository,
            authAccountRepository,
            authService,
            eventEmitter,
            usernames,
        };
    };

    const expectNothingWritten = (ctx: ReturnType<typeof build>) => {
        expect(ctx.authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
        expect(ctx.userRepository.update).not.toHaveBeenCalled();
        expect(ctx.eventEmitter.emit).not.toHaveBeenCalled();
        expect(ctx.authService.sendVerificationEmail).not.toHaveBeenCalled();
    };

    describe('a new identity', () => {
        it('links it to the SAME user and takes that user out of anonymous mode', async () => {
            const ctx = build();

            const result = await ctx.service.claim('anon-1', githubUser());

            expect(ctx.authAccountRepository.upsertProviderAccount).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'anon-1',
                    providerId: 'github',
                    accountId: '4242',
                    email: 'visitor@example.com',
                    accessToken: 'gho_access',
                }),
            );
            // The handle on its own first, then the flip in one update.
            expect(ctx.userRepository.update).toHaveBeenCalledTimes(2);
            expect(ctx.userRepository.update).toHaveBeenNthCalledWith(1, 'anon-1', {
                username: 'visitor',
            });
            expect(ctx.userRepository.update).toHaveBeenNthCalledWith(
                2,
                'anon-1',
                expect.objectContaining({
                    email: 'visitor@example.com',
                    isAnonymous: false,
                    anonymousExpiresAt: null,
                    registrationProvider: 'github',
                    emailVerified: true,
                    avatar: 'https://avatars.example/visitor.png',
                }),
            );
            // The slug is never written: it stays as it is, as on every rename.
            for (const [, data] of ctx.userRepository.update.mock.calls) {
                expect(data).not.toHaveProperty('slug');
            }
            expect(result).toEqual({
                id: 'anon-1',
                email: 'visitor@example.com',
                username: 'visitor',
                emailVerified: true,
                provider: 'github',
            });
        });

        it('names it, then links, then flips: a lost race leaves a retryable anonymous account', async () => {
            const ctx = build();
            const order: string[] = [];
            ctx.authAccountRepository.upsertProviderAccount.mockImplementation(async () => {
                order.push('link');
                return { id: 'acc-1' };
            });
            ctx.userRepository.update.mockImplementation(async (id: string, data: object) => {
                order.push('isAnonymous' in data ? 'flip' : 'username');
                return { ...anonUser(), id, ...data };
            });

            await ctx.service.claim('anon-1', githubUser());

            expect(order).toEqual(['username', 'link', 'flip']);
        });

        it('derives the handle from the email when the provider gives none usable', async () => {
            const ctx = build();

            const result = await ctx.service.claim(
                'anon-1',
                githubUser({ username: '!!!', email: 'Jane.Doe@Example.com' }),
            );

            expect(ctx.usernames.allocateUsername).toHaveBeenCalledWith('jane-doe');
            expect(result.username).toBe('jane-doe');
        });

        it('keeps a handle a half-finished earlier save already gave it', async () => {
            const ctx = build(anonUser({ username: 'visitor' }));

            await ctx.service.claim('anon-1', githubUser());

            expect(ctx.usernames.allocateUsername).not.toHaveBeenCalled();
            expect(ctx.userRepository.update).toHaveBeenCalledTimes(1);
        });

        it('sends the welcome mail a verified social sign-up gets, and no verification mail', async () => {
            const ctx = build();

            await ctx.service.claim('anon-1', githubUser());

            expect(ctx.eventEmitter.emit).toHaveBeenCalledWith(
                UserConfirmedEvent.EVENT_NAME,
                expect.any(UserConfirmedEvent),
            );
            expect(ctx.authService.sendVerificationEmail).not.toHaveBeenCalled();
        });

        it('leaves an address the provider does not vouch for unverified and mails a check', async () => {
            const ctx = build();

            const result = await ctx.service.claim(
                'anon-1',
                githubUser({ provider: AuthProvider.GOOGLE as never, emailVerified: false }),
                { emailVerificationCallbackUrl: 'https://ever.works/api/auth/verify-email' },
            );

            expect(ctx.userRepository.update).toHaveBeenCalledWith(
                'anon-1',
                expect.objectContaining({ emailVerified: false, registrationProvider: 'google' }),
            );
            expect(ctx.authService.sendVerificationEmail).toHaveBeenCalledWith(
                'anon-1',
                'https://ever.works/api/auth/verify-email',
            );
            expect(ctx.eventEmitter.emit).not.toHaveBeenCalled();
            expect(result.emailVerified).toBe(false);
        });

        it('keeps the save when the verification mail fails', async () => {
            const ctx = build();
            ctx.authService.sendVerificationEmail.mockRejectedValue(new Error('SMTP down'));

            await expect(
                ctx.service.claim('anon-1', githubUser({ emailVerified: false })),
            ).resolves.toMatchObject({ id: 'anon-1', emailVerified: false });
        });

        it('accepts an identity already linked to this same user (a retried save)', async () => {
            const ctx = build();
            ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue({
                userId: 'anon-1',
            });
            ctx.authAccountRepository.findProviderAccount.mockResolvedValue({
                userId: 'anon-1',
                accountId: '4242',
            });

            await expect(ctx.service.claim('anon-1', githubUser())).resolves.toMatchObject({
                id: 'anon-1',
            });
            expect(ctx.userRepository.update).toHaveBeenCalled();
        });
    });

    describe('an identity or email that belongs to another user: refuse, never merge', () => {
        it('refuses an identity linked to another user, before anything is written', async () => {
            const ctx = build();
            ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue({
                userId: 'someone-else',
            });

            const error = await ctx.service.claim('anon-1', githubUser()).catch((e) => e);

            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: SOCIAL_CLAIM_IDENTITY_TAKEN_CODE,
            });
            expect(ctx.authAccountRepository.findProviderAccountByAccountId).toHaveBeenCalledWith(
                'github',
                '4242',
            );
            expectNothingWritten(ctx);
        });

        it('refuses an email another user has (compared case-insensitively)', async () => {
            const ctx = build();
            ctx.userRepository.existsByEmailCaseInsensitive.mockResolvedValue(true);

            const error = await ctx.service.claim('anon-1', githubUser()).catch((e) => e);

            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: SOCIAL_CLAIM_EMAIL_TAKEN_CODE,
            });
            expect(ctx.userRepository.existsByEmailCaseInsensitive).toHaveBeenCalledWith(
                'visitor@example.com',
            );
            expectNothingWritten(ctx);
        });

        it('surfaces the link conflict of a concurrent save and leaves the account anonymous', async () => {
            const ctx = build();
            ctx.authAccountRepository.upsertProviderAccount.mockRejectedValue(
                new ConflictException({ code: 'PROVIDER_ACCOUNT_ALREADY_LINKED' }),
            );

            await expect(ctx.service.claim('anon-1', githubUser())).rejects.toBeInstanceOf(
                ConflictException,
            );
            // Only the handle was written; the account was never taken out of anonymous mode.
            expect(
                ctx.userRepository.update.mock.calls.some(([, data]) => 'isAnonymous' in data),
            ).toBe(false);
        });
    });

    describe('accounts that cannot be saved this way', () => {
        it('refuses a registered account', async () => {
            const ctx = build(anonUser({ isAnonymous: false, email: 'a@b.c' }));

            await expect(ctx.service.claim('anon-1', githubUser())).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(ctx.authAccountRepository.findProviderAccountByAccountId).not.toHaveBeenCalled();
            expectNothingWritten(ctx);
        });

        it('refuses a demo sandbox, which is anonymous too', async () => {
            const ctx = build(anonUser({ registrationProvider: 'demo' }));

            await expect(ctx.service.claim('anon-1', githubUser())).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expectNothingWritten(ctx);
        });

        it('answers 404 for an unknown user', async () => {
            const ctx = build(null);

            await expect(ctx.service.claim('ghost', githubUser())).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('refuses a profile without an account id or an email', async () => {
            const noId = build();
            await expect(
                noId.service.claim('anon-1', githubUser({ providerUserId: '  ' })),
            ).rejects.toBeInstanceOf(BadRequestException);
            expectNothingWritten(noId);

            const noEmail = build();
            await expect(
                noEmail.service.claim('anon-1', githubUser({ email: '' })),
            ).rejects.toBeInstanceOf(BadRequestException);
            expectNothingWritten(noEmail);
        });
    });

    /** A unique-index violation as the drivers raise it (Postgres 23505). */
    const uniqueViolation = () =>
        new QueryFailedError(
            'UPDATE "users" SET ...',
            [],
            Object.assign(new Error('duplicate key value violates unique constraint'), {
                code: '23505',
            }),
        );

    /** The username write succeeds; the flip (the write that has `isAnonymous`) does `flip`. */
    const failTheFlip = (ctx: ReturnType<typeof build>, flip: () => Promise<unknown>) =>
        ctx.userRepository.update.mockImplementation(async (id: string, data: object) =>
            'isAnonymous' in data ? flip() : { ...anonUser(), id, ...data },
        );

    describe('races that reach a unique index answer 409, never 500', () => {
        it('a save racing for the same email loses as the email 409, inside the transaction', async () => {
            const ctx = build();
            failTheFlip(ctx, async () => {
                throw uniqueViolation();
            });

            const error = await ctx.service.claim('anon-1', githubUser()).catch((e) => e);

            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: SOCIAL_CLAIM_EMAIL_TAKEN_CODE,
            });
            // The link was written in the same transaction, so the 409 rolls it back with the
            // flip (proven on a real database in social-claim.keeps-works.spec.ts).
            expect(ctx.writesInTransaction).toEqual(['link']);
        });

        it('a save racing for the same identity loses on the link index as the identity 409', async () => {
            const ctx = build();
            ctx.authAccountRepository.upsertProviderAccount.mockRejectedValue(uniqueViolation());

            const error = await ctx.service.claim('anon-1', githubUser()).catch((e) => e);

            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: SOCIAL_CLAIM_IDENTITY_TAKEN_CODE,
            });
            // Still anonymous: only the handle was written.
            expect(
                ctx.userRepository.update.mock.calls.some(([, data]) => 'isAnonymous' in data),
            ).toBe(false);
        });

        it('a lost race for the handle allocates once more, a second loss is username_taken', async () => {
            const once = build();
            once.userRepository.update
                .mockRejectedValueOnce(uniqueViolation())
                .mockImplementation(async (id: string, data: object) => ({
                    ...anonUser(),
                    id,
                    ...data,
                }));
            await expect(once.service.claim('anon-1', githubUser())).resolves.toMatchObject({
                id: 'anon-1',
            });
            expect(once.usernames.allocateUsername).toHaveBeenCalledTimes(2);

            const twice = build();
            twice.userRepository.update.mockRejectedValue(uniqueViolation());
            const error = await twice.service.claim('anon-1', githubUser()).catch((e) => e);
            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: 'username_taken',
            });
            expect(twice.authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
        });
    });

    describe('the link and the flip are one transaction', () => {
        it('writes the link and the flip inside it, the handle before it', async () => {
            const ctx = build();

            await ctx.service.claim('anon-1', githubUser());

            expect(ctx.dataSource.transaction).toHaveBeenCalledTimes(1);
            expect(ctx.writesInTransaction).toEqual(['link', 'flip']);
            expect(ctx.authAccountRepository.withManager).toHaveBeenCalledWith('tx-manager');
            expect(ctx.userRepository.withManager).toHaveBeenCalledWith('tx-manager');
        });

        it('lets a failed flip fail the whole transaction', async () => {
            const ctx = build();
            failTheFlip(ctx, async () => {
                throw new Error('db down');
            });

            await expect(ctx.service.claim('anon-1', githubUser())).rejects.toThrow('db down');
            expect(ctx.eventEmitter.emit).not.toHaveBeenCalled();
        });

        it('answers 400 when the flip updates nothing', async () => {
            const ctx = build();
            failTheFlip(ctx, async () => null);

            await expect(ctx.service.claim('anon-1', githubUser())).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    describe('another account of the provider already connected (e.g. the GitHub App)', () => {
        it('refuses with 409 and writes nothing, instead of re-pointing that link', async () => {
            const ctx = build();
            ctx.authAccountRepository.findProviderAccount.mockResolvedValue({
                userId: 'anon-1',
                accountId: '999',
            });

            const error = await ctx.service.claim('anon-1', githubUser()).catch((e) => e);

            expect(error).toBeInstanceOf(ConflictException);
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: SOCIAL_CLAIM_OTHER_IDENTITY_CODE,
            });
            expectNothingWritten(ctx);
        });
    });

    it('stores the provider email trimmed and lowercased, as the password claim does', async () => {
        const ctx = build();

        const result = await ctx.service.claim(
            'anon-1',
            githubUser({ email: '  Visitor@Example.COM ' }),
        );

        expect(ctx.userRepository.existsByEmailCaseInsensitive).toHaveBeenCalledWith(
            'visitor@example.com',
        );
        expect(ctx.userRepository.update).toHaveBeenLastCalledWith(
            'anon-1',
            expect.objectContaining({ email: 'visitor@example.com' }),
        );
        expect(result.email).toBe('visitor@example.com');
    });
});
