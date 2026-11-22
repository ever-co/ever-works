import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ENTITIES, UserRepository } from '@ever-works/agent/database';
import { ApiKey, AuthSession, User } from '@ever-works/agent/entities';
import { AnonymousAuthService } from './anonymous-auth.service';
import { SavedAccountSessionService } from './saved-account-session.service';

/**
 * EW-617 / R57 — saving a temporary account ends EVERY credential it had, on a real SQL engine
 * (better-sqlite3, full entity inventory). Both claim routes (`POST /api/auth/claim`,
 * `POST /api/oauth/:providerId/claim`) rotate through this service.
 *
 * The case it closes: the web session cookie can be planted from a sibling subdomain, so a
 * victim can be signed in to an ATTACKER's temporary account and save it. The attacker's own
 * second session, and a personal or integration key minted before, must stop working.
 */
describe('Saving a temporary account ends every other credential (real database)', () => {
    let dataSource: DataSource;
    let users: UserRepository;
    let anonymousAuth: AnonymousAuthService;

    const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

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
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    /** What the session guard does with a bearer: find its row by digest, or answer 401. */
    const authenticates = async (token: string) =>
        (await dataSource
            .getRepository(AuthSession)
            .findOne({ where: { tokenHash: hash(token) } })) !== null;

    const addSession = (userId: string, token: string) =>
        dataSource.getRepository(AuthSession).save({
            id: randomUUID(),
            userId,
            token: null,
            tokenHash: hash(token),
            expiresAt: new Date(Date.now() + 86_400_000),
        });

    const addKey = (userId: string, kind: string, name: string) =>
        dataSource.getRepository(ApiKey).save({
            userId,
            kind: kind as ApiKey['kind'],
            name,
            hashedKey: hash(`${name}-${randomUUID()}`),
            prefix: name.slice(0, 12),
            isActive: true,
        });

    /** `issueSession` as the real provider writes it: one more session row. */
    const rotator = () =>
        new SavedAccountSessionService(
            {
                issueSession: async (userId: string) => {
                    await addSession(userId, 'fresh-token');
                    return { access_token: 'fresh-token', user: { id: userId } };
                },
            } as never,
            dataSource,
        );

    it('keeps only the fresh session and ends the keys; run tokens and other users stay', async () => {
        const { user, access_token: anonToken } = await anonymousAuth.createAnonymousUser();
        await addSession(user.id, 'second-token');
        const other = await anonymousAuth.createAnonymousUser();
        const personal = await addKey(user.id, 'personal', 'personal-key');
        const integration = await addKey(user.id, 'integration', 'integration-key');
        const runToken = await addKey(user.id, 'fleet-run', 'run-token');
        const othersKey = await addKey(other.user.id, 'personal', 'others-key');

        const token = await rotator().rotate(
            user.id,
            { ipAddress: null, userAgent: null },
            'in a test',
        );

        expect(token).toBe('fresh-token');
        expect(await authenticates('fresh-token')).toBe(true);
        // Every earlier session of the saved account now gets 401.
        expect(await authenticates(anonToken)).toBe(false);
        expect(await authenticates('second-token')).toBe(false);
        // Another account's session is untouched.
        expect(await authenticates(other.access_token)).toBe(true);

        const keys = dataSource.getRepository(ApiKey);
        expect((await keys.findOneByOrFail({ id: personal.id })).isActive).toBe(false);
        expect((await keys.findOneByOrFail({ id: integration.id })).isActive).toBe(false);
        // A run token is minted per lease for a running Work: ending it would break the run.
        expect((await keys.findOneByOrFail({ id: runToken.id })).isActive).toBe(true);
        expect((await keys.findOneByOrFail({ id: othersKey.id })).isActive).toBe(true);
    });

    it('ends nothing when no fresh session can be issued', async () => {
        const { user, access_token: anonToken } = await anonymousAuth.createAnonymousUser();
        const personal = await addKey(user.id, 'personal', 'personal-key');
        const failing = new SavedAccountSessionService(
            {
                issueSession: async () => {
                    throw new Error('session store down');
                },
            } as never,
            dataSource,
        );

        const token = await failing.rotate(
            user.id,
            { ipAddress: null, userAgent: null },
            'in a test',
        );

        expect(token).toBeUndefined();
        expect(await authenticates(anonToken)).toBe(true);
        expect(
            (await dataSource.getRepository(ApiKey).findOneByOrFail({ id: personal.id })).isActive,
        ).toBe(true);
    });
});
