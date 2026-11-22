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
import { config } from '../../config/constants';
import { UserConfirmedEvent } from '../../events';
import type { SocialAuthUser } from '../types/social-auth.types';
import { AuthService } from './auth.service';

/**
 * The provider identity (provider + its immutable account id) is already linked to another
 * user. Same code `AuthAccountRepository` uses for that conflict, so the web maps both alike.
 */
export const SOCIAL_CLAIM_IDENTITY_TAKEN_CODE = 'PROVIDER_ACCOUNT_ALREADY_LINKED';
/** The provider's email address already belongs to another user. */
export const SOCIAL_CLAIM_EMAIL_TAKEN_CODE = 'EMAIL_ALREADY_IN_USE';

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
 * Write order: the provider link first, the user row second. The link's
 * `(providerId, accountId)` unique index decides a race between two accounts claiming the same
 * identity before either account changes. If the user update then fails, the link this call
 * created is removed again, so a still-anonymous account never leaves a link behind (`account`
 * has no foreign key to `user`, so the cleanup would orphan it and block that identity's
 * sign-in).
 */
@Injectable()
export class SocialClaimService {
    private readonly logger = new Logger(SocialClaimService.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly authService: AuthService,
        private readonly eventEmitter: EventEmitter2,
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
            throw new ConflictException({
                code: SOCIAL_CLAIM_IDENTITY_TAKEN_CODE,
                message:
                    'This social account already belongs to another account. Sign in with it there, or save this account another way.',
            });
        }

        const ownEmail = (user.email ?? '').trim().toLowerCase() === email.toLowerCase();
        if (!ownEmail && (await this.userRepository.existsByEmailCaseInsensitive(email))) {
            throw new ConflictException({
                code: SOCIAL_CLAIM_EMAIL_TAKEN_CODE,
                message:
                    'The email of this social account already belongs to another account. Sign in with it there, or save this account another way.',
            });
        }

        // Whether this user already had a row for the provider (e.g. a half-finished earlier
        // save): only a row this call creates is removed again if the user update fails.
        const hadProviderRow = !!(await this.authAccountRepository.findProviderAccount(
            user.id,
            socialUser.provider,
        ));
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

        // Only a provider that vouches for the address verifies it, as on social sign-up.
        const emailVerified = socialUser.emailVerified !== false;
        let updated: Awaited<ReturnType<UserRepository['update']>> | null;
        try {
            // One update, so code racing on `isAnonymous` sees a consistent shape. The username
            // stays (`anon-…`): renaming also moves the slug, and the provider handle may be
            // taken here. The user can rename in settings, as after the password claim.
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

        this.logger.log(`anonymous user ${user.id} saved with ${socialUser.provider}`);

        return {
            id: updated.id,
            email: updated.email ?? email,
            username: updated.username,
            emailVerified: updated.emailVerified,
            provider: socialUser.provider,
        };
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
