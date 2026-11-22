jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class {},
    OrganizationRepository: class {},
}));

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { ClaimAccountService, USERNAME_TAKEN_CODE } from './claim-account.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';

describe('ClaimAccountService (EW-617 G3)', () => {
    const buildService = () => {
        const findByIdResults: any = {};
        const findByEmailResults: any = {};
        const updates: any[] = [];
        // Handles other accounts / Organizations already use (lowercase keys).
        const takenUsernames: Record<string, unknown> = {};
        const takenSlugs: Record<string, unknown> = {};
        const takenOrgSlugs: Record<string, unknown> = {};
        // Lets a test make one write lose a race on a unique index, as the database would.
        let failUpdate: (data: any) => unknown = () => undefined;

        const userRepository = {
            findById: jest.fn(async (id: string) => findByIdResults[id] ?? null),
            findByEmail: jest.fn(async (email: string) => findByEmailResults[email] ?? null),
            findByUsernameCaseInsensitive: jest.fn(
                async (name: string) => takenUsernames[name.toLowerCase()] ?? null,
            ),
            findBySlug: jest.fn(async (slug: string) => takenSlugs[slug] ?? null),
            update: jest.fn(async (id: string, data: any) => {
                const failure = failUpdate(data);
                if (failure) throw failure;
                updates.push({ id, ...data });
                // Persisted like the real repository: a later write returns the row with
                // every earlier one applied.
                const row = { ...(findByIdResults[id] ?? { id }), ...data };
                findByIdResults[id] = row;
                return row;
            }),
        } as any;

        const authSyncService = {
            getCredentialPasswordHash: jest.fn().mockResolvedValue('hashed-pw'),
        } as any;

        const authService = {
            sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
        } as any;

        const authProvider = {
            setPassword: jest.fn().mockResolvedValue(undefined),
        } as any;

        // The REAL allocator over the fakes: the normalization and the collision rules under
        // test are its own, not a copy.
        const usernames = new UsernameAllocatorService(userRepository, {
            findBySlug: jest.fn(async (slug: string) => takenOrgSlugs[slug] ?? null),
        } as any);

        const service = new ClaimAccountService(
            userRepository,
            authSyncService,
            authService,
            authProvider,
            usernames,
        );

        return {
            service,
            userRepository,
            authSyncService,
            authService,
            authProvider,
            findByIdResults,
            findByEmailResults,
            updates,
            takenUsernames,
            takenSlugs,
            takenOrgSlugs,
            failUpdatesWhere: (fn: (data: any) => unknown) => {
                failUpdate = fn;
            },
        };
    };

    const anonUser = (overrides: any = {}) => ({
        id: 'u-1',
        username: 'anon-deadbeef',
        email: null,
        password: null,
        isAnonymous: true,
        anonymousExpiresAt: new Date('2026-05-21T00:00:00.000Z'),
        emailVerified: false,
        ...overrides,
    });

    /** Every field the claim wrote, across its writes. */
    const written = (ctx: { updates: any[] }) => Object.assign({}, ...ctx.updates);

    const uniqueViolation = () =>
        new QueryFailedError(
            'UPDATE "users" SET ...',
            [],
            Object.assign(new Error('duplicate key value violates unique constraint'), {
                code: '23505',
            }),
        );

    it('flips the anon user to a regular account and fires verification email', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        const result = await ctx.service.claim({
            userId: 'u-1',
            email: 'Jane@Example.com',
            password: 'MySecure123!',
        });

        // Password set via auth provider
        expect(ctx.authProvider.setPassword).toHaveBeenCalledWith('u-1', 'MySecure123!');

        // Two writes: the handle on its own first, then the flip in a single update.
        expect(ctx.updates).toHaveLength(2);
        // Never the anon-<hex> handle: derived from the email. The slug is never touched,
        // as on every other rename.
        expect(ctx.updates[0]).toEqual({ id: 'u-1', username: 'jane' });
        const updatePayload = ctx.updates[1];
        expect(updatePayload.email).toBe('jane@example.com'); // normalized
        expect(updatePayload.isAnonymous).toBe(false);
        expect(updatePayload.anonymousExpiresAt).toBeNull();
        expect(updatePayload.registrationProvider).toBe('local');
        expect(updatePayload.emailVerified).toBe(false);
        expect(written(ctx)).not.toHaveProperty('slug');

        // Verification email pipeline kicked off
        expect(ctx.authService.sendVerificationEmail).toHaveBeenCalledWith('u-1', undefined);

        // Public response shape
        expect(result).toEqual({
            id: 'u-1',
            email: 'jane@example.com',
            username: 'jane',
            emailVerified: false,
        });
    });

    it('respects a custom username when long enough', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        await ctx.service.claim({
            userId: 'u-1',
            email: 'jane@example.com',
            password: 'MySecure123!',
            username: 'jane-doe',
        });

        expect(written(ctx).username).toBe('jane-doe');
        expect(written(ctx)).not.toHaveProperty('slug');
    });

    describe('username (the sidebar showed anon-<hex> after saving)', () => {
        const claim = (ctx: ReturnType<typeof buildService>, extra: Record<string, string> = {}) =>
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
                ...extra,
            });

        it('normalizes a typed username the way every handle is', async () => {
            const ctx = buildService();
            ctx.findByIdResults['u-1'] = anonUser();

            await claim(ctx, { username: '  Jane Doe ' });

            expect(written(ctx).username).toBe('jane-doe');
        });

        it.each([
            ['another account', 'takenUsernames'],
            ["another account's slug", 'takenSlugs'],
            ['an Organization', 'takenOrgSlugs'],
        ] as const)(
            'refuses a typed username %s uses with a 409 + suggestion, before any write',
            async (_label, map) => {
                const ctx = buildService();
                ctx.findByIdResults['u-1'] = anonUser();
                ctx[map]['jane-doe'] = { id: 'someone-else' };

                const error = await claim(ctx, { username: 'Jane-Doe' }).catch((e) => e);

                expect(error).toBeInstanceOf(ConflictException);
                expect(error.getResponse()).toMatchObject({
                    code: USERNAME_TAKEN_CODE,
                    suggestion: 'jane-doe-2',
                });
                expect(ctx.authProvider.setPassword).not.toHaveBeenCalled();
                expect(ctx.updates).toHaveLength(0);
            },
        );

        it.each([['!!!'], ['--'], ['ab!']])(
            'refuses a typed %p that normalizes to nothing usable (never a silent u-<hex>)',
            async (typed) => {
                const ctx = buildService();
                ctx.findByIdResults['u-1'] = anonUser();

                await expect(claim(ctx, { username: typed })).rejects.toBeInstanceOf(
                    BadRequestException,
                );
                expect(ctx.updates).toHaveLength(0);
            },
        );

        it('keeps a typed username equal to its own current handle', async () => {
            const ctx = buildService();
            ctx.findByIdResults['u-1'] = anonUser();
            ctx.takenUsernames['anon-deadbeef'] = anonUser();

            await claim(ctx, { username: 'anon-deadbeef' });

            // Nothing to rename: only the flip is written, the handle stays.
            expect(ctx.updates).toHaveLength(1);
            expect(written(ctx)).not.toHaveProperty('username');
        });

        it('derives a free one from the email when the obvious one is taken', async () => {
            const ctx = buildService();
            ctx.findByIdResults['u-1'] = anonUser();
            ctx.takenUsernames['jane'] = { id: 'someone-else' };

            await claim(ctx);

            expect(written(ctx).username).toBe('jane-2');
        });

        it('pads a local part shorter than the 3-character floor', async () => {
            const ctx = buildService();
            ctx.findByIdResults['u-1'] = anonUser();

            await ctx.service.claim({
                userId: 'u-1',
                email: 'jo@example.com',
                password: 'MySecure123!',
            });

            expect(written(ctx).username).toBe('jo-user');
        });

        describe('a claim racing this one (the check cannot see it; the unique index can)', () => {
            it('answers a typed handle lost at the database with the 409, before any credential', async () => {
                const ctx = buildService();
                ctx.findByIdResults['u-1'] = anonUser();
                ctx.failUpdatesWhere((data) => {
                    if (data.username !== 'jane-doe') return undefined;
                    ctx.takenUsernames['jane-doe'] = { id: 'the-winner' };
                    return uniqueViolation();
                });

                const error = await claim(ctx, { username: 'jane-doe' }).catch((e) => e);

                expect(error).toBeInstanceOf(ConflictException);
                expect(error.getResponse()).toMatchObject({
                    code: USERNAME_TAKEN_CODE,
                    suggestion: 'jane-doe-2',
                });
                expect(ctx.authProvider.setPassword).not.toHaveBeenCalled();
                expect(ctx.updates).toHaveLength(0);
            });

            it('allocates a derived handle once more when the first one is lost', async () => {
                const ctx = buildService();
                ctx.findByIdResults['u-1'] = anonUser();
                ctx.failUpdatesWhere((data) => {
                    if (data.username !== 'jane') return undefined;
                    ctx.takenUsernames['jane'] = { id: 'the-winner' };
                    return uniqueViolation();
                });

                const result = await claim(ctx);

                expect(result.username).toBe('jane-2');
                expect(ctx.updates[0]).toEqual({ id: 'u-1', username: 'jane-2' });
                expect(ctx.authProvider.setPassword).toHaveBeenCalledTimes(1);
            });

            it('answers the 409 when the second derived handle is lost too', async () => {
                const ctx = buildService();
                ctx.findByIdResults['u-1'] = anonUser();
                ctx.failUpdatesWhere((data) => {
                    if (!('username' in data)) return undefined;
                    ctx.takenUsernames[data.username] = { id: 'a-winner' };
                    return uniqueViolation();
                });

                await expect(claim(ctx)).rejects.toBeInstanceOf(ConflictException);
                expect(ctx.authProvider.setPassword).not.toHaveBeenCalled();
            });

            it('answers an email lost at the database with the email 409, not a 500', async () => {
                const ctx = buildService();
                ctx.findByIdResults['u-1'] = anonUser();
                ctx.failUpdatesWhere((data) => ('email' in data ? uniqueViolation() : undefined));

                const error = await claim(ctx).catch((e) => e);

                expect(error).toBeInstanceOf(ConflictException);
                expect(error.message).toMatch(/Email is already in use/);
            });

            it('lets any other database failure through', async () => {
                const ctx = buildService();
                ctx.findByIdResults['u-1'] = anonUser();
                ctx.failUpdatesWhere(() => new Error('connection reset'));

                await expect(claim(ctx)).rejects.toThrow('connection reset');
            });
        });
    });

    it('rejects too-short usernames', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
                username: 'jd',
            }),
        ).rejects.toThrow(BadRequestException);
    });

    it('returns 404 when the user does not exist', async () => {
        const ctx = buildService();

        await expect(
            ctx.service.claim({
                userId: 'ghost',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(NotFoundException);
    });

    it('returns 403 when the user is already a regular account', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser({ isAnonymous: false });

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(ForbiddenException);
    });

    it('returns 409 when the email belongs to a different user', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();
        ctx.findByEmailResults['jane@example.com'] = {
            id: 'u-someone-else',
            email: 'jane@example.com',
        };

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(ConflictException);

        // Confirm we never wrote anything
        expect(ctx.authProvider.setPassword).not.toHaveBeenCalled();
        expect(ctx.updates).toHaveLength(0);
    });

    it('allows claim when findByEmail returns the same user (e.g. retry)', async () => {
        const ctx = buildService();
        const sameUser = anonUser();
        ctx.findByIdResults['u-1'] = sameUser;
        ctx.findByEmailResults['jane@example.com'] = sameUser;

        await ctx.service.claim({
            userId: 'u-1',
            email: 'jane@example.com',
            password: 'MySecure123!',
        });

        // The handle, then the flip.
        expect(ctx.updates).toHaveLength(2);
    });

    it('does not throw if the verification email fails (logged + continued)', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();
        ctx.authService.sendVerificationEmail.mockRejectedValue(new Error('SMTP down'));

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).resolves.toMatchObject({ id: 'u-1' });
    });

    it('throws when auth provider does not seat a credential hash', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();
        ctx.authSyncService.getCredentialPasswordHash.mockResolvedValue(null);

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(BadRequestException);

        // The credential set was attempted; only the handle was written, and the account is
        // still anonymous (never flipped), so the visitor can simply retry.
        expect(ctx.authProvider.setPassword).toHaveBeenCalled();
        expect(ctx.updates).toEqual([{ id: 'u-1', username: 'jane' }]);
    });

    it('passes through the email verification callback URL', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        await ctx.service.claim({
            userId: 'u-1',
            email: 'jane@example.com',
            password: 'MySecure123!',
            emailVerificationCallbackUrl: 'https://app.ever.works/welcome',
        });

        expect(ctx.authService.sendVerificationEmail).toHaveBeenCalledWith(
            'u-1',
            'https://app.ever.works/welcome',
        );
    });
});
