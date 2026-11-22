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
import { isUniqueConstraintError } from '@ever-works/agent/utils';
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
 *     the email; never the `anon-<hex>` handle), written on its own first
 *     so a race for the handle is a 409, not a 500; the slug is stable;
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
     * The slug stays as it is, as on every other rename (`PUT /auth/profile`): nothing routes
     * by a user's slug, and repositories keep the names they were created with.
     */
    private async resolveUsername(
        user: { username: string },
        email: string,
        requested?: string,
    ): Promise<string> {
        const desired = requested?.trim();
        if (desired) {
            const normalized = this.usernames.normalize(desired);
            // The allocator falls back to a random `u-<hex>` for input with no ASCII letter
            // or digit ("!!!"); a typed handle must never silently become one, so it is refused.
            if (!/[a-z0-9]/i.test(desired) || normalized.length < USERNAME_MIN_LENGTH) {
                throw new BadRequestException(
                    `Username must be at least ${USERNAME_MIN_LENGTH} characters`,
                );
            }
            if (normalized === user.username.toLowerCase()) return normalized;
            const { available, suggestion } = await this.usernames.suggest(normalized);
            if (!available) throw this.usernameTaken(suggestion);
            return normalized;
        }

        // A real handle the row already has is kept; only the `anon-<hex>` placeholder is
        // replaced. That is a retry after an earlier attempt of this claim wrote the handle and
        // then lost the email race (the allocator counts the row's own handle as taken, so it
        // would hand out `jane-2`), or a temporary account the visitor already renamed.
        // `reserveUsername` re-allocates with an empty handle, which never matches here.
        if (user.username && !/^anon-/i.test(user.username)) return user.username;

        // Normalized once, so the floor check and the handle allocated agree.
        const local = this.usernames.normalize(email.split('@')[0] ?? '');
        const base = local.length >= USERNAME_MIN_LENGTH ? local : `${local}-user`;
        return this.usernames.allocateUsername(base);
    }

    private usernameTaken(suggestion?: string): ConflictException {
        return new ConflictException({
            statusCode: 409,
            message: 'Username is already taken',
            code: USERNAME_TAKEN_CODE,
            suggestion,
        });
    }

    /**
     * Write the new handle on its own, BEFORE any credential is touched. The availability
     * check above cannot see a claim racing it for the same free handle; the database can
     * (the unique index on `lower(username)`), so its violation is answered here as the
     * same 409 instead of a 500, with nothing else changed. A derived handle gets one more
     * allocation (the winner's handle is now visible to it); a typed one is the visitor's
     * choice, so they get the 409 and a fresh suggestion.
     */
    private async reserveUsername(
        userId: string,
        username: string,
        retry: { email: string } | null,
    ): Promise<string> {
        try {
            await this.userRepository.update(userId, { username });
            return username;
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            if (!retry) {
                throw this.usernameTaken((await this.usernames.suggest(username)).suggestion);
            }
            const next = await this.resolveUsername({ username: '' }, retry.email);
            try {
                await this.userRepository.update(userId, { username: next });
                return next;
            } catch (again) {
                if (!isUniqueConstraintError(again)) throw again;
                throw this.usernameTaken();
            }
        }
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
        const typed = Boolean(input.username?.trim());
        let username = await this.resolveUsername(user, normalizedEmail, input.username);

        // 1. The handle, on its own and first (see `reserveUsername`). The account is still
        //    anonymous after it, so a later failure leaves a retryable claim: the retry keeps
        //    this handle (a typed one equal to it passes the availability check, and the
        //    derived path keeps a real handle the row already has).
        //    One leftover is accepted: a claim that loses the email race at step 3 has already
        //    stored a password hash (step 2) on the still-anonymous row. Harmless: password
        //    sign-in is by email and the row has none, a retry overwrites the hash, and the
        //    nightly cleanup deletes the row if it is never claimed.
        if (username !== user.username) {
            username = await this.reserveUsername(
                user.id,
                username,
                typed ? null : { email: normalizedEmail },
            );
        }

        // 2. Hash + persist credentials via Better Auth's adapter so the
        //    user can sign in via /api/auth/login like any other account.
        await this.authProvider.setPassword(user.id, input.password);
        const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
        if (!passwordHash) {
            throw new BadRequestException('Failed to attach credentials');
        }

        // 3. Flip the user out of anonymous mode in a single update so
        //    code racing on isAnonymous sees a consistent shape. A claim racing
        //    this one for the same email loses on the unique index: the same 409
        //    as the check above, not a 500.
        let updated: Awaited<ReturnType<UserRepository['update']>>;
        try {
            updated = await this.userRepository.update(user.id, {
                email: normalizedEmail,
                password: passwordHash,
                isAnonymous: false,
                anonymousExpiresAt: null,
                registrationProvider: 'local',
                emailVerified: false,
            });
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            throw new ConflictException(
                'Email is already in use by another account. Please sign in with the existing account instead.',
            );
        }

        if (!updated) {
            throw new BadRequestException('Failed to update user');
        }

        // 4. Verification email goes through the existing pipeline.
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
