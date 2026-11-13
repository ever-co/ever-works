import {
    Body,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import type { EverPlatformOrganizationLinkView } from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { SessionOnlyGuard } from '../../auth/guards/session-only.guard';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    OrgAdmin,
    OrganizationOwnershipGuard,
} from '../../organizations/guards/organization-ownership.guard';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';
import { EverConnectLinkService } from './ever-connect-link.service';

/** Body of `POST /api/ever-connect/organizations/:orgId/link`. */
export class EverConnectLinkDto {
    @ApiProperty({
        description: 'The link code from app.ever.co (`EVL-XXXX-XXXX-XXXX`).',
        example: 'EVL-7K2M-9QXR-4HTB',
    })
    @IsString()
    @MaxLength(32)
    code!: string;
}

/**
 * An Organization's link to its Ever organization:
 *
 *   GET    /api/ever-connect/organizations/:orgId/link   the link and what it has on Ever Platform
 *   POST   /api/ever-connect/organizations/:orgId/link   link with a link code (`EVL-…`)
 *   DELETE /api/ever-connect/organizations/:orgId/link   remove the link
 *
 * Reading needs a member of the Organization; linking and removing need one of
 * its admins (`OrganizationOwnershipGuard`, as every `/organizations/:orgId`
 * route: an Organization of another account answers 404) in an interactive
 * session (an API key is refused). The routes exist only with
 * `EVER_CONNECT_ENABLED=true` and `EVER_CONNECT_LINK_CODES_ENABLED=true`;
 * otherwise each answers 404 like any unknown address. Responses are never
 * cached and never carry a code, a key or a signed document.
 */
@ApiTags('ever-connect')
@ApiBearerAuth('JWT-auth')
@Controller('api/ever-connect/organizations/:orgId/link')
@UseGuards(OrganizationOwnershipGuard)
export class EverConnectLinkController {
    constructor(
        private readonly links: EverConnectLinkService,
        private readonly membership: OrganizationMembershipService,
    ) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    @ApiOperation({ summary: "The Organization's link to its Ever organization" })
    async get(
        @Param('orgId') orgId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<EverPlatformOrganizationLinkView> {
        return this.links.view(await this.membership.ensureMember(orgId, user.userId));
    }

    @Post()
    @OrgAdmin()
    @UseGuards(SessionOnlyGuard)
    @HttpCode(HttpStatus.CREATED)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiOperation({ summary: 'Link the Organization with a link code from app.ever.co' })
    @ApiResponse({ status: 400, description: '`code_invalid`: not a link code' })
    @ApiResponse({
        status: 409,
        description: '`not_connected`, `already_linked`, `tenant_already_linked`',
    })
    @ApiResponse({
        status: 422,
        description: 'Ever Platform refused the code (`code_invalid`, `product_mismatch`, …)',
    })
    @ApiResponse({ status: 502, description: '`platform_unreachable`' })
    async link(
        @Param('orgId') orgId: string,
        @Body() body: EverConnectLinkDto,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<EverPlatformOrganizationLinkView> {
        return this.links.link(await this.membership.ensureAdmin(orgId, user.userId), body.code);
    }

    @Delete()
    @OrgAdmin()
    @UseGuards(SessionOnlyGuard)
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({ summary: "Remove the Organization's link (Ever Platform is told first)" })
    @ApiResponse({ status: 404, description: '`not_linked`' })
    @ApiResponse({
        status: 502,
        description: '`platform_unreachable`: the link stays, try again',
    })
    async unlink(
        @Param('orgId') orgId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<EverPlatformOrganizationLinkView> {
        return this.links.unlink(await this.membership.ensureAdmin(orgId, user.userId));
    }
}
