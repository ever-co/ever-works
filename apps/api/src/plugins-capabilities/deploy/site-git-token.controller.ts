import {
    BadGatewayException,
    ConflictException,
    Controller,
    Header,
    Headers,
    HttpCode,
    Param,
    Post,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import {
    SiteGitTokenError,
    SiteGitTokenService,
    type MintedSiteGitToken,
} from './site-git-token.service';

/** A Work id as the route accepts it (UUIDs in practice). */
const WORK_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The site git-token broker: a deployed directory site trades its per-site
 * secret for a one-hour GitHub token narrowed to its own data repo. See
 * {@link SiteGitTokenService} for the model.
 */
@ApiTags('Sites')
@Controller('api/sites')
export class SiteGitTokenController {
    constructor(private readonly siteGitTokens: SiteGitTokenService) {}

    @Post(':workId/git-token')
    @Public()
    // A site refreshes about once per 40 minutes per process; 30/min per IP
    // leaves room for many replicas behind one egress IP while capping a
    // guessing caller.
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: "Mint a short-lived git token for a site's own data repository",
        description:
            'Called by a deployed directory site with `Authorization: Bearer <EVER_WORKS_SITE_GIT_TOKEN_SECRET>`. ' +
            'Returns a GitHub App installation token narrowed to the Work’s data repository with Contents: write, ' +
            'valid for about one hour. Off unless `EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED=true`.',
    })
    @ApiResponse({ status: 200, description: '`{ token, expiresAt, repository }`' })
    @ApiResponse({ status: 401, description: 'Missing or invalid site secret, or unknown Work' })
    @ApiResponse({
        status: 409,
        description: 'The Work’s data repository is not one the broker serves',
    })
    @ApiResponse({ status: 502, description: 'GitHub refused the mint' })
    @ApiResponse({ status: 503, description: 'Broker disabled or not configured' })
    async mint(
        @Param('workId') workId: string,
        @Headers('authorization') authorization?: string,
    ): Promise<MintedSiteGitToken> {
        const presented =
            typeof authorization === 'string' && authorization.startsWith('Bearer ')
                ? authorization.slice('Bearer '.length).trim()
                : '';
        if (!presented || typeof workId !== 'string' || !WORK_ID.test(workId)) {
            throw new UnauthorizedException('Invalid site credentials');
        }
        let minted: MintedSiteGitToken | null;
        try {
            minted = await this.siteGitTokens.mintForSite(workId, presented);
        } catch (error) {
            if (error instanceof SiteGitTokenError) {
                switch (error.reason) {
                    case 'disabled':
                    case 'not-configured':
                        throw new ServiceUnavailableException({ error: error.reason });
                    case 'mint-failed':
                        throw new BadGatewayException({ error: error.reason });
                    default:
                        throw new ConflictException({ error: error.reason });
                }
            }
            throw error;
        }
        if (!minted) throw new UnauthorizedException('Invalid site credentials');
        return minted;
    }
}
