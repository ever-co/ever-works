import { DataSource } from 'typeorm';
import {
    AuthAccountRepository,
    ENTITIES,
    OrganizationRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { AuthAccount, Organization, User } from '@ever-works/agent/entities';
import { AuthProvider } from '../../config/constants';
import type { SocialAuthUser } from '../types/social-auth.types';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';
import { AnonymousAuthService } from './anonymous-auth.service';
import { AuthService } from './auth.service';
import { EXISTING_ACCOUNT_EMAIL_UNVERIFIED_CODE } from './social-link-errors';
import { SocialClaimService } from './social-claim.service';

/**
 * Account pre-hijacking, proven on a real SQL engine (better-sqlite3, full entity inventory)
 * with the real repositories: someone opens an account with the victim's address and never
 * verifies it; the victim's later VERIFIED Google / GitHub sign-in must be refused, not linked
 * into that account, and must write nothing. Each way such an unverified account comes to
 * exist is replayed (a password registration, a social sign-up whose provider reports the
 * address unverified, an anonymous account saved with it). A verified account still links, and
 * an identity already linked still signs in. Only the event emitter is stubbed (it sends mail).
 */
describe('Social sign-in never links into an account whose own email is unverified (real database)', () => {
    let dataSource: DataSource;
    let users: UserRepository;
    let accounts: AuthAccountRepository;
    let authService: AuthService;

    const VICTIM_EMAIL = 'victim@example.com';

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
        authService = new AuthService(users, accounts, { emit: jest.fn() } as never);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const profile = (overrides: Partial<SocialAuthUser> = {}): SocialAuthUser => ({
        provider: AuthProvider.GITHUB as SocialAuthUser['provider'],
        providerUserId: '4242',
        email: VICTIM_EMAIL,
        displayName: 'Victim',
        username: 'victim',
        avatar: null,
        emailVerified: true,
        accessToken: 'gho_victim',
        refreshToken: null,
        tokenType: 'bearer',
        scope: 'read:user,user:email',
        expiresAt: null,
        ...overrides,
    });

    const usersWithVictimEmail = () =>
        dataSource.getRepository(User).count({ where: { email: VICTIM_EMAIL } });

    /** The victim's verified sign-in is refused with the mapped 409 and leaves every row as it was. */
    const expectRefusedWithoutWrites = async (preHijacked: User, victim: SocialAuthUser) => {
        const before = await users.findById(preHijacked.id);

        await expect(authService.validateSocialUser(victim)).rejects.toMatchObject({
            status: 409,
            response: expect.objectContaining({ code: EXISTING_ACCOUNT_EMAIL_UNVERIFIED_CODE }),
        });

        const after = await users.findById(preHijacked.id);
        expect(after).toMatchObject({
            emailVerified: false,
            registrationProvider: before?.registrationProvider,
            username: before?.username,
        });
        expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
        expect(
            await accounts.findProviderAccountByAccountId(victim.provider, victim.providerUserId),
        ).toBeNull();
        expect(await usersWithVictimEmail()).toBe(1);
    };

    it('a password registration that was never verified is not linked into', async () => {
        const preHijacked = await users.create({
            username: 'squatter',
            email: VICTIM_EMAIL,
            registrationProvider: 'local',
            emailVerified: false,
            isActive: true,
        });

        await expectRefusedWithoutWrites(preHijacked, profile());
        await expectRefusedWithoutWrites(
            preHijacked,
            profile({
                provider: AuthProvider.GOOGLE as SocialAuthUser['provider'],
                providerUserId: 'g-1',
            }),
        );
    });

    it('a social sign-up whose provider reported the address unverified is not linked into', async () => {
        // The squatter's own provider account presents the victim's address unverified: that
        // creates a user with `emailVerified=false` and links the squatter's identity to it.
        const preHijacked = await authService.validateSocialUser(
            profile({
                providerUserId: '666',
                username: 'squatter',
                emailVerified: false,
                accessToken: 'gho_squatter',
            }),
        );
        expect(preHijacked).toMatchObject({ email: VICTIM_EMAIL, emailVerified: false });

        await expectRefusedWithoutWrites(preHijacked, profile());

        // The squatter's own link is untouched (it signs in to its own account, nothing more).
        expect(await accounts.findProviderAccountByAccountId('github', '666')).toMatchObject({
            userId: preHijacked.id,
            accessToken: 'gho_squatter',
        });
    });

    it('an anonymous account saved with the address (unverified) is not linked into', async () => {
        const events = { emit: jest.fn() };
        const anonymousAuth = new AnonymousAuthService(users, dataSource, {} as never);
        const socialClaim = new SocialClaimService(
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
        const { user: anonymous } = await anonymousAuth.createAnonymousUser();
        await socialClaim.claim(
            anonymous.id,
            profile({
                providerUserId: '666',
                username: 'squatter',
                emailVerified: false,
                accessToken: 'gho_squatter',
            }),
        );
        const preHijacked = (await users.findById(anonymous.id)) as User;
        expect(preHijacked).toMatchObject({
            isAnonymous: false,
            email: VICTIM_EMAIL,
            emailVerified: false,
        });

        await expectRefusedWithoutWrites(preHijacked, profile());
    });

    it('a VERIFIED existing account still gets the new identity linked, as before', async () => {
        const owner = await users.create({
            username: 'owner',
            email: VICTIM_EMAIL,
            registrationProvider: 'local',
            emailVerified: true,
            isActive: true,
        });

        const signedIn = await authService.validateSocialUser(profile());

        expect(signedIn.id).toBe(owner.id);
        expect(await accounts.findProviderAccountByAccountId('github', '4242')).toMatchObject({
            userId: owner.id,
            accessToken: 'gho_victim',
        });
        expect(await usersWithVictimEmail()).toBe(1);
    });

    it('an identity already linked to an unverified account still signs in to it (unchanged)', async () => {
        const first = await authService.validateSocialUser(profile({ emailVerified: false }));
        expect(first.emailVerified).toBe(false);

        const again = await authService.validateSocialUser(
            profile({ emailVerified: false, accessToken: 'gho_again' }),
        );

        expect(again.id).toBe(first.id);
        expect(await accounts.findProviderAccountByAccountId('github', '4242')).toMatchObject({
            userId: first.id,
            accessToken: 'gho_again',
        });
    });
});
