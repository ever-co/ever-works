import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiPropertyOptional,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsOptional } from 'class-validator';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { IsPlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
import { SessionOnlyGuard } from '../../auth/guards/session-only.guard';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    InstallApprovalService,
    type InstallRequestView,
    type InstallRequestsView,
} from './install-approval.service';

/** Body of `POST /api/ever-connect/install-requests/:installId/approve`. */
export class ApproveInstallRequestDto {
    @ApiPropertyOptional({
        description:
            'Add the package to the plugin allow-list (only when it is not on it). Never assumed: without `true`, a package that is not allow-listed is refused with `package_not_allowlisted`.',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    addToAllowlist?: boolean;
}

/** An install id as Ever Platform issues it (a ULID). */
const INSTALL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Install requests from apps.ever.co — the platform admins' routes:
 *
 *   GET  /api/ever-connect/install-requests                     open and recent requests
 *   POST /api/ever-connect/install-requests/:installId/approve  install it (dynamic installer)
 *   POST /api/ever-connect/install-requests/:installId/decline  decline it
 *
 * Approve and decline need the admin's interactive session (an API key acting
 * as the admin is refused). The module is not loaded unless
 * `EVER_CONNECT_ENABLED=true`, so every route then answers 404. Responses
 * carry ids, package coordinates and fixed tokens only, and are never cached.
 */
@ApiTags('ever-connect')
@ApiBearerAuth('JWT-auth')
@Controller('api/ever-connect/install-requests')
@UseGuards(IsPlatformAdminGuard)
export class InstallRequestsController {
    constructor(private readonly approvals: InstallApprovalService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Install requests from apps.ever.co: the open ones and the recent answers',
    })
    async list(): Promise<InstallRequestsView> {
        return this.approvals.view();
    }

    @Post(':installId/approve')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Approve an install request: the dynamic plugin installer installs the declared package, version and integrity',
    })
    @ApiResponse({ status: 404, description: '`not_found`' })
    @ApiResponse({
        status: 409,
        description: '`not_open`: already answered or withdrawn; `integration_not_enabled`',
    })
    @ApiResponse({
        status: 422,
        description:
            '`installer_disabled`, `not_installable`, `package_not_allowlisted` (the request stays open), `package_allowlist_disabled`',
    })
    async approve(
        @Param('installId') installId: string,
        @Body() body: ApproveInstallRequestDto,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<InstallRequestView> {
        return this.approvals.approve(checked(installId), user.userId, {
            addToAllowlist: body?.addToAllowlist === true,
        });
    }

    @Post(':installId/decline')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Decline an install request (apps.ever.co is told it was not installed)',
    })
    @ApiResponse({ status: 404, description: '`not_found`' })
    @ApiResponse({ status: 409, description: '`not_open`: already answered or withdrawn' })
    async decline(
        @Param('installId') installId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<InstallRequestView> {
        return this.approvals.decline(checked(installId), user.userId);
    }
}

function checked(installId: string): string {
    if (!INSTALL_ID.test(installId)) {
        throw new NotFoundException({ code: 'not_found', message: 'No such install request.' });
    }
    return installId;
}
