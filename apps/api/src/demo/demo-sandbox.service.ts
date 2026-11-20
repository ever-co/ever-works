import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { config } from '@ever-works/agent/config';
import { UserRepository } from '@ever-works/agent/database';
import { DemoFullError } from '@ever-works/agent/demo';
import { AuthSession } from '@ever-works/agent/entities';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import { hashSessionToken } from '../auth/providers/auth-provider.service';
import { DemoSandboxSeederService } from './seed/demo-sandbox-seeder.service';

export type DemoSandboxResult = {
    access_token: string;
    user: { id: string; username: string; isDemo: true };
    expiresAt: string;
};

/**
 * Platform demo mode — the one-click entry (design §5.2.2). Creates a private demo user
 * (`registrationProvider = 'demo'`, anonymous, TTL `DEMO_SANDBOX_TTL_HOURS`) with a session,
 * then seeds its workspace. The demo sweeper deletes it after the TTL; the nightly anonymous
 * cleanup skips it (`UserRepository.findExpiredAnonymous`).
 */
@Injectable()
export class DemoSandboxService {
    private readonly logger = new Logger(DemoSandboxService.name);

    constructor(
        private readonly userRepository: UserRepository,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly seeder: DemoSandboxSeederService,
    ) {}

    async createSandbox(meta: { ipAddress: string | null; userAgent: string | null }): Promise<DemoSandboxResult> {
        const now = new Date();
        if ((await this.userRepository.countActiveDemo(now)) >= config.demo.maxActiveSandboxes()) {
            throw new DemoFullError();
        }

        const expiresAt = new Date(now.getTime() + config.demo.sandboxTtlHours() * 3_600_000);
        const user = await this.userRepository.create({
            username: `demo-${randomBytes(4).toString('hex')}`,
            displayName: 'Demo User',
            email: null,
            password: null,
            isAnonymous: true,
            anonymousExpiresAt: expiresAt,
            registrationProvider: 'demo',
            emailVerified: false,
            isActive: true,
            onboardingCompletedAt: now,
            onboardingState: {
                ...ONBOARDING_DEFAULT_STATE,
                storage: { choice: 'ever-works-git' },
                deploy: { choice: 'ever-works' },
            },
        });

        const rawToken = randomBytes(32).toString('base64url');
        const sessionId = randomUUID();
        try {
            await this.dataSource.getRepository(AuthSession).save({
                id: sessionId,
                userId: user.id,
                token: null,
                tokenHash: hashSessionToken(rawToken),
                expiresAt,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent,
            });
            await this.seeder.seed(user);
        } catch (error) {
            this.logger.error(
                `demo sandbox seeding failed for ${user.username}: ${error instanceof Error ? error.message : String(error)}`,
            );
            await this.rollback(user.id);
            throw new InternalServerErrorException('Could not start the demo');
        }

        this.logger.log(`demo sandbox created id=${user.id} username=${user.username}`);
        return {
            access_token: rawToken,
            user: { id: user.id, username: user.username, isDemo: true },
            expiresAt: expiresAt.toISOString(),
        };
    }

    /** The session table has no foreign key to the user, so its rows are removed explicitly. */
    private async rollback(userId: string): Promise<void> {
        try {
            await this.dataSource.getRepository(AuthSession).delete({ userId });
            await this.userRepository.deleteAnonymous(userId);
        } catch (error) {
            this.logger.error(
                `demo sandbox rollback failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
