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

        const userRepository = {
            findById: jest.fn(async (id: string) => findByIdResults[id] ?? null),
            findByEmail: jest.fn(async (email: string) => findByEmailResults[email] ?? null),
            findByUsernameCaseInsensitive: jest.fn(
                async (name: string) => takenUsernames[name.toLowerCase()] ?? null,
            ),
            findBySlug: jest.fn(async (slug: string) => takenSlugs[slug] ?? null),
            update: jest.fn(async (id: string, data: any) => {
                updates.push({ id, ...data });
                const base = findByIdResults[id] ?? { id };
                return { ...base, ...data };
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

        // User row updated atomically
        expect(ctx.updates).toHaveLength(1);
        const updatePayload = ctx.updates[0];
        expect(updatePayload.email).toBe('jane@example.com'); // normalized
        expect(updatePayload.isAnonymous).toBe(false);
        expect(updatePayload.anonymousExpiresAt).toBeNull();
        expect(updatePayload.registrationProvider).toBe('local');
        expect(updatePayload.emailVerified).toBe(false);
        // Never the anon-<hex> handle: derived from the email, and the slug follows it.
        expect(updatePayload.username).toBe('jane');
        expect(updatePayload.slug).toBe('jane');

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

        expect(ctx.updates[0].username).toBe('jane-doe');
        expect(ctx.updates[0].slug).toBe('jane-doe');
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

            expect(ctx.updates[0]).toMatchObject({ username: 'jane-doe', slug: 'jane-doe' });
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

        it('keeps a typed username equal to its own current handle', async () => {
            const ctx = buildService();
            ctx.findByIdResults['u-1'] = anonUser();
            ctx.takenUsernames['anon-deadbeef'] = anonUser();

            await claim(ctx, { username: 'anon-deadbeef' });

            expect(ctx.updates[0].username).toBe('anon-deadbeef');
        });

        it('derives a free one from the email when the obvious one is taken', async () => {
            const ctx = buildService();
            ctx.findByIdResults['u-1'] = anonUser();
            ctx.takenUsernames['jane'] = { id: 'someone-else' };

            await claim(ctx);

            expect(ctx.updates[0]).toMatchObject({ username: 'jane-2', slug: 'jane-2' });
        });

        it('pads a local part shorter than the 3-character floor', async () => {
            const ctx = buildService();
            ctx.findByIdResults['u-1'] = anonUser();

            await ctx.service.claim({
                userId: 'u-1',
                email: 'jo@example.com',
                password: 'MySecure123!',
            });

            expect(ctx.updates[0].username).toBe('jo-user');
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

        expect(ctx.updates).toHaveLength(1);
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

        // The credential set was attempted but no User update should happen
        expect(ctx.authProvider.setPassword).toHaveBeenCalled();
        expect(ctx.updates).toHaveLength(0);
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
