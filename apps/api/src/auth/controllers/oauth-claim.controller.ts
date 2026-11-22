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
    ServiceUnavailableException,
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
import { toHeaders } from '../providers/request-headers';
import { trustedClientIp } from '../../config/trust-proxy';

// Duck-typed like `OAuthController`: the API does not depend on `@types/express`.
type ClaimRequest = {
    ip?: string;
    socket?: { remoteAddress?: unknown } | null;
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
 * exchanged. On a demo host the global `DemoRestrictionsGuard` (an `APP_GUARD` that
 * `DemoModule` registers when `DEMO=true`, so it needs no `@UseGuards` here) refuses the route
 * through its `DEMO_BLOCKED_ROUTES` row (social sign-in, everyone).
 *
 * Same contract as `POST /api/auth/claim` (FR-G3-8, FR-G3-10): the terms are on file BEFORE
 * the account changes (a failure to record refuses with 503, account untouched), and the
 * session is rotated afterwards (a fresh one is answered as `access_token`, then the anonymous
 * bearer is revoked; both best effort, the save already stands).
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
            'Records the terms, exchanges the OAuth callback code and attaches the provider identity to the signed-in anonymous account (same user id, so its Works stay), gives it a real username, takes it out of anonymous mode, then rotates the session: answers a fresh access_token and revokes the anonymous bearer. Refuses with 409, and changes nothing, when the identity or its email already belongs to another account.',
    })
    @ApiResponse({
        status: 200,
        description: 'Account saved; carries the new access_token (absent if none could be issued)',
    })
    @ApiResponse({
        status: 400,
        description: 'State check failed or the provider refused the code',
    })
    @ApiResponse({ status: 403, description: 'The account is not anonymous, or is a demo sandbox' })
    @ApiResponse({
        status: 409,
        description: 'The provider identity or its email already belongs to another account',
    })
    @ApiResponse({ status: 503, description: 'The terms could not be recorded; nothing changed' })
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

        // An unknown provider is a 400 here, before anything is recorded or spent.
        const providerName = this.socialAuthService.getProviderDisplayName(providerId);

        const userAgentHeader = req.headers['user-agent'];
        const userAgent = typeof userAgentHeader === 'string' ? userAgentHeader : null;
        // Express's `trust proxy` view of the caller, never the client-written left-most
        // `X-Forwarded-For` entry: the session, the terms record and the log all keep it.
        const ipAddress = trustedClientIp(req);

        // Terms first, on file BEFORE the code is spent or the account changes, as the password
        // claim does: an unpublished claim is a 400, a failure to record a 503, the account
        // untouched either way. Idempotent per (user, document, version), so a save that later
        // fails (a taken identity) and is retried records once.
        if (body.terms?.length) {
            this.termsAcceptanceService.assertClaimsArePublished(body.terms);
            try {
                await this.termsAcceptanceService.record(userId, body.terms, {
                    method: 'signup-checkbox',
                    ip: ipAddress,
                    userAgent,
                });
            } catch (error) {
                this.logger.error(
                    `Failed to record terms acceptance before saving user ${userId} with ${providerId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                throw new ServiceUnavailableException(
                    'Could not record the terms acceptance; the account was not changed. Try again.',
                );
            }
        }

        const socialUser = await this.socialAuthService.fetchSocialUser(providerId, body.code);
        const saved = await this.socialClaimService.claim(userId, socialUser, {
            emailVerificationCallbackUrl: body.emailVerificationCallbackUrl,
        });

        // Rotate the session, as the password claim does: a regular session for the same user
        // FIRST, then revoke the anonymous bearer (it would otherwise live on until the
        // anonymous TTL), so a failure in either step never leaves the caller with no valid
        // session. Both are best effort: the save is committed and still answers 200.
        let accessToken: string | undefined;
        try {
            accessToken = (await this.authProvider.issueSession(saved.id, { ipAddress, userAgent }))
                .access_token;
        } catch (error) {
            this.logger.warn(
                `User ${saved.id} saved with ${providerId}: could not issue a fresh session, keeping the anonymous one: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        if (accessToken) {
            try {
                await this.authProvider.signOut(toHeaders(req.headers || {}));
            } catch (error) {
                this.logger.warn(
                    `User ${saved.id} saved with ${providerId}: could not revoke the anonymous session: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        this.activityLogService
            .log({
                userId: saved.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.account_claimed',
                status: ActivityStatus.COMPLETED,
                summary: `Anonymous user saved the account with ${providerName}`,
                ipAddress,
                userAgent,
                metadata: { provider: saved.provider },
            })
            .catch(() => {});

        return {
            ...(accessToken ? { access_token: accessToken } : {}),
            user: {
                id: saved.id,
                email: saved.email,
                username: saved.username,
                emailVerified: saved.emailVerified,
            },
        };
    }
}
