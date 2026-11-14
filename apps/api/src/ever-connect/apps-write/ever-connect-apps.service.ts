import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    EVER_PLATFORM_INSTALL_ID_PATTERN,
    type AppRepositoryMode,
    type AppSourceInspectResponse,
} from '@ever-works/contracts';
import { AppDeployRequestService, AppTargetService } from '@ever-works/agent/app-runtime';
import { AppSourceInspectorService } from '@ever-works/agent/app-works';
import { config as agentConfig } from '@ever-works/agent/config';
import { UserRepository } from '@ever-works/agent/database';
import { CreateWorkDto } from '@ever-works/agent/dto';
import { EverConnectLink, type Organization, type User } from '@ever-works/agent/entities';
import {
    IDEMPOTENCY_KEY_MAX_LENGTH,
    IdempotencyConflictError,
    IntegrationIdempotencyService,
    idempotencyRequestHash,
} from '@ever-works/agent/integrations-api';
import {
    WorkLifecycleService,
    WorkOwnershipService,
    WorkQueryService,
} from '@ever-works/agent/services';
import type { AuthenticatedUser, EverIdDelegationBinding } from '../../auth/types/auth.types';
import { config } from '../../config/constants';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';
import { ScopeContextService } from '../../scope/scope-context.service';
import { APP_OWNER_REQUIRED_CODE, appTargetChangeRequiresOwner } from '../../works/app-owner-gate';
import { AppsCatalogManifestService } from '../../works/apps-catalog-manifest.service';
import { EverConnectService } from '../ever-connect.service';

/** The path of the create route: part of what makes two requests "the same request". */
export const EVER_CONNECT_APPS_PATH = '/api/ever-connect/apps';

/** A tenant link id as Ever Platform issues it (a ULID). */
const LINK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** A Blueprint's id in the Apps catalog, as `CreateWorkDto.blueprintId` reads it. */
const BLUEPRINT_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest name a Work takes (`CreateWorkDto.name`). */
const NAME_MAX = 100;
/** The longest description a Work takes (`CreateWorkDto.description`). */
const DESCRIPTION_MAX = 500;

/**
 * Every refusal these two routes give on their own, by code. A refusal of the
 * creation path or of the deploy service keeps the code that path gave it
 * (`app_works_disabled`, `provider_not_connected`, `app_work_exists`,
 * `APP_DEPLOY_PRECONDITIONS`, …).
 */
export const EVER_CONNECT_APPS_CODES = {
    validation: 'validation',
    notConnected: 'not_connected',
    linkNotFound: 'link_not_found',
    linkNotActive: 'link_not_active',
    notAMember: 'not_a_member',
    blueprintRequired: 'blueprint_required',
    blueprintNotFound: 'blueprint_not_found',
    blueprintNotAvailable: 'blueprint_not_available',
    catalogUnavailable: 'catalog_unavailable',
    appWorksDisabled: 'app_works_disabled',
    targetOwnerUnavailable: 'target_owner_unavailable',
    slugUnavailable: 'slug_unavailable',
    createRefused: 'create_refused',
    idempotencyKeyReused: 'idempotency_key_reused_with_different_body',
    requestInProgress: 'request_in_progress',
    notFound: 'not_found',
    notAnAppWork: 'notAnAppWork',
    ownerRequired: APP_OWNER_REQUIRED_CODE,
    sessionRequired: 'session_required',
    deployRefused: 'deploy_refused',
} as const;

/** `POST /api/ever-connect/apps`: the App that was created (or made before). */
export interface EverConnectAppCreated {
    /** The App's id here (the Work's id): what the apps mirror reports it under. */
    id: string;
    name: string;
    /** The App's page in Ever Works. */
    url: string;
}

/** `POST /api/ever-connect/apps/:workId/deploy`: the deployment that was asked for. */
export interface EverConnectAppDeployRequested {
    deployment_id: string;
    /** `accepted`: created and handed to the worker. `queued`: waits behind a running one. */
    status: 'accepted' | 'queued';
}

/** What a caller is: the person, and the app acting for them. */
export interface DelegatedCaller {
    readonly auth: AuthenticatedUser;
    readonly delegation: EverIdDelegationBinding;
}

/** A refusal: the platform's error body with a stable code, never a value of anyone's. */
function problem(status: number, code: string, message: string, extra?: object): HttpException {
    return new HttpException({ status: 'error', code, message, ...extra }, status);
}

const invalid = (field: string, message: string) =>
    problem(HttpStatus.BAD_REQUEST, EVER_CONNECT_APPS_CODES.validation, message, {
        details: { field },
    });

/**
 * What another Ever app may do here for a person who allowed it (an Ever ID
 * access token carrying `apps:write`), behind `EVER_CONNECT_APPS_WRITE_ENABLED`:
 * create an App in an Organization linked to an Ever organization, and start a
 * deployment of one.
 *
 * Both act **as the person**, and decide nothing of their own about the App:
 *
 * - {@link create} resolves the Organization from the link the request names,
 *   checks that the person is a member of it, and calls the creation path a
 *   signed-in person uses (`WorkLifecycleService.createWork`, `kind: 'app'`)
 *   inside that Organization's scope. Whether App Works are on, the person's
 *   Git connection, the mode the repository allows, the Blueprint, a Work that
 *   already exists: each is checked there, and its refusal is passed on with
 *   the code it has.
 * - {@link deploy} calls the deploy service of `POST /api/works/:id/deploy`
 *   with the same preconditions, as a caller that is **not** an interactive
 *   session: a deployment that needs the Work owner's own session (a cluster
 *   credential another member saved, a change of the cluster an App runs on)
 *   stays refused, and nothing is confirmed on anyone's behalf.
 *
 * A create is repeat-safe under its `Idempotency-Key`: the same key and body
 * answer the App made before; the same key with another body is refused.
 */
@Injectable()
export class EverConnectAppsService {
    private readonly logger = new Logger('EverConnectApps');

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly connection: EverConnectService,
        private readonly membership: OrganizationMembershipService,
        private readonly users: UserRepository,
        private readonly scope: ScopeContextService,
        private readonly catalog: AppsCatalogManifestService,
        private readonly inspector: AppSourceInspectorService,
        private readonly works: WorkLifecycleService,
        private readonly workQuery: WorkQueryService,
        private readonly ownership: WorkOwnershipService,
        private readonly deployRequest: AppDeployRequestService,
        private readonly idempotency: IntegrationIdempotencyService,
        // Without it nothing can say that a cluster credential waits for its owner; the
        // deploy preconditions still refuse such a credential for every caller.
        @Optional() private readonly targets?: AppTargetService,
    ) {}

    // ── Create ───────────────────────────────────────────────────────────────

    /**
     * Create an App for the person. `status` is 201 for a new App and 200 for
     * one an identical request already made (the creation path's own answer);
     * `replayed` says the answer is the stored one of an earlier request with
     * the same `Idempotency-Key`.
     */
    async create(
        caller: DelegatedCaller,
        idempotencyKey: unknown,
        body: unknown,
    ): Promise<{ status: number; body: EverConnectAppCreated; replayed: boolean }> {
        const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
        if (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
            throw invalid(
                'Idempotency-Key',
                `The Idempotency-Key header is required (1 to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters).`,
            );
        }
        const request = readCreate(body);
        const blueprintId = request.blueprintId;
        if (!blueprintId) {
            throw problem(
                HttpStatus.UNPROCESSABLE_ENTITY,
                EVER_CONNECT_APPS_CODES.blueprintRequired,
                'An App is started from a Blueprint of the Apps catalog: name one in blueprint_id.',
            );
        }
        // Before anything is looked up: the answer of an installation that does not make Apps.
        this.assertAppWorksEnabled();
        const { link, organization } = await this.resolveLink(caller, request.linkId);

        try {
            const result = await this.idempotency.run(
                {
                    // One person's creates: a key is theirs, whichever app sends it.
                    integrationKeyId: caller.auth.userId,
                    idempotencyKey: key,
                    requestHash: idempotencyRequestHash('POST', EVER_CONNECT_APPS_PATH, {
                        link_id: request.linkId,
                        name: request.name,
                        blueprint_id: request.blueprintId,
                        install_id: request.installId,
                    }),
                },
                () => this.createOnce(caller, { ...request, blueprintId }, link, organization),
            );
            return {
                status: result.status,
                body: result.body as EverConnectAppCreated,
                replayed: result.replayed,
            };
        } catch (error) {
            if (error instanceof IdempotencyConflictError) {
                throw error.reason === 'request_mismatch'
                    ? problem(
                          HttpStatus.CONFLICT,
                          EVER_CONNECT_APPS_CODES.idempotencyKeyReused,
                          'This Idempotency-Key was already used with other values.',
                      )
                    : problem(
                          HttpStatus.CONFLICT,
                          EVER_CONNECT_APPS_CODES.requestInProgress,
                          'A request with this Idempotency-Key is still running; try again in a moment.',
                      );
            }
            throw error;
        }
    }

    /** The create itself: what runs once per `Idempotency-Key`. */
    private async createOnce(
        caller: DelegatedCaller,
        request: CreateRequest & { blueprintId: string },
        link: EverConnectLink,
        organization: Organization,
    ): Promise<{ status: number; body: EverConnectAppCreated }> {
        const upstreamUrl = await this.blueprintUpstream(request.blueprintId);
        const user = await this.personOf(caller);

        // The Organization's scope, as `/org/<slug>/…` gives a signed-in person's request:
        // the Work is created in the Organization the link names, nowhere else.
        const scope = { tenantId: link.tenantId, organizationId: link.organizationId };
        const created = await this.scope
            .runWith(scope, async () => {
                const preview = await this.inspector.inspect(upstreamUrl, user, {
                    blueprintId: request.blueprintId,
                });
                const { mode, targetOwner } = chooseRelation(preview);
                const availability = await this.workQuery.checkSlugAvailability(request.name, user);
                const slug = availability.available ? availability.slug : availability.suggestion;
                if (!slug) {
                    throw problem(
                        HttpStatus.UNPROCESSABLE_ENTITY,
                        EVER_CONNECT_APPS_CODES.slugUnavailable,
                        'No address could be made from this name; choose another name.',
                    );
                }
                const dto: CreateWorkDto = Object.assign(new CreateWorkDto(), {
                    slug,
                    name: request.name,
                    description: descriptionOf(request.name, preview),
                    organization: false,
                    gitProvider: 'github',
                    kind: 'app',
                    repositoryUrl: preview.repository.url,
                    repositoryMode: mode,
                    ...(targetOwner ? { targetOwner } : {}),
                    blueprintId: request.blueprintId,
                    ...(request.installId ? { installId: request.installId } : {}),
                });
                return this.works.createWork(dto, user);
            })
            .catch((error: unknown) => {
                throw coded(error, EVER_CONNECT_APPS_CODES.createRefused);
            });

        const work = (created as { work?: { id?: string; name?: string } } | null)?.work;
        if (!work?.id) {
            throw problem(
                HttpStatus.INTERNAL_SERVER_ERROR,
                'create_failed',
                'The App could not be created; try again.',
            );
        }
        const existed = (created as { alreadyExisted?: boolean }).alreadyExisted === true;
        this.logger.log(
            `ever_connect.apps.${existed ? 'existing' : 'created'} ${work.id} (client ${
                caller.delegation.clientId ?? 'unknown'
            })`,
        );
        return {
            status: existed ? HttpStatus.OK : HttpStatus.CREATED,
            body: {
                id: work.id,
                name: work.name ?? request.name,
                url: appUrl(organization, work.id),
            },
        };
    }

    /** The repository a Blueprint of the Apps catalog is for, or the refusal that says why not. */
    private async blueprintUpstream(blueprintId: string): Promise<string> {
        const entry = await this.catalog.get(blueprintId);
        if (!entry) {
            const { available } = await this.catalog.list({ limit: 1 });
            throw available
                ? problem(
                      HttpStatus.NOT_FOUND,
                      EVER_CONNECT_APPS_CODES.blueprintNotFound,
                      'This Blueprint is not in the Apps catalog of this installation.',
                  )
                : problem(
                      HttpStatus.SERVICE_UNAVAILABLE,
                      EVER_CONNECT_APPS_CODES.catalogUnavailable,
                      'The Apps catalog cannot be read right now. Try again in a minute.',
                  );
        }
        if (!entry.selectable || !entry.upstream) {
            throw problem(
                HttpStatus.UNPROCESSABLE_ENTITY,
                EVER_CONNECT_APPS_CODES.blueprintNotAvailable,
                'This Blueprint cannot be used to start an App yet.',
            );
        }
        return entry.upstream.url;
    }

    // ── Deploy ───────────────────────────────────────────────────────────────

    /**
     * Ask for a deployment of an App for the person. Answers the deploy
     * service's own status: 202 with the deployment's id, or its refusal.
     */
    async deploy(
        caller: DelegatedCaller,
        workId: unknown,
        body: unknown,
    ): Promise<{ status: number; body: EverConnectAppDeployRequested }> {
        const id = typeof workId === 'string' && UUID.test(workId) ? workId : null;
        if (!id) throw invalid('workId', 'The App id in the address is not one.');
        const request = readDeploy(body);
        const { link } = await this.resolveLink(caller, request.linkId);
        const userId = caller.auth.userId;

        const access = await this.ownership.ensureCanEdit(id, userId).catch((error: unknown) => {
            // One answer for a missing Work, one the person cannot see and another account's.
            if (error instanceof HttpException && [403, 404].includes(error.getStatus())) {
                throw notFound();
            }
            throw error;
        });
        // The link names the Organization the request acts in: an App of another one is not there.
        if ((access.work.organizationId ?? null) !== link.organizationId) throw notFound();
        if (access.work.kind !== 'app') {
            throw problem(
                HttpStatus.UNPROCESSABLE_ENTITY,
                EVER_CONNECT_APPS_CODES.notAnAppWork,
                'This Work is not an App, so it has nothing to deploy this way.',
            );
        }
        await this.refuseWhatNeedsTheOwnerSession(id, access.role);

        const result = await this.deployRequest.request({
            workId: id,
            // The person the token is for: who the deployment is recorded as asked by.
            userId,
            trigger: 'manual',
            // Never `requestedByHumanSession`, never `confirmClusterChange`: this caller is
            // not a person at a keyboard, and what needs one stays with the preconditions.
        });

        if (result.status === 'refused' || !result.deploymentId) {
            throw new HttpException(
                {
                    status: 'error',
                    code: result.code ?? EVER_CONNECT_APPS_CODES.deployRefused,
                    message:
                        result.unmet[0]?.message ??
                        'The deployment was refused; nothing was started.',
                    ...(result.runningDeploymentId
                        ? { running_deployment_id: result.runningDeploymentId }
                        : {}),
                    unmet: result.unmet.map((entry) => ({
                        code: String(entry?.code ?? ''),
                        message: String(entry?.message ?? ''),
                    })),
                },
                result.httpStatus >= 400 ? result.httpStatus : HttpStatus.CONFLICT,
            );
        }
        this.logger.log(
            `ever_connect.apps.deploy_${result.status} ${id} (client ${
                caller.delegation.clientId ?? 'unknown'
            })`,
        );
        return {
            status: result.httpStatus,
            body: { deployment_id: result.deploymentId, status: result.status },
        };
    }

    /**
     * A cluster credential that someone other than the Work owner saved is used
     * only after the owner deployed it once from their own session; that
     * deployment is the confirmation. A delegated caller is never that session,
     * so such a deployment is refused here and nothing is confirmed: a member
     * who is not the owner gets the owner gate's own answer, the owner is told
     * that their session is needed.
     */
    private async refuseWhatNeedsTheOwnerSession(workId: string, role: unknown): Promise<void> {
        if (!appTargetChangeRequiresOwner()) return;
        if (!this.targets?.clusterCredentialNeedsOwnerConfirmation) return;
        if (!(await this.targets.clusterCredentialNeedsOwnerConfirmation(workId))) return;
        throw role === 'owner'
            ? problem(
                  HttpStatus.FORBIDDEN,
                  EVER_CONNECT_APPS_CODES.sessionRequired,
                  'The Work owner deploys this App once in Ever Works first: its cluster credential was saved by another member.',
              )
            : problem(
                  HttpStatus.FORBIDDEN,
                  EVER_CONNECT_APPS_CODES.ownerRequired,
                  'Only the Work owner can confirm a cluster credential another member saved (deploy it once yourself).',
              );
    }

    // ── Shared ───────────────────────────────────────────────────────────────

    private assertAppWorksEnabled(): void {
        if (!agentConfig.everWorks.apps.worksEnabled()) {
            throw problem(
                HttpStatus.BAD_REQUEST,
                EVER_CONNECT_APPS_CODES.appWorksDisabled,
                'Creating App Works is turned off on this installation.',
            );
        }
    }

    /**
     * The active link the request names, and its Organization for the person:
     * the installation is connected, the link exists and is active, and the
     * person is a member of the Organization's account (what lets a signed-in
     * person create a Work in it).
     */
    private async resolveLink(
        caller: DelegatedCaller,
        linkId: string,
    ): Promise<{ link: EverConnectLink; organization: Organization }> {
        const connection = await this.connection.connection();
        if (connection.status !== 'active' || !connection.platformInstanceId) {
            throw problem(
                HttpStatus.CONFLICT,
                EVER_CONNECT_APPS_CODES.notConnected,
                'This installation is not connected to Ever Platform.',
            );
        }
        const links = await this.dataSource
            .getRepository(EverConnectLink)
            .find({ where: { platformLinkId: linkId } });
        const link = links.find((candidate) => candidate.status === 'active');
        if (!link) {
            throw links.length > 0
                ? problem(
                      HttpStatus.CONFLICT,
                      EVER_CONNECT_APPS_CODES.linkNotActive,
                      'This link was removed; link the Organization again first.',
                  )
                : problem(
                      HttpStatus.NOT_FOUND,
                      EVER_CONNECT_APPS_CODES.linkNotFound,
                      'This link is not known here.',
                  );
        }
        const organization = await this.membership
            .ensureMember(link.organizationId, caller.auth.userId)
            .catch((error: unknown) => {
                if (error instanceof HttpException && error.getStatus() === 404) {
                    throw problem(
                        HttpStatus.FORBIDDEN,
                        EVER_CONNECT_APPS_CODES.notAMember,
                        'This person is not a member of the Organization this link is for.',
                    );
                }
                throw error;
            });
        return { link, organization };
    }

    private async personOf(caller: DelegatedCaller): Promise<User> {
        const user = await this.users.findById(caller.auth.userId);
        if (!user) {
            throw problem(
                HttpStatus.FORBIDDEN,
                EVER_CONNECT_APPS_CODES.notAMember,
                'This person is not a member of the Organization this link is for.',
            );
        }
        return user;
    }
}

/** A create request, read and checked. */
interface CreateRequest {
    linkId: string;
    name: string;
    blueprintId: string | null;
    installId: string | null;
}

const CREATE_FIELDS = new Set(['link_id', 'name', 'blueprint_id', 'install_id']);
const DEPLOY_FIELDS = new Set(['link_id', 'environment']);

function objectOf(body: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw invalid('body', 'The request body is a JSON object.');
    }
    for (const field of Object.keys(body)) {
        if (!allowed.has(field)) throw invalid(field, `Unknown field: ${field.slice(0, 64)}.`);
    }
    return body as Record<string, unknown>;
}

function linkIdOf(fields: Record<string, unknown>): string {
    const linkId = fields.link_id;
    if (typeof linkId !== 'string' || !LINK_ID.test(linkId)) {
        throw invalid('link_id', 'link_id is the id of a link, as Ever Platform issued it.');
    }
    return linkId;
}

/** A value that may be left out: absent and `null` are the same. */
function optional(value: unknown): unknown {
    return value === undefined || value === null ? null : value;
}

/** An optional text field that matches `pattern`, or `null` when it is left out. */
function optionalText(
    fields: Record<string, unknown>,
    field: string,
    pattern: RegExp,
    message: string,
): string | null {
    const value = optional(fields[field]);
    if (value === null) return null;
    if (typeof value !== 'string' || !pattern.test(value)) throw invalid(field, message);
    return value;
}

function readCreate(body: unknown): CreateRequest {
    const fields = objectOf(body, CREATE_FIELDS);
    const linkId = linkIdOf(fields);
    // Plain text: no control character, trimmed.
    const name =
        typeof fields.name === 'string'
            ? // eslint-disable-next-line no-control-regex
              fields.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
            : '';
    if (!name || Array.from(name).length > NAME_MAX) {
        throw invalid('name', `name is 1 to ${NAME_MAX} characters.`);
    }
    return {
        linkId,
        name,
        blueprintId: optionalText(
            fields,
            'blueprint_id',
            BLUEPRINT_ID,
            'blueprint_id is the id of a Blueprint of the Apps catalog.',
        ),
        installId: optionalText(
            fields,
            'install_id',
            EVER_PLATFORM_INSTALL_ID_PATTERN,
            'install_id is the id of an install, as Ever Platform issued it.',
        ),
    };
}

function readDeploy(body: unknown): { linkId: string } {
    const fields = objectOf(body, DEPLOY_FIELDS);
    const linkId = linkIdOf(fields);
    const environment = optional(fields.environment);
    // An App has one deployment a person starts: its production one.
    if (environment !== null && environment !== 'production') {
        throw invalid('environment', 'environment, when given, is `production`.');
    }
    return { linkId };
}

/**
 * How the repository becomes the App's own, chosen as the create form chooses
 * it before a person changes anything: the mode the inspection names as the
 * default, in the first account the person can create a repository in. A
 * repository that offers no mode is refused with the reason the inspection
 * gives (`provider_not_connected`, `not_found`, `rate_limited`, …), under the
 * status the creation path gives that reason.
 */
function chooseRelation(preview: AppSourceInspectResponse): {
    mode: AppRepositoryMode;
    targetOwner: string | null;
} {
    const mode = preview.defaultMode;
    if (!mode || !preview.modes[mode]?.available) {
        const reason =
            preview.modes.fork?.reason ?? preview.modes.link?.reason ?? ('not_found' as const);
        throw problem(
            reason === 'in_use_by_another_account'
                ? HttpStatus.CONFLICT
                : reason === 'rate_limited'
                  ? HttpStatus.SERVICE_UNAVAILABLE
                  : HttpStatus.BAD_REQUEST,
            reason,
            'This repository cannot be made into an App for this person right now.',
            preview.retryAfter ? { details: { retryAfter: preview.retryAfter } } : undefined,
        );
    }
    if (mode === 'link') return { mode, targetOwner: null };
    const owner = preview.targetOwners.find((candidate) => candidate.available);
    if (!owner) {
        throw problem(
            HttpStatus.BAD_REQUEST,
            EVER_CONNECT_APPS_CODES.targetOwnerUnavailable,
            'The connected GitHub account cannot create a repository in any of its accounts.',
        );
    }
    return { mode, targetOwner: owner.login };
}

/** The Work's description: what the repository says of itself, else the name. */
function descriptionOf(name: string, preview: AppSourceInspectResponse): string {
    const text =
        (preview.repository.description ?? '').trim() || preview.repository.fullName || name;
    return Array.from(text).slice(0, DESCRIPTION_MAX).join('');
}

/** The App's page in Ever Works, in its Organization. */
function appUrl(organization: Pick<Organization, 'slug'>, workId: string): string {
    const base = config.webAppUrl().replace(/\/+$/, '');
    return `${base}/org/${encodeURIComponent(organization.slug)}/works/${encodeURIComponent(workId)}`;
}

function notFound(): HttpException {
    return problem(
        HttpStatus.NOT_FOUND,
        EVER_CONNECT_APPS_CODES.notFound,
        'This App is not found.',
    );
}

/**
 * A refusal of the path underneath, with a code: its own when it has one (the
 * creation path's `{ status: 'error', code, message, details? }`), otherwise
 * `fallback` under the same status and message. Anything that is not a refusal
 * (a fault) is passed on untouched.
 */
function coded(error: unknown, fallback: string): unknown {
    if (!(error instanceof HttpException) || error.getStatus() >= 500) return error;
    const response = error.getResponse();
    const body = (response && typeof response === 'object' ? response : {}) as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
    };
    if (typeof body.code === 'string' && body.code) return error;
    const message = Array.isArray(body.message)
        ? body.message.map(String).join('; ')
        : typeof body.message === 'string'
          ? body.message
          : error.message;
    return problem(error.getStatus(), fallback, message);
}
