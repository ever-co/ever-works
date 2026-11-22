import { DataSource } from 'typeorm';
import {
    AuthAccountRepository,
    ENTITIES,
    OrganizationRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { AuthAccount, Organization, User, Work } from '@ever-works/agent/entities';
// The file, not the `@ever-works/agent/services` barrel: see `claim-account.keeps-works.spec.ts`.
import { AnonymousUserCleanupService } from '../../../../../packages/agent/src/services/anonymous-user-cleanup.service';
import { AuthProvider } from '../../config/constants';
import type { SocialAuthUser } from '../types/social-auth.types';
import { AnonymousAuthService } from './anonymous-auth.service';
import { AuthService } from './auth.service';
import { SocialClaimService } from './social-claim.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';

/**
 * EW-617 — saving a temporary account with GitHub / Google must KEEP its Works, like the
 * password claim does (`claim-account.keeps-works.spec.ts`). Proven on a real SQL engine
 * (better-sqlite3, full entity inventory): an anonymous account is minted the way
 * `POST /api/auth/anonymous` mints it, owns Works, is saved through the real
 * `SocialClaimService` with the real repositories, and the real nightly cleanup then runs long
 * after the original expiry. The saved account and its Works survive it, and the next GitHub
 * sign-in (the real `AuthService.validateSocialUser`) opens that same account.
 *
 * Refusal is proven the same way: an identity another user already holds leaves the
 * anonymous account untouched, so the cleanup still takes it, and the other user keeps its
 * link. Only the event emitter is stubbed (it sends mail).
 */
describe('Saving an anonymous account with a social identity keeps its Works (real database)', () => {
    let dataSource: DataSource;
    let users: UserRepository;
    let accounts: AuthAccountRepository;
    let anonymousAuth: AnonymousAuthService;
    let authService: AuthService;
    let socialClaim: SocialClaimService;
    let cleanup: AnonymousUserCleanupService;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        users = new UserRepository(dataSource.getRepository(User));
        accounts = new AuthAccountRepository(dataSource.getRepository(AuthAccount));
        const events = { emit: jest.fn() };

        anonymousAuth = new AnonymousAuthService(users, dataSource, {} as never);
        authService = new AuthService(users, accounts, events as never);
        socialClaim = new SocialClaimService(
            users,
            accounts,
            authService,
            events as never,
            new UsernameAllocatorService(
                users,
                new OrganizationRepository(dataSource.getRepository(Organization)),
            ),
            dataSource,
        );
        // The service is deep-imported from source (see the import), while `users` is typed by
        // `@ever-works/agent/database`, which resolves to the BUILT declarations once
        // packages/agent is built. Same class at runtime; two declarations to the type checker.
        cleanup = new AnonymousUserCleanupService(users as never);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const githubProfile = (overrides: Partial<SocialAuthUser> = {}): SocialAuthUser => ({
        provider: AuthProvider.GITHUB as SocialAuthUser['provider'],
        providerUserId: '4242',
        email: 'visitor@example.com',
        displayName: 'Visitor',
        username: 'visitor',
        avatar: null,
        emailVerified: true,
        accessToken: 'gho_first',
        refreshToken: null,
        tokenType: 'bearer',
        scope: 'read:user,user:email',
        expiresAt: null,
        ...overrides,
    });

    const mintAnonymousWithWorks = async (slugs: string[]) => {
        const { user } = await anonymousAuth.createAnonymousUser();
        const works = dataSource.getRepository(Work);
        for (const slug of slugs) {
            await works.save(
                works.create({
                    userId: user.id,
                    name: slug,
                    slug,
                    description: slug,
                } as Partial<Work>),
            );
        }
        return user.id;
    };

    const worksOf = async (userId: string) =>
        (
            await dataSource.getRepository(Work).find({ where: { userId }, order: { slug: 'ASC' } })
        ).map((work) => work.slug);

    /** Well past any anonymous TTL (3 days by default), as the nightly schedule would see it. */
    const longAfterExpiry = () => new Date(Date.now() + 30 * 24 * 3_600_000);

    it('keeps the same user and its Works through the cleanup, and GitHub signs in to it later', async () => {
        const userId = await mintAnonymousWithWorks(['my-directory', 'my-landing-page']);

        const slugBefore = (await users.findById(userId))?.slug;

        // The provider's casing is stored lowercased, as the password claim stores it.
        const saved = await socialClaim.claim(
            userId,
            githubProfile({ email: 'Visitor@Example.com' }),
        );

        expect(saved.id).toBe(userId);
        const row = await users.findById(userId);
        expect(row).toMatchObject({
            isAnonymous: false,
            email: 'visitor@example.com',
            registrationProvider: 'github',
            emailVerified: true,
            // A real handle from the provider in place of `anon-<hex>`; the slug is stable.
            username: 'visitor',
            slug: slugBefore,
        });
        expect(row?.anonymousExpiresAt ?? null).toBeNull();
        expect(await accounts.findProviderAccountByAccountId('github', '4242')).toMatchObject({
            userId,
        });

        const summary = await cleanup.purgeExpired(longAfterExpiry());

        expect(summary.scanned).toBe(0);
        expect(await worksOf(userId)).toEqual(['my-directory', 'my-landing-page']);

        // The next "Sign in with GitHub" resolves the identity to the saved account.
        const signedIn = await authService.validateSocialUser(
            githubProfile({ accessToken: 'gho_second' }),
        );
        expect(signedIn.id).toBe(userId);
        expect(await worksOf(signedIn.id)).toEqual(['my-directory', 'my-landing-page']);
    });

    it('refuses an identity another user holds, and changes neither account', async () => {
        const owner = await users.create({
            username: 'owner',
            email: 'owner@example.com',
            registrationProvider: 'github',
            emailVerified: true,
            isActive: true,
        });
        await accounts.upsertProviderAccount({
            userId: owner.id,
            providerId: 'github',
            accountId: '4242',
            email: 'owner@example.com',
            accessToken: 'gho_owner',
        });
        const anonId = await mintAnonymousWithWorks(['temporary-work']);

        await expect(
            socialClaim.claim(anonId, githubProfile({ email: 'owner@example.com' })),
        ).rejects.toMatchObject({ status: 409 });

        expect(await users.findById(anonId)).toMatchObject({ isAnonymous: true, email: null });
        expect(await accounts.findProviderAccountByAccountId('github', '4242')).toMatchObject({
            userId: owner.id,
            accessToken: 'gho_owner',
        });
        expect(await accounts.findProviderAccount(anonId, 'github')).toBeNull();

        // Not saved, so the nightly cleanup takes it as it would have; the owner is untouched.
        const summary = await cleanup.purgeExpired(longAfterExpiry());
        expect(summary).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
        expect(await users.findById(anonId)).toBeNull();
        expect(await worksOf(anonId)).toEqual([]);
        expect(await users.findById(owner.id)).not.toBeNull();
    });

    it('refuses a new identity whose email another user has, whatever its case', async () => {
        await users.create({
            username: 'someone',
            email: 'visitor@example.com',
            registrationProvider: 'local',
            emailVerified: true,
            isActive: true,
        });
        const anonId = await mintAnonymousWithWorks(['temporary-work']);

        await expect(
            socialClaim.claim(anonId, githubProfile({ email: 'Visitor@Example.COM' })),
        ).rejects.toMatchObject({ status: 409 });

        expect(await users.findById(anonId)).toMatchObject({ isAnonymous: true });
        expect(await accounts.findProviderAccountByAccountId('github', '4242')).toBeNull();
    });

    it('gives a free variant of the provider handle when another account has it', async () => {
        await users.create({
            username: 'visitor',
            email: 'someone@example.com',
            registrationProvider: 'local',
            emailVerified: true,
            isActive: true,
        });
        const userId = await mintAnonymousWithWorks(['kept']);

        const saved = await socialClaim.claim(userId, githubProfile());

        expect(saved.username).not.toBe('visitor');
        expect(saved.username.startsWith('visitor')).toBe(true);
        expect((await users.findById(userId))?.username).toBe(saved.username);
    });

    it('rolls the link back with the flip when a racing save takes the email (one transaction)', async () => {
        const anonId = await mintAnonymousWithWorks(['raced-work']);
        // The racer committed between this save's check and its flip: the check saw nothing,
        // the unique index on users.email sees the row.
        await users.create({
            username: 'racer',
            email: 'visitor@example.com',
            registrationProvider: 'local',
            emailVerified: true,
            isActive: true,
        });
        jest.spyOn(users, 'existsByEmailCaseInsensitive').mockResolvedValueOnce(false);

        await expect(socialClaim.claim(anonId, githubProfile())).rejects.toMatchObject({
            status: 409,
            response: expect.objectContaining({ code: 'EMAIL_ALREADY_IN_USE' }),
        });

        expect(await users.findById(anonId)).toMatchObject({ isAnonymous: true, email: null });
        // The link written in the same transaction is gone with it.
        expect(await accounts.findProviderAccount(anonId, 'github')).toBeNull();
        expect(await accounts.findProviderAccountByAccountId('github', '4242')).toBeNull();
    });

    it('refuses to re-point a GitHub link the account already has for another GitHub user', async () => {
        const anonId = await mintAnonymousWithWorks(['connected-work']);
        // As the GitHub App onboarding leaves an anonymous account that connected GitHub.
        await accounts.upsertProviderAccount({
            userId: anonId,
            providerId: 'github',
            accountId: '999',
            email: 'other@example.com',
            accessToken: 'ghu_app',
        });

        await expect(socialClaim.claim(anonId, githubProfile())).rejects.toMatchObject({
            status: 409,
            response: expect.objectContaining({ code: 'OTHER_PROVIDER_ACCOUNT_CONNECTED' }),
        });

        expect(await accounts.findProviderAccount(anonId, 'github')).toMatchObject({
            accountId: '999',
            accessToken: 'ghu_app',
        });
        expect(await users.findById(anonId)).toMatchObject({ isAnonymous: true });
    });
});
