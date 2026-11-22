import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthAccountRepository, UserRepository } from '@ever-works/agent/database';
import { isUniqueConstraintError } from '@ever-works/agent/utils';
import { config } from '../../config/constants';
import { UserConfirmedEvent } from '../../events';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';
import type { SocialAuthUser } from '../types/social-auth.types';
import { AuthService } from './auth.service';
import { USERNAME_TAKEN_CODE } from './claim-account.service';

/**
 * The provider identity (provider + its immutable account id) is already linked to another
 * user. Same code `AuthAccountRepository` uses for that conflict, so the web maps both alike.
 */
export const SOCIAL_CLAIM_IDENTITY_TAKEN_CODE = 'PROVIDER_ACCOUNT_ALREADY_LINKED';
/** The provider's email address already belongs to another user. */
export const SOCIAL_CLAIM_EMAIL_TAKEN_CODE = 'EMAIL_ALREADY_IN_USE';

/** The username floor `ClaimAccountService` and `RegisterDto` enforce. */
const USERNAME_MIN_LENGTH = 3;

export interface SocialClaimResult {
    id: string;
    email: string;
    username: string;
    emailVerified: boolean;
    provider: string;
}

/**
 * EW-617 — save an anonymous (zero-friction) account with a GitHub / Google identity.
 *
 * The OAuth twin of `ClaimAccountService`: the provider identity is attached to the SAME user
 * id, which then leaves anonymous mode, so every Work it owns stays with it. A normal social
 * sign-in (`AuthService.validateSocialUser`) would instead open or create a different user and
 * leave the anonymous Works to the nightly cleanup.
 *
 * Policy, as for the password claim: never auto-merge. If the identity or its email address
 * already belongs to another user, refuse (409) before anything is written, and let the visitor
 * decide (sign in to that account, or save this one another way). A demo sandbox is refused too
 * (403); `DemoRestrictionsGuard` already blocks the route on a demo host.
 *
 * Same contract as the password claim (FR-G3-10/11): the account gets a real username in place
 * of `anon-<hex>` (the provider handle, else the email's local part, made unique by the
 * allocator; the slug is stable), and a race that reaches a unique index is a 409, never a 500.
 * The controller records the terms before and rotates the session after.
 *
 * Write order, each step leaving a retryable account if a later one fails:
 *  1. the username, on its own (the account is still anonymous after it);
 *  2. the provider link: its `(providerId, accountId)` unique index decides a race between two
 *     accounts saving with the same identity before either account changes;
 *  3. the user row, in one update. If it fails, the link step 2 created is removed again, so a
 *     still-anonymous account never leaves a link behind (`account` has no foreign key to
 *     `user`, so the cleanup would orphan it and block that identity's sign-in).
 */
@Injectable()
export class SocialClaimService {
    private readonly logger = new Logger(SocialClaimService.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly authService: AuthService,
        private readonly eventEmitter: EventEmitter2,
        private readonly usernames: UsernameAllocatorService,
    ) {}

    async claim(
        userId: string,
        socialUser: SocialAuthUser,
        options: { emailVerificationCallbackUrl?: string } = {},
    ): Promise<SocialClaimResult> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        if (!user.isAnonymous) {
            throw new ForbiddenException('Account is not anonymous');
        }
        if (user.registrationProvider === 'demo') {
            throw new ForbiddenException('A demo account cannot be saved');
        }

        const accountId =
            socialUser.providerUserId === undefined || socialUser.providerUserId === null
                ? ''
                : String(socialUser.providerUserId).trim();
        if (!accountId) {
            throw new BadRequestException('The provider did not return an account id');
        }
        const email = (socialUser.email ?? '').trim();
        if (!email) {
            throw new BadRequestException('The provider did not return an email address');
        }

        const existingLink = await this.authAccountRepository.findProviderAccountByAccountId(
            socialUser.provider,
            accountId,
        );
        if (existingLink && existingLink.userId !== user.id) {
            throw this.identityTaken();
        }

        const ownEmail = (user.email ?? '').trim().toLowerCase() === email.toLowerCase();
        if (!ownEmail && (await this.userRepository.existsByEmailCaseInsensitive(email))) {
            throw this.emailTaken();
        }

        // 1. A real handle in place of `anon-<hex>` (a retried save keeps the one it got).
        let username = user.username;
        if (/^anon-/.test(user.username)) {
            username = await this.assignUsername(user.id, socialUser.username || '', email);
        }

        // Whether this user already had a row for the provider (e.g. a half-finished earlier
        // save): only a row this call creates is removed again if the user update fails.
        const hadProviderRow = !!(await this.authAccountRepository.findProviderAccount(
            user.id,
            socialUser.provider,
        ));
        // 2. The link. `upsertProviderAccount` refuses an identity another user holds; a race
        //    past that check reaches the unique index, which is the same refusal.
        try {
            await this.authAccountRepository.upsertProviderAccount({
                userId: user.id,
                providerId: socialUser.provider,
                accountId,
                username: socialUser.username || undefined,
                email,
                accessToken: socialUser.accessToken,
                refreshToken: socialUser.refreshToken || null,
                tokenType: socialUser.tokenType || 'Bearer',
                accessTokenExpiresAt: socialUser.expiresAt || null,
                scope: socialUser.scope || null,
                metadata: {
                    providerUserId: socialUser.providerUserId,
                    ...(socialUser.metadata || {}),
                },
            });
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            throw this.identityTaken();
        }

        // Only a provider that vouches for the address verifies it, as on social sign-up.
        const emailVerified = socialUser.emailVerified !== false;
        let updated: Awaited<ReturnType<UserRepository['update']>> | null;
        try {
            // 3. One update, so code racing on `isAnonymous` sees a consistent shape. A save
            //    racing this one for the same email loses on the unique index: the same 409.
            updated = await this.userRepository.update(user.id, {
                email,
                avatar: socialUser.avatar || user.avatar,
                isAnonymous: false,
                anonymousExpiresAt: null,
                registrationProvider: socialUser.provider,
                emailVerified,
                lastLoginAt: new Date(),
            });
        } catch (error) {
            await this.removeLinkCreatedHere(user.id, socialUser.provider, hadProviderRow);
            if (isUniqueConstraintError(error)) throw this.emailTaken();
            throw error;
        }
        if (!updated) {
            await this.removeLinkCreatedHere(user.id, socialUser.provider, hadProviderRow);
            throw new BadRequestException('Failed to update user');
        }

        if (emailVerified) {
            // The same welcome a verified social sign-up gets.
            this.eventEmitter.emit(
                UserConfirmedEvent.EVENT_NAME,
                new UserConfirmedEvent(updated, `${config.webAppUrl()}/works/new`),
            );
        } else {
            // Caught like the password claim: a flaky mailer must not undo the save, and the
            // user can ask for another mail from settings.
            try {
                await this.authService.sendVerificationEmail(
                    updated.id,
                    options.emailVerificationCallbackUrl,
                );
            } catch (cause) {
                this.logger.warn(
                    `Failed to send verification email for user ${updated.id} saved with ${socialUser.provider}: ${(cause as Error).message}`,
                );
            }
        }

        this.logger.log(
            `anonymous user ${user.id} saved with ${socialUser.provider} username=${username}`,
        );

        return {
            id: updated.id,
            email: updated.email ?? email,
            username: updated.username ?? username,
            emailVerified: updated.emailVerified,
            provider: socialUser.provider,
        };
    }

    /**
     * Name the saved account: the provider handle (GitHub login, Google name), else the email's
     * local part, normalized and made unique by the allocator, written on its own. The check
     * cannot see a save racing it for the same free handle; the unique index on
     * `lower(username)` can, so a lost race allocates once more (the winner is now visible),
     * and a second loss is a 409 (`username_taken`, as on the password claim), never a 500.
     * The slug stays as it is, as on every rename.
     */
    private async assignUsername(userId: string, handle: string, email: string): Promise<string> {
        const preferred = /[a-z0-9]/i.test(handle) ? handle : (email.split('@')[0] ?? '');
        const normalized = this.usernames.normalize(preferred);
        const base = normalized.length >= USERNAME_MIN_LENGTH ? normalized : `${normalized}-user`;
        for (let attempt = 0; attempt < 2; attempt++) {
            const username = await this.usernames.allocateUsername(base);
            try {
                await this.userRepository.update(userId, { username });
                return username;
            } catch (error) {
                if (!isUniqueConstraintError(error)) throw error;
            }
        }
        throw new ConflictException({
            statusCode: 409,
            message: 'Username is already taken',
            code: USERNAME_TAKEN_CODE,
        });
    }

    private identityTaken(): ConflictException {
        return new ConflictException({
            code: SOCIAL_CLAIM_IDENTITY_TAKEN_CODE,
            message:
                'This social account already belongs to another account. Sign in with it there, or save this account another way.',
        });
    }

    private emailTaken(): ConflictException {
        return new ConflictException({
            code: SOCIAL_CLAIM_EMAIL_TAKEN_CODE,
            message:
                'The email of this social account already belongs to another account. Sign in with it there, or save this account another way.',
        });
    }

    private async removeLinkCreatedHere(
        userId: string,
        providerId: string,
        hadProviderRow: boolean,
    ): Promise<void> {
        if (hadProviderRow) {
            return;
        }
        try {
            await this.authAccountRepository.deleteProviderAccount(userId, providerId);
        } catch (cause) {
            this.logger.error(
                `Could not remove the ${providerId} link of anonymous user ${userId} after a failed save: ${(cause as Error).message}`,
            );
        }
    }
}
