import { DataSource } from 'typeorm';
import { ENTITIES, OrganizationRepository, UserRepository } from '@ever-works/agent/database';
import { Organization, User, Work } from '@ever-works/agent/entities';
// The file, not the `@ever-works/agent/services` barrel: the barrel reaches this app's
// AuthModule (and Better Auth's ESM build) through `work.module`, which no Jest run can load.
// Same deep-import pattern as `demo/__tests__/demo-sandbox-purge.spec.ts`.
import { AnonymousUserCleanupService } from '../../../../../packages/agent/src/services/anonymous-user-cleanup.service';
import { AnonymousAuthService } from './anonymous-auth.service';
import { ClaimAccountService } from './claim-account.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';

/**
 * EW-617 — the save-account action must KEEP the visitor's Works. Proven end to end on a
 * real SQL engine (better-sqlite3, full entity inventory), not on mocks: an anonymous account
 * is minted the way `POST /api/auth/anonymous` mints it, owns Works, is claimed through the
 * real `ClaimAccountService`, and then the real nightly cleanup runs at a moment long after
 * the original expiry. The claimed account and its Works must survive it; an identical
 * account that was never claimed must not (its Works go with it, by `ON DELETE CASCADE`).
 *
 * Only the credential adapter and the mailer are stubbed: they talk to Better Auth and SMTP,
 * and neither decides what happens to the Works.
 */
describe('Claiming an anonymous account keeps its Works (real database)', () => {
    let dataSource: DataSource;
    let users: UserRepository;
    let anonymousAuth: AnonymousAuthService;
    let claim: ClaimAccountService;
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

        anonymousAuth = new AnonymousAuthService(users, dataSource, {} as never);
        claim = new ClaimAccountService(
            users,
            { getCredentialPasswordHash: jest.fn().mockResolvedValue('hashed-pw') } as never,
            { sendVerificationEmail: jest.fn().mockResolvedValue(undefined) } as never,
            { setPassword: jest.fn().mockResolvedValue(undefined) } as never,
            new UsernameAllocatorService(
                users,
                new OrganizationRepository(dataSource.getRepository(Organization)),
            ),
        );
        // Same class at run time; the cast bridges the agent package's built and source
        // declarations, which ts-jest sees as two types once the package has been built.
        cleanup = new AnonymousUserCleanupService(users as never);
    });

    afterEach(async () => {
        await dataSource.destroy();
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

    const worksOf = (userId: string) =>
        dataSource.getRepository(Work).find({ where: { userId }, order: { slug: 'ASC' } });

    /** Well past any anonymous TTL (3 days by default), as the nightly schedule would see it. */
    const longAfterExpiry = () => new Date(Date.now() + 30 * 24 * 3_600_000);

    it('keeps the same user, its Works, and takes it out of the cleanup for good', async () => {
        const userId = await mintAnonymousWithWorks(['my-directory', 'my-landing-page']);
        const slugBefore = (await users.findById(userId))!.slug;

        const claimed = await claim.claim({
            userId,
            email: 'Visitor@Example.com',
            password: 'MySecure123!',
        });

        expect(claimed.id).toBe(userId);
        const row = await users.findById(userId);
        expect(row).toMatchObject({
            isAnonymous: false,
            email: 'visitor@example.com',
            registrationProvider: 'local',
            // A real handle now, not the anon-<hex> one. The slug is stable, as on every rename.
            username: 'visitor',
            slug: slugBefore,
        });
        expect(row?.anonymousExpiresAt ?? null).toBeNull();

        const summary = await cleanup.purgeExpired(longAfterExpiry());

        expect(summary).toMatchObject({ deleted: 0, failed: 0 });
        expect(await users.findById(userId)).not.toBeNull();
        expect((await worksOf(userId)).map((work) => work.slug)).toEqual([
            'my-directory',
            'my-landing-page',
        ]);
    });

    it('deletes an unclaimed twin with its Works (what happens without saving)', async () => {
        const kept = await mintAnonymousWithWorks(['kept-work']);
        const lost = await mintAnonymousWithWorks(['lost-work']);
        await claim.claim({ userId: kept, email: 'kept@example.com', password: 'MySecure123!' });

        const summary = await cleanup.purgeExpired(longAfterExpiry());

        expect(summary).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
        expect(await users.findById(lost)).toBeNull();
        expect(await worksOf(lost)).toEqual([]);
        expect((await worksOf(kept)).map((work) => work.slug)).toEqual(['kept-work']);
    });
});
