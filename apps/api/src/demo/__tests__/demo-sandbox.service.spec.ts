import { InternalServerErrorException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ENTITIES, UserRepository } from '@ever-works/agent/database';
import { AuthSession, User } from '@ever-works/agent/entities';
import { DemoFullError } from '@ever-works/agent/demo';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import { DemoSandboxService } from '../demo-sandbox.service';

const DAY = 24 * 3_600_000;

describe('DemoSandboxService', () => {
    let dataSource: DataSource;
    let userRepository: UserRepository;
    let seeder: { seed: jest.Mock };
    let service: DemoSandboxService;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        userRepository = new UserRepository(dataSource.getRepository(User));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(AuthSession).clear();
        await dataSource.getRepository(User).clear();
        seeder = { seed: jest.fn().mockResolvedValue({}) };
        service = new DemoSandboxService(userRepository, dataSource, seeder as never);
    });

    it('creates a demo user, a hashed session with the same expiry, and returns the token', async () => {
        const before = Date.now();
        const res = await service.createSandbox({ ipAddress: '1.2.3.4', userAgent: 'jest' });

        const users = await dataSource.getRepository(User).find();
        expect(users).toHaveLength(1);
        const user = users[0];
        expect(user.username).toMatch(/^demo-[0-9a-f]{8}$/);
        expect(user.registrationProvider).toBe('demo');
        expect(user.isAnonymous).toBe(true);
        expect(user.displayName).toBe('Demo User');
        expect(user.email ?? null).toBeNull();
        expect(Math.abs(user.anonymousExpiresAt!.getTime() - (before + DAY))).toBeLessThan(10_000);
        expect(user.onboardingCompletedAt).toBeInstanceOf(Date);
        expect(user.onboardingState).toMatchObject({
            ...ONBOARDING_DEFAULT_STATE,
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'ever-works' },
        });

        const sessions = await dataSource.getRepository(AuthSession).find();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].userId).toBe(user.id);
        expect(sessions[0].token).toBeNull();
        expect(sessions[0].tokenHash).toBe(createHash('sha256').update(res.access_token, 'utf8').digest('hex'));
        expect(sessions[0].expiresAt.getTime()).toBe(user.anonymousExpiresAt!.getTime());
        expect(sessions[0].ipAddress).toBe('1.2.3.4');

        expect(res.user).toEqual({ id: user.id, username: user.username, isDemo: true });
        expect(res.expiresAt).toBe(user.anonymousExpiresAt!.toISOString());
    });

    it('calls the seeder once with the user', async () => {
        await service.createSandbox({ ipAddress: null, userAgent: null });
        expect(seeder.seed).toHaveBeenCalledTimes(1);
        const arg = seeder.seed.mock.calls[0][0] as User;
        expect(arg.username).toMatch(/^demo-/);
    });

    it('deletes the user and its session and throws a generic 500 when seeding fails', async () => {
        seeder.seed.mockRejectedValue(new Error('boom: secret detail'));
        const err = await service.createSandbox({ ipAddress: null, userAgent: null }).catch((e) => e);
        expect(err).toBeInstanceOf(InternalServerErrorException);
        expect(err.message).toBe('Could not start the demo');
        expect(await dataSource.getRepository(User).count()).toBe(0);
        expect(await dataSource.getRepository(AuthSession).count()).toBe(0);
    });

    it('throws DEMO_FULL at the active-sandbox cap and creates nothing', async () => {
        jest.spyOn(userRepository, 'countActiveDemo').mockResolvedValue(300);
        const err = await service.createSandbox({ ipAddress: null, userAgent: null }).catch((e) => e);
        expect(err).toBeInstanceOf(DemoFullError);
        expect(err.code).toBe('DEMO_FULL');
        expect(seeder.seed).not.toHaveBeenCalled();
        expect(await dataSource.getRepository(User).count()).toBe(0);
    });
});
