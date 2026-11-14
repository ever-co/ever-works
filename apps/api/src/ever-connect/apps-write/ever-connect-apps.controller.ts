import {
    Body,
    Controller,
    Header,
    Headers,
    Param,
    Post,
    Request,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiHeader,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DelegatedWrite } from '../../auth/decorators/delegated-write.decorator';
import { DelegatedPrincipalGuard } from '../../auth/guards/delegated-principal.guard';
import type { AuthenticatedUser, EverIdDelegationBinding } from '../../auth/types/auth.types';
import {
    EverConnectAppsService,
    type DelegatedCaller,
    type EverConnectAppCreated,
    type EverConnectAppDeployRequested,
} from './ever-connect-apps.service';

/** Answers `Idempotent-Replayed: true` on the stored answer of an earlier request. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** What the global session guard leaves on a request a delegated token authenticated. */
interface DelegatedRequest {
    user: AuthenticatedUser;
    everIdDelegation: EverIdDelegationBinding;
}

interface Reply {
    status(code: number): unknown;
    setHeader(name: string, value: string): unknown;
}

const callerOf = (request: DelegatedRequest): DelegatedCaller => ({
    auth: request.user,
    delegation: request.everIdDelegation,
});

/**
 * What another Ever app may do here for a person who allowed it, under
 * `/api/ever-connect/apps`. The module is loaded only with
 * `EVER_CONNECT_APPS_WRITE_ENABLED=true` on an installation with Ever Connect
 * on, so both routes answer 404 otherwise. No answer is cached, and neither
 * route is offered to agents.
 *
 * - `POST /apps {link_id, name, blueprint_id, install_id?}` with
 *   `Idempotency-Key`: create an App in the Organization the link is for.
 * - `POST /apps/:workId/deploy {link_id, environment?}`: start a deployment of
 *   one.
 *
 * Both take a delegated Ever ID access token carrying `apps:write` and nothing
 * else (`Authorization: Bearer`, never in the address): a session, an API key
 * or a token that may only read is refused. The body is read by the service,
 * not by the validation pipe, so that every refusal carries one of the codes
 * the calling app is told to expect.
 */
@ApiTags('Ever Connect')
@ApiBearerAuth('JWT-auth')
@Controller('api/ever-connect/apps')
@UseGuards(DelegatedPrincipalGuard)
export class EverConnectAppsController {
    constructor(private readonly apps: EverConnectAppsService) {}

    @Post()
    @DelegatedWrite('apps:write')
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiHeader({ name: 'Idempotency-Key', required: true, description: '1 to 128 characters' })
    @ApiBody({
        schema: {
            type: 'object',
            additionalProperties: false,
            required: ['link_id', 'name', 'blueprint_id'],
            properties: {
                link_id: {
                    type: 'string',
                    description: "Ever Platform's id of the link of the Organization (a ULID).",
                },
                name: { type: 'string', minLength: 1, maxLength: 100 },
                blueprint_id: {
                    type: 'string',
                    description: 'The id of a Blueprint of the Apps catalog the App starts from.',
                },
                install_id: {
                    type: 'string',
                    nullable: true,
                    description: "Ever Platform's id of the marketplace install the App is for.",
                },
            },
        },
    })
    @ApiOperation({
        summary: 'Create an App for a person, in an Organization linked to an Ever organization',
        description:
            'For another Ever app acting for a person with a delegated Ever ID access token carrying `apps:write`. The person must be a member of the Organization the link is for; the App is then created through the path a signed-in person uses, so everything that path checks applies and refuses with its own code. The same `Idempotency-Key` and body answer the App made before.',
    })
    @ApiResponse({
        status: 200,
        description: 'An identical App the person already has: the same answer',
    })
    @ApiResponse({ status: 201, description: '`{ id, name, url }`' })
    @ApiResponse({
        status: 400,
        description:
            '`validation` (with `details.field`), `token_in_query`, `app_works_disabled`, or a refusal of the repository (`provider_not_connected`, `not_found`, `target_owner_unavailable`, `blueprint_mismatch`, …)',
    })
    @ApiResponse({ status: 401, description: 'The token does not verify' })
    @ApiResponse({
        status: 403,
        description:
            '`insufficient_scope`, `no_linked_identity`, `delegated_token_required`, `not_a_member`',
    })
    @ApiResponse({ status: 404, description: '`link_not_found`, `blueprint_not_found`' })
    @ApiResponse({
        status: 409,
        description:
            '`not_connected`, `link_not_active`, `idempotency_key_reused_with_different_body`, `request_in_progress`, `app_work_exists`, `create_in_progress`, `in_use_by_another_account`',
    })
    @ApiResponse({
        status: 422,
        description: '`blueprint_required`, `blueprint_not_available`, `slug_unavailable`',
    })
    @ApiResponse({ status: 503, description: '`catalog_unavailable`, `rate_limited`' })
    async create(
        @Request() request: DelegatedRequest,
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Body() body: Record<string, unknown>,
        @Res({ passthrough: true }) reply: Reply,
    ): Promise<EverConnectAppCreated> {
        const answer = await this.apps.create(callerOf(request), idempotencyKey, body);
        reply.status(answer.status);
        if (answer.replayed) reply.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        return answer.body;
    }

    @Post(':workId/deploy')
    @DelegatedWrite('apps:write')
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiParam({ name: 'workId', description: "The App's id (as `POST /apps` answered it)" })
    @ApiBody({
        schema: {
            type: 'object',
            additionalProperties: false,
            required: ['link_id'],
            properties: {
                link_id: {
                    type: 'string',
                    description: "Ever Platform's id of the link of the App's Organization.",
                },
                environment: { type: 'string', enum: ['production'], nullable: true },
            },
        },
    })
    @ApiOperation({
        summary: 'Start a deployment of an App for a person',
        description:
            'The deploy request of `POST /api/works/{id}/deploy`, with the same preconditions, made for a person by another Ever app. It never counts as the person’s own session: a deployment that needs the Work owner’s session is refused, and nothing is confirmed for anyone.',
    })
    @ApiResponse({ status: 202, description: '`{ deployment_id, status }`' })
    @ApiResponse({ status: 400, description: '`validation`, `token_in_query`' })
    @ApiResponse({ status: 401, description: 'The token does not verify' })
    @ApiResponse({
        status: 403,
        description:
            '`insufficient_scope`, `no_linked_identity`, `delegated_token_required`, `not_a_member`, `ownerRequired`, `session_required`',
    })
    @ApiResponse({ status: 404, description: '`link_not_found`, `not_found`' })
    @ApiResponse({
        status: 409,
        description: '`not_connected`, `link_not_active`, `APP_DEPLOY_IN_PROGRESS`',
    })
    @ApiResponse({
        status: 422,
        description:
            '`notAnAppWork`, `APP_DEPLOY_PRECONDITIONS` (with `unmet`), `worker_not_isolated`',
    })
    async deploy(
        @Request() request: DelegatedRequest,
        @Param('workId') workId: string,
        @Body() body: Record<string, unknown>,
        @Res({ passthrough: true }) reply: Reply,
    ): Promise<EverConnectAppDeployRequested> {
        const answer = await this.apps.deploy(callerOf(request), workId, body);
        reply.status(answer.status);
        return answer.body;
    }
}
