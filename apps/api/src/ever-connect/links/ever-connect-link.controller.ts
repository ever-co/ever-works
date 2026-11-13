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
import { OrganizationOwnershipGuard } from '../../organizations/guards/organization-ownership.guard';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';
import { EverConnectLinkService } from './ever-connect-link.service';
import { OrganizationLinkAdminGuard } from './organization-link-admin.guard';

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
 * - **Reading** needs a member of the Organization's account
 *   (`OrganizationOwnershipGuard`, as every `/organizations/:orgId` route: an
 *   Organization of another account answers 404). The settings page shows the
 *   link to every member.
 * - **Linking and removing** need an administrator of the Organization: the
 *   account's owner, or a member whose role in it is `admin` or `owner`
 *   ({@link OrganizationLinkAdminGuard}). This does not depend on
 *   `ORG_ADMIN_ROLE_ENFORCED`: a plain member is refused with 403 in every
 *   configuration. Both also need an interactive session (an API key is
 *   refused).
 *
 * The routes exist only with `EVER_CONNECT_ENABLED=true` and
 * `EVER_CONNECT_LINK_CODES_ENABLED=true`; otherwise each answers 404 like any
 * unknown address. Responses are never cached and never carry a code, a key or
 * a signed document.
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
        const organization = await this.membership.ensureMember(orgId, user.userId);
        // Whether this person may change the link, so the page offers it to them only.
        return this.links.view(organization, await this.membership.isRoleAdmin(orgId, user.userId));
    }

    @Post()
    @UseGuards(SessionOnlyGuard, OrganizationLinkAdminGuard)
    @HttpCode(HttpStatus.CREATED)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiOperation({
        summary:
            'Link the Organization with a link code from app.ever.co (an administrator of the Organization only)',
    })
    @ApiResponse({ status: 400, description: '`code_invalid`: not a link code' })
    @ApiResponse({ status: 403, description: 'Not an administrator of the Organization' })
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
        // The guard already refused anyone else; the same check answers the Organization.
        const organization = await this.membership.ensureRoleAdmin(orgId, user.userId);
        return this.links.link(organization, body.code);
    }

    @Delete()
    @UseGuards(SessionOnlyGuard, OrganizationLinkAdminGuard)
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary:
            "Remove the Organization's link (an administrator of the Organization only; Ever Platform is told first)",
    })
    @ApiResponse({ status: 403, description: 'Not an administrator of the Organization' })
    @ApiResponse({ status: 404, description: '`not_linked`' })
    @ApiResponse({
        status: 502,
        description: '`platform_unreachable`: the link stays, try again',
    })
    async unlink(
        @Param('orgId') orgId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<EverPlatformOrganizationLinkView> {
        const organization = await this.membership.ensureRoleAdmin(orgId, user.userId);
        return this.links.unlink(organization);
    }
}
