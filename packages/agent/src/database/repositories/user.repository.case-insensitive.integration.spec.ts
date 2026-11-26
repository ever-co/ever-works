import { DataSource } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { UserRepository } from './user.repository';

/**
 * The case-insensitive email fallbacks against a real driver (the in-memory
 * better-sqlite3 database CI runs), so the generated SQL itself is pinned: a mock
 * of the query builder cannot tell `lower(a) = lower(?)` from a case-sensitive match.
 */
describe('UserRepository case-insensitive email lookups (better-sqlite3)', () => {
    let dataSource: DataSource;
    let users: UserRepository;

    const add = (username: string, email: string | null) =>
        dataSource.getRepository(User).insert({ username, slug: username, email, password: 'x' } as never);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        users = new UserRepository(dataSource.getRepository(User));
        await add('jane', 'jane@example.com');
        await add('dup-lower', 'dup@x.com');
        await add('dup-mixed', 'Dup@x.com');
        await add('joerg', 'jörg@x.de');
        await add('anon', null);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('finds the single user whatever the case and padding', async () => {
        await expect(
            users.findUniqueByEmailCaseInsensitive('Jane@Example.COM'),
        ).resolves.toMatchObject({ username: 'jane' });
        await expect(
            users.findUniqueByEmailCaseInsensitive('  JANE@example.com  '),
        ).resolves.toMatchObject({ username: 'jane' });
    });

    it('returns null for case-variant duplicates, an unknown address and an injection attempt', async () => {
        await expect(users.findUniqueByEmailCaseInsensitive('DUP@x.com')).resolves.toBeNull();
        await expect(users.findUniqueByEmailCaseInsensitive('nobody@x.com')).resolves.toBeNull();
        await expect(users.findUniqueByEmailCaseInsensitive("x' OR 1=1 --")).resolves.toBeNull();
    });

    it('does not run the fallback for non-ASCII input', async () => {
        await expect(users.findUniqueByEmailCaseInsensitive('JÖRG@x.de')).resolves.toBeNull();
        await expect(users.findUniqueByEmailCaseInsensitive('jörg@x.de')).resolves.toBeNull();
    });

    it('social-auth variant returns both duplicates, one match, or none', async () => {
        await expect(
            users.findByEmailCaseInsensitiveForSocialAuth('DUP@x.com'),
        ).resolves.toHaveLength(2);
        const [one] = await users.findByEmailCaseInsensitiveForSocialAuth('JANE@example.com');
        expect(one).toMatchObject({ username: 'jane', email: 'jane@example.com' });
        expect(one).not.toHaveProperty('password');
        await expect(
            users.findByEmailCaseInsensitiveForSocialAuth('nobody@x.com'),
        ).resolves.toEqual([]);
    });
});
