import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { SessionOnlyGuard } from '../../auth/guards/session-only.guard';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import type { PersonDataExportDocument } from './person-data-export.builder';
import { PersonDataParticipantService } from './person-data.participant';

/**
 * A person's export, at the address an `exported` answer gave Ever Platform:
 *
 *   GET /api/ever-connect/person-exports/:jobId   the signed-in account's own data
 *
 * The web app's `/api/ever-connect/person-export/:jobId` signs the person in and
 * calls this. It needs an interactive session (an API key is refused) and
 * answers only the caller's own account: the job id selects nothing but whether
 * the address is still good. `404` when `EVER_CONNECT_PERSON_EXPORT_ENABLED` is
 * off, the job is not an export answered `exported`, or the address is too old.
 */
@ApiTags('ever-connect')
@ApiBearerAuth('JWT-auth')
@Controller('api/ever-connect/person-exports')
@UseGuards(SessionOnlyGuard)
export class PersonDataExportController {
    constructor(private readonly personData: PersonDataParticipantService) {}

    @Get(':jobId')
    @Header('Cache-Control', 'no-store')
    @Header('Content-Disposition', 'attachment; filename="ever-works-person-data.json"')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiOperation({ summary: "The signed-in person's own export, for an Ever Platform request" })
    async download(
        @Param('jobId') jobId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<PersonDataExportDocument> {
        return this.personData.documentFor(jobId, user.userId);
    }
}
