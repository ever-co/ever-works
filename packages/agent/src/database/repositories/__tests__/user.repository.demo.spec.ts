import { DataSource } from 'typeorm';
import { User } from '../../../entities/user.entity';
import { ENTITIES } from '../../_entities-inventory';
import { UserRepository } from '../user.repository';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

describe('UserRepository demo sandboxes (SQLite in-memory)', () => {
    let dataSource: DataSource;
    let users: UserRepository;
    let n = 0;

    const make = (registrationProvider: string, anonymousExpiresAt: Date, isAnonymous = true) =>
        users.create({
            username: `u-${registrationProvider}-${++n}`,
            email: null,
            password: null,
            isAnonymous,
            anonymousExpiresAt,
            registrationProvider,
            emailVerified: false,
            isActive: true,
        });

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        users = new UserRepository(dataSource.getRepository(User));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(User).clear();
    });

    it('findExpiredAnonymous ignores an expired demo user but still returns an expired anonymous one', async () => {
        const anon = await make('anonymous', hours(-1));
        await make('demo', hours(-1));
        const found = await users.findExpiredAnonymous(NOW);
        expect(found.map((u) => u.id)).toEqual([anon.id]);
    });

    it('findExpiredDemo returns only expired demo users, oldest first, honouring the limit', async () => {
        const oldest = await make('demo', hours(-5));
        const older = await make('demo', hours(-3));
        await make('demo', hours(-1));
        await make('demo', hours(2)); // not expired
        await make('anonymous', hours(-10)); // not demo

        const all = await users.findExpiredDemo(NOW, 10);
        expect(all).toHaveLength(3);
        const limited = await users.findExpiredDemo(NOW, 2);
        expect(limited.map((u) => u.id)).toEqual([oldest.id, older.id]);
    });

    it('countActiveDemo counts only unexpired demo users', async () => {
        await make('demo', hours(2));
        await make('demo', hours(20));
        await make('demo', hours(-1));
        await make('anonymous', hours(5));
        expect(await users.countActiveDemo(NOW)).toBe(2);
    });
});
