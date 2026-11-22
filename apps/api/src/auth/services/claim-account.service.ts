import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import { AuthSyncService } from '../providers/auth-sync.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';
import { AuthService } from './auth.service';

/** Machine-readable code on the 409 a taken username answers, so the form can say so. */
export const USERNAME_TAKEN_CODE = 'username_taken';

/** The username floor `ClaimAccountDto` and `RegisterDto` enforce. */
const USERNAME_MIN_LENGTH = 3;

export interface ClaimAccountInput {
    userId: string;
    email: string;
    password: string;
    username?: string;
    emailVerificationCallbackUrl?: string;
}

/**
 * EW-617 G3 — Claim-Account flow.
 *
 * Converts an anonymous (zero-friction) `User` row into a regular,
 * credentialed account without losing any of their existing Works.
 *
 * Steps (all in one HTTP call):
 *  1. Verify the caller's session is anonymous (G2 introduced
 *     `is_anonymous`).
 *  2. Reject the request if the email is already taken by a different
 *     user. Policy: never auto-merge — that's a footgun. Ask the user
 *     to sign in with the existing account instead.
 *  3. Hash the password via the existing credential adapter
 *     (`AuthProvider.setPassword`) so the new account can sign in via
 *     `/login`.
 *  4. Flip `is_anonymous=false`, clear `anonymous_expires_at`, persist
 *     the email + a real username (the one typed, or one derived from
 *     the email; never the `anon-<hex>` handle) and the matching slug,
 *     set `registration_provider='local'`.
 *  5. Delegate to `AuthService.sendVerificationEmail` so the
 *     verification mail goes through the existing pipeline.
 *
 * The session is rotated by the controller (a fresh one replaces the
 * anonymous one, which expires with the anonymous TTL). Works ownership
 * is by `userId`, which doesn't change, so no Work transfer step is needed.
 */
@Injectable()
export class ClaimAccountService {
    private readonly logger = new Logger(ClaimAccountService.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly authSyncService: AuthSyncService,
        private readonly authService: AuthService,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
        private readonly usernames: UsernameAllocatorService,
    ) {}

    /**
     * The handle the saved account goes by. An anonymous account is called `anon-<hex>`,
     * which is what the owner saw in the sidebar after saving, so a claim always names it:
     *
     *  - a username the visitor typed, normalized the way every handle is (lowercase,
     *    `[a-z0-9-]`), and refused with a 409 + a free suggestion when another account or an
     *    Organization already uses it, BEFORE anything is written (it used to surface as a
     *    500 from the unique index);
     *  - otherwise one derived from the email's local part, made unique by the allocator.
     *
     * The slug becomes the same value: the allocator checks usernames, user slugs and
     * Organization slugs alike, and the entity's rule is that a rename updates both.
     */
    private async resolveUsername(
        user: { username: string },
        email: string,
        requested?: string,
    ): Promise<string> {
        const desired = requested?.trim();
        if (desired) {
            const normalized = this.usernames.normalize(desired);
            if (normalized.length < USERNAME_MIN_LENGTH) {
                throw new BadRequestException(
                    `Username must be at least ${USERNAME_MIN_LENGTH} characters`,
                );
            }
            if (normalized === user.username.toLowerCase()) return normalized;
            const { available, suggestion } = await this.usernames.suggest(normalized);
            if (!available) {
                throw new ConflictException({
                    statusCode: 409,
                    message: 'Username is already taken',
                    code: USERNAME_TAKEN_CODE,
                    suggestion,
                });
            }
            return normalized;
        }

        // Normalized once, so the floor check and the handle allocated agree.
        const local = this.usernames.normalize(email.split('@')[0] ?? '');
        const base = local.length >= USERNAME_MIN_LENGTH ? local : `${local}-user`;
        return this.usernames.allocateUsername(base);
    }

    async claim(input: ClaimAccountInput): Promise<{
        id: string;
        email: string;
        username: string;
        emailVerified: boolean;
    }> {
        const user = await this.userRepository.findById(input.userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        if (!user.isAnonymous) {
            throw new ForbiddenException('Account is not anonymous');
        }

        const normalizedEmail = input.email.trim().toLowerCase();
        const existingByEmail = await this.userRepository.findByEmail(normalizedEmail);
        if (existingByEmail && existingByEmail.id !== user.id) {
            throw new ConflictException(
                'Email is already in use by another account. Please sign in with the existing account instead.',
            );
        }

        // Before any write: a taken username answers 409 with the account untouched.
        const username = await this.resolveUsername(user, normalizedEmail, input.username);

        // 1. Hash + persist credentials via Better Auth's adapter so the
        //    user can sign in via /api/auth/login like any other account.
        await this.authProvider.setPassword(user.id, input.password);
        const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
        if (!passwordHash) {
            throw new BadRequestException('Failed to attach credentials');
        }

        // 2. Flip the user out of anonymous mode in a single update so
        //    code racing on isAnonymous sees a consistent shape.
        const updated = await this.userRepository.update(user.id, {
            email: normalizedEmail,
            username,
            slug: username,
            password: passwordHash,
            isAnonymous: false,
            anonymousExpiresAt: null,
            registrationProvider: 'local',
            emailVerified: false,
        });

        if (!updated) {
            throw new BadRequestException('Failed to update user');
        }

        // 3. Verification email goes through the existing pipeline.
        //    Catch here so a flaky mailer doesn't break the claim —
        //    the user can request a resend via /api/auth/send-verification.
        try {
            await this.authService.sendVerificationEmail(
                updated.id,
                input.emailVerificationCallbackUrl,
            );
        } catch (cause) {
            this.logger.warn(
                `Failed to send verification email for claimed user ${updated.id}: ${(cause as Error).message}`,
            );
        }

        this.logger.log(
            `anonymous user ${user.id} claimed account email=${normalizedEmail} username=${username}`,
        );

        return {
            id: updated.id,
            email: updated.email!,
            username: updated.username,
            emailVerified: updated.emailVerified,
        };
    }
}
