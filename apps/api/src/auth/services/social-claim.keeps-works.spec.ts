import { DataSource } from 'typeorm';
import { AuthAccountRepository, ENTITIES, UserRepository } from '@ever-works/agent/database';
import { AuthAccount, User, Work } from '@ever-works/agent/entities';
// The file, not the `@ever-works/agent/services` barrel: see `claim-account.keeps-works.spec.ts`.
import { AnonymousUserCleanupService } from '../../../../../packages/agent/src/services/anonymous-user-cleanup.service';
import { AuthProvider } from '../../config/constants';
import type { SocialAuthUser } from '../types/social-auth.types';
import { AnonymousAuthService } from './anonymous-auth.service';
import { AuthService } from './auth.service';
import { SocialClaimService } from './social-claim.service';

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
        socialClaim = new SocialClaimService(users, accounts, authService, events as never);
        cleanup = new AnonymousUserCleanupService(users);
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

        const saved = await socialClaim.claim(userId, githubProfile());

        expect(saved.id).toBe(userId);
        const row = await users.findById(userId);
        expect(row).toMatchObject({
            isAnonymous: false,
            email: 'visitor@example.com',
            registrationProvider: 'github',
            emailVerified: true,
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
});
