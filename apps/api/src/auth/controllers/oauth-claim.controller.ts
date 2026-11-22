import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    Param,
    Post,
    Req,
    Res,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { IntegrationForbiddenGuard } from '../integration/integration-forbidden.guard';
import { OAuthClaimDto } from '../dto/auth.dto';
import { OAuthStateService } from '../services/oauth-state.service';
import { SocialAuthService } from '../services/social-auth.service';
import { SocialClaimService } from '../services/social-claim.service';
import { TermsAcceptanceService } from '../../terms/terms-acceptance.service';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';

// Duck-typed like `OAuthController`: the API does not depend on `@types/express`.
type ClaimRequest = {
    ip?: string;
    headers: Record<string, string | string[] | undefined>;
    user?: { userId?: string; isAnonymous?: boolean } | null;
};
type ClaimResponse = {
    setHeader(name: string, value: string | string[]): void;
};

/**
 * EW-617 — `POST /api/oauth/:providerId/claim`: save the signed-in anonymous account with a
 * GitHub / Google identity, keeping its user id and so every Work it owns.
 *
 * Reached from the web OAuth callback route when the flow was started on `/save-account`. Not
 * `@Public`: the global `AuthSessionGuard` resolves the anonymous bearer the web forwards, and
 * that session, not anything in the body, decides which account is saved. The `state` goes
 * through the same C-03 check as `GET /api/oauth/:providerId/callback` before the code is
 * exchanged. `DemoRestrictionsGuard` refuses the route on a demo host (social sign-in).
 */
@ApiTags('Auth')
@Controller('api/oauth')
@UseGuards(IntegrationForbiddenGuard)
export class OAuthClaimController {
    private readonly logger = new Logger(OAuthClaimController.name);

    constructor(
        private readonly socialAuthService: SocialAuthService,
        private readonly socialClaimService: SocialClaimService,
        private readonly oauthState: OAuthStateService,
        private readonly termsAcceptanceService: TermsAcceptanceService,
        private readonly activityLogService: ActivityLogService,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    @Post(':providerId/claim')
    // Same budget as `POST /api/auth/claim`, on the configured `long` tier.
    @Throttle({ long: { limit: 10, ttl: 60 * 60 * 1000 } })
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Save an anonymous account with a social identity',
        description:
            'Exchanges the OAuth callback code and attaches the provider identity to the signed-in anonymous account (same user id, so its Works stay), takes it out of anonymous mode, records the terms and issues a regular session. Refuses with 409, and changes nothing, when the identity or its email already belongs to another account.',
    })
    @ApiResponse({ status: 200, description: 'Account saved; a regular session is returned' })
    @ApiResponse({
        status: 400,
        description: 'State check failed or the provider refused the code',
    })
    @ApiResponse({ status: 403, description: 'The account is not anonymous, or is a demo sandbox' })
    @ApiResponse({
        status: 409,
        description: 'The provider identity or its email already belongs to another account',
    })
    async claim(
        @Param('providerId') providerId: string,
        @Body() body: OAuthClaimDto,
        @Req() req: ClaimRequest,
        @Res({ passthrough: true }) res: ClaimResponse,
    ) {
        // C-03 first, exactly as the sign-in callback: nothing is exchanged for a state the
        // browser that started the flow does not hold.
        const rawCookieHeader = req.headers.cookie;
        const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader[0] : rawCookieHeader;
        const stateResult = this.oauthState.verify({
            cookieHeader,
            stateQuery: body.state,
            secure: process.env.NODE_ENV === 'production',
        });
        res.setHeader('Set-Cookie', stateResult.clearCookie);
        if (!stateResult.valid) {
            throw new BadRequestException(`OAuth state verification failed: ${stateResult.reason}`);
        }

        const userId = req.user?.userId;
        if (!userId) {
            throw new UnauthorizedException();
        }
        // Pinned at the controller like `POST /api/auth/claim` (L-05); the service checks again.
        if (req.user?.isAnonymous !== true) {
            throw new ForbiddenException(
                'saving with a social account is only valid for anonymous (zero-friction) accounts',
            );
        }

        // Before the code is spent and before the account changes, as `register` does.
        if (body.terms?.length) {
            this.termsAcceptanceService.assertClaimsArePublished(body.terms);
        }

        const socialUser = await this.socialAuthService.fetchSocialUser(providerId, body.code);
        const saved = await this.socialClaimService.claim(userId, socialUser, {
            emailVerificationCallbackUrl: body.emailVerificationCallbackUrl,
        });

        const userAgentHeader = req.headers['user-agent'];
        const userAgent = typeof userAgentHeader === 'string' ? userAgentHeader : null;
        const xForwardedFor = req.headers['x-forwarded-for'];
        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof xForwardedFor === 'string' ? xForwardedFor.split(',')[0].trim() : null);

        // Logged and swallowed like `register` and the password claim: the claims were checked
        // above, the account is saved, and the write is idempotent.
        if (body.terms?.length) {
            try {
                await this.termsAcceptanceService.record(saved.id, body.terms, {
                    method: 'signup-checkbox',
                    ip: ipAddress,
                    userAgent,
                });
            } catch (error) {
                this.logger.error(
                    `Failed to record terms acceptance for user ${saved.id} saved with ${providerId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        // A regular session: the anonymous one ends when the anonymous account would have.
        const session = await this.authProvider.issueSession(saved.id, { ipAddress, userAgent });

        this.activityLogService
            .log({
                userId: saved.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.account_claimed',
                status: ActivityStatus.COMPLETED,
                summary: `Anonymous user saved the account with ${this.socialAuthService.getProviderDisplayName(providerId)}`,
                ipAddress,
                userAgent,
                metadata: { provider: saved.provider },
            })
            .catch(() => {});

        return {
            access_token: session.access_token,
            user: {
                id: saved.id,
                email: saved.email,
                username: saved.username,
                emailVerified: saved.emailVerified,
            },
        };
    }
}
