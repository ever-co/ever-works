// `@ever-works/agent/services` and the App runtime barrels pull packages jest
// cannot parse; this suite needs them as injection tokens only (every
// collaborator below is a double with the real one's contract).
jest.mock('@ever-works/agent/services', () => ({
    WorkLifecycleService: class WorkLifecycleService {},
    WorkOwnershipService: class WorkOwnershipService {},
    WorkQueryService: class WorkQueryService {},
}));
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppDeployRequestService: class AppDeployRequestService {},
    AppTargetService: class AppTargetService {},
    APPS_TIER_POLICY: Symbol('APPS_TIER_POLICY'),
}));
jest.mock('@ever-works/agent/app-works', () => ({
    AppSourceInspectorService: class AppSourceInspectorService {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class GitFacadeService {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));

import { randomUUID } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { OrganizationRepository, UserRepository } from '@ever-works/agent/database';
import {
    ActivityActionType,
    ActivityStatus,
    EverConnectConnection,
    EverConnectLink,
    IntegrationIdempotencyKey,
} from '@ever-works/agent/entities';
import { IntegrationIdempotencyService } from '@ever-works/agent/integrations-api';
import { OrganizationMembershipService } from '../../../organizations/organization-membership.service';
import { ScopeContextService } from '../../../scope/scope-context.service';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import {
    EVER_CONNECT_APPS_CODES,
    EverConnectAppsService,
    type DelegatedCaller,
} from '../ever-connect-apps.service';

/**
 * What another Ever app may do here for a person: create an App in a linked
 * Organization and start a deployment of one. The links and the
 * `Idempotency-Key` store are on a real database; the Work, App and deploy
 * services are doubles that answer as the real ones do, so what is pinned here
 * is what this service decides: who may ask, what it passes on, what it
 * answers, and every refusal's code.
 */
const LINK = '01JZ8Q3M4N5P6R7S8T9V0W1XA1';
/** An active link of another account's Organization. */
const OTHER_LINK = '01JZ8Q3M4N5P6R7S8T9V0W1XB2';
/** A removed link of another account's Organization. */
const ARCHIVED_LINK = '01JZ8Q3M4N5P6R7S8T9V0W1XC3';
/** A removed link of an Organization of the person's own account. */
const FORMER_LINK = '01JZ8Q3M4N5P6R7S8T9V0W1XD4';
/** A link id nothing here has. */
const UNKNOWN_LINK = '01JZ8Q3M4N5P6R7S8T9V0W1XZ9';
const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const WEB = 'https://works.example.test';

const tenant = randomUUID();
const organization = { id: randomUUID(), tenantId: tenant, slug: 'acme' };
/** Another Organization of the same account, whose link was removed. */
const formerOrganization = { id: randomUUID(), tenantId: tenant, slug: 'acme-labs' };
const otherOrganization = { id: randomUUID(), tenantId: randomUUID(), slug: 'globex' };
const goneOrganization = { id: randomUUID(), tenantId: randomUUID(), slug: 'gone' };
const PERSON = randomUUID();
const OUTSIDER = randomUUID();

const callerOf = (userId: string): DelegatedCaller => ({
    auth: { userId, authMethod: 'ever-id-delegated' } as DelegatedCaller['auth'],
    delegation: { identityId: randomUUID(), clientId: 'app-ever-co', scopes: ['apps:write'] },
});
const person = callerOf(PERSON);

/** The refusal a call ends in: its status and the body the calling app reads. */
async function refusalOf(call: Promise<unknown>) {
    try {
        await call;
    } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const body = error.getResponse() as Record<string, unknown>;
        // The HTTP status, in place of the body's own `status: 'error'`.
        return { ...body, status: error.getStatus() };
    }
    throw new Error('expected a refusal');
}

/** What the inspection of a Blueprint's repository answers for a connected person. */
const preview = (overrides: Record<string, unknown> = {}) => ({
    repository: {
        owner: 'calcom',
        repo: 'cal.diy',
        fullName: 'calcom/cal.diy',
        url: 'https://github.com/calcom/cal.diy',
        description: 'Scheduling for everyone',
        defaultBranch: 'main',
    },
    modes: {
        link: { available: false, reason: 'no_push_access' },
        fork: { available: true },
        'private-copy': { available: true },
    },
    defaultMode: 'fork',
    targetOwners: [
        { login: 'someone-else', type: 'organization', available: false },
        { login: 'acme-member', type: 'user', available: true },
    ],
    ...overrides,
});

describe('EverConnectAppsService', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let scope: ScopeContextService;
    let apps: EverConnectAppsService;
    let connection: { connection: jest.Mock };
    let membership: { ensureMember: jest.Mock };
    let users: { findById: jest.Mock };
    let catalog: { get: jest.Mock; list: jest.Mock };
    let inspector: { inspect: jest.Mock };
    let works: { createWork: jest.Mock };
    let workQuery: { checkSlugAvailability: jest.Mock };
    let ownership: { ensureCanEdit: jest.Mock };
    let deployRequest: { request: jest.Mock };
    let targets: {
        clusterCredentialNeedsOwnerConfirmation: jest.Mock;
        confirmClusterCredential: jest.Mock;
    };
    let activity: { log: jest.Mock };
    /** The service over the doubles above, with `membership` as given. */
    let appsWith: (membershipService: unknown, activityService?: unknown) => EverConnectAppsService;

    const body = (overrides: Record<string, unknown> = {}) => ({
        link_id: LINK,
        name: 'Booking',
        blueprint_id: 'cal-diy',
        ...overrides,
    });
    const keys = () => dataSource.getRepository(IntegrationIdempotencyKey).find();

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        process.env.WEB_URL = `${WEB}/`;
        delete process.env.APP_TARGET_CHANGE_REQUIRES_OWNER;
        for (const entity of [IntegrationIdempotencyKey, EverConnectLink, EverConnectConnection]) {
            await dataSource.getRepository(entity).clear();
        }
        const link = (
            platformLinkId: string,
            of: typeof organization,
            status: 'active' | 'archived',
            everOrgId: string,
        ) => ({
            organizationId: of.id,
            tenantId: of.tenantId,
            everOrgId,
            handle: of.slug,
            platformLinkId,
            productOrgRef: of.slug,
            createdVia: 'link_code' as const,
            status,
        });
        await dataSource
            .getRepository(EverConnectLink)
            .insert([
                link(LINK, organization, 'active', '01JMQCK0RG000000000000000A'),
                link(OTHER_LINK, otherOrganization, 'active', '01JMQCK0RG000000000000000B'),
                link(ARCHIVED_LINK, goneOrganization, 'archived', '01JMQCK0RG000000000000000C'),
                link(FORMER_LINK, formerOrganization, 'archived', '01JMQCK0RG000000000000000D'),
            ]);

        connection = {
            connection: jest.fn(async () => ({
                status: 'active',
                platformInstanceId: '01JZ8Q3M4N5P6R7S8T9V0W1X2Y',
            })),
        };
        // The real service's contract: a member of the Organization's account gets it; anyone
        // else, and a missing Organization, is the same 404.
        membership = {
            ensureMember: jest.fn(async (orgId: string, userId: string) => {
                const own = [organization, formerOrganization].find(({ id }) => id === orgId);
                if (own && userId === PERSON) return own;
                throw new NotFoundException(`Organization ${orgId} not found`);
            }),
        };
        users = {
            findById: jest.fn(async (id: string) => ({
                id,
                username: 'acme-member',
                tenantId: tenant,
            })),
        };
        catalog = {
            get: jest.fn(async (id: string) =>
                id === 'cal-diy'
                    ? {
                          id,
                          selectable: true,
                          upstream: {
                              repo: 'calcom/cal.diy',
                              url: 'https://github.com/calcom/cal.diy',
                          },
                      }
                    : null,
            ),
            list: jest.fn(async () => ({ available: true, items: [] })),
        };
        inspector = { inspect: jest.fn(async () => preview()) };
        works = {
            createWork: jest.fn(async (dto: { name: string }) => ({
                status: 'success',
                work: { id: randomUUID(), name: dto.name },
            })),
        };
        workQuery = {
            checkSlugAvailability: jest.fn(async (name: string) => ({
                available: true,
                slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            })),
        };
        ownership = { ensureCanEdit: jest.fn() };
        deployRequest = { request: jest.fn() };
        targets = {
            clusterCredentialNeedsOwnerConfirmation: jest.fn(async () => false),
            confirmClusterCredential: jest.fn(),
        };
        activity = { log: jest.fn(async () => ({ id: randomUUID() })) };
        scope = new ScopeContextService();
        appsWith = (membershipService, activityService = activity) =>
            new EverConnectAppsService(
                dataSource,
                connection as never,
                membershipService as never,
                users as never,
                scope,
                catalog as never,
                inspector as never,
                works as never,
                workQuery as never,
                ownership as never,
                deployRequest as never,
                new IntegrationIdempotencyService(dataSource),
                targets as never,
                activityService as never,
            );
        apps = appsWith(membership);
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    describe('creating an App', () => {
        it('creates it through the path a signed-in person uses, in the Organization the link is for', async () => {
            let scopeAtCreate: unknown;
            works.createWork.mockImplementationOnce(async (dto: { name: string }) => {
                scopeAtCreate = scope.getScope();
                return { status: 'success', work: { id: 'work-1', name: dto.name } };
            });

            const answer = await apps.create(person, 'key-1', body({ install_id: INSTALL }));

            expect(answer).toEqual({
                status: 201,
                replayed: false,
                body: { id: 'work-1', name: 'Booking', url: `${WEB}/org/acme/works/work-1` },
            });
            // The repository of the Blueprint, as the catalog of this installation names it.
            expect(catalog.get).toHaveBeenCalledWith('cal-diy');
            expect(inspector.inspect).toHaveBeenCalledWith(
                'https://github.com/calcom/cal.diy',
                expect.objectContaining({ id: PERSON }),
                { blueprintId: 'cal-diy' },
            );
            expect(works.createWork).toHaveBeenCalledTimes(1);
            const [dto, user, options] = works.createWork.mock.calls[0];
            // An App, from the Blueprint, as the create form sends it before a person changes
            // anything: the default mode, in the first account they can create a repository in.
            // Nothing is started on its own, and the install is not a field of the request.
            expect({ ...dto }).toEqual({
                slug: 'booking',
                name: 'Booking',
                description: 'Scheduling for everyone',
                organization: false,
                gitProvider: 'github',
                kind: 'app',
                repositoryUrl: 'https://github.com/calcom/cal.diy',
                repositoryMode: 'fork',
                targetOwner: 'acme-member',
                blueprintId: 'cal-diy',
                autoProvision: false,
            });
            // The install this route vouches for, beside the request: the create path
            // keeps it only with the Blueprint it settles.
            expect(options).toEqual({ marketplaceInstallId: INSTALL });
            // As the person, not as the app that asked.
            expect(user).toMatchObject({ id: PERSON });
            // In the Organization's scope: where the Work is created.
            expect(scopeAtCreate).toEqual({ tenantId: tenant, organizationId: organization.id });
            // And nowhere after the call.
            expect(scope.getScope()).toEqual({ tenantId: null, organizationId: null });
        });

        it('sends no install and no account when there is none to send', async () => {
            inspector.inspect.mockResolvedValueOnce(
                preview({
                    modes: { link: { available: true }, fork: { available: true } },
                    defaultMode: 'link',
                }),
            );
            await apps.create(person, 'key-1', body());
            const call = works.createWork.mock.calls[0];
            const [dto] = call;
            expect(dto).toMatchObject({ repositoryMode: 'link', blueprintId: 'cal-diy' });
            expect(dto).not.toHaveProperty('targetOwner');
            expect(dto).not.toHaveProperty('installId');
            expect(dto).not.toHaveProperty('everOrg');
            // Called as a create without an install is: the request and the person, nothing else.
            expect(call).toHaveLength(2);
            // Never a deploy target, a switch or a value the person did not choose.
            expect(dto).not.toHaveProperty('deployProvider');
            expect(dto).not.toHaveProperty('appEnv');
        });

        describe('nothing starts on its own', () => {
            it.each([
                ['left out', {}],
                ['null', { auto_provision: null }],
                ['false', { auto_provision: false }],
            ])('auto_provision %s: the App is created and nothing is started', async (_n, sent) => {
                await apps.create(person, 'key-1', body(sent));
                // Said to the creation path in so many words: its own default is on.
                expect(works.createWork.mock.calls[0][0].autoProvision).toBe(false);
            });

            it('auto_provision true: the creation path starts what it starts for a signed-in person', async () => {
                await apps.create(person, 'key-1', body({ auto_provision: true }));
                // Left to the creation path's own default (on), and to its own switch.
                expect(works.createWork.mock.calls[0][0]).not.toHaveProperty('autoProvision');
            });
        });

        it('takes the free address when the name is taken, and the name as the description when the repository has none', async () => {
            workQuery.checkSlugAvailability.mockResolvedValueOnce({
                available: false,
                slug: 'booking',
                suggestion: 'booking-2',
            });
            inspector.inspect.mockResolvedValueOnce(
                preview({
                    repository: {
                        owner: 'calcom',
                        repo: 'cal.diy',
                        fullName: '',
                        url: 'https://github.com/calcom/cal.diy',
                    },
                }),
            );
            await apps.create(person, 'key-1', body());
            expect(works.createWork.mock.calls[0][0]).toMatchObject({
                slug: 'booking-2',
                description: 'Booking',
            });
        });

        it('answers 200 for an identical App the person already has', async () => {
            works.createWork.mockResolvedValueOnce({
                status: 'success',
                work: { id: 'work-1', name: 'Booking' },
                alreadyExisted: true,
            });
            expect(await apps.create(person, 'key-1', body())).toMatchObject({
                status: 200,
                body: { id: 'work-1' },
            });
        });

        describe('who may ask', () => {
            it('refuses a link that is not known: 404 link_not_found', async () => {
                expect(
                    await refusalOf(apps.create(person, 'key-1', body({ link_id: UNKNOWN_LINK }))),
                ).toMatchObject({ status: 404, code: 'link_not_found' });
                expect(membership.ensureMember).not.toHaveBeenCalled();
                expect(works.createWork).not.toHaveBeenCalled();
            });

            it('a link is not confirmed to anyone outside it: the answer of a link that is not known, word for word', async () => {
                const unknown = await refusalOf(
                    apps.create(person, 'key-0', body({ link_id: UNKNOWN_LINK })),
                );
                expect(unknown).toMatchObject({ status: 404, code: 'link_not_found' });

                for (const [caller, linkId] of [
                    // A person of another account, naming a link that exists and is active.
                    [callerOf(OUTSIDER), LINK],
                    // The person, naming another account's active link.
                    [person, OTHER_LINK],
                    // The person, naming another account's removed link: not "removed" either.
                    [person, ARCHIVED_LINK],
                    [callerOf(OUTSIDER), FORMER_LINK],
                ] as const) {
                    expect(
                        await refusalOf(apps.create(caller, 'key-1', body({ link_id: linkId }))),
                    ).toEqual(unknown);
                }
                expect(membership.ensureMember).toHaveBeenCalledWith(otherOrganization.id, PERSON);
                expect(membership.ensureMember).toHaveBeenCalledWith(goneOrganization.id, PERSON);
                // No code of this route says "that link exists, and it is not yours".
                expect(Object.values(EVER_CONNECT_APPS_CODES)).not.toContain('not_a_member');
                expect(works.createWork).not.toHaveBeenCalled();
                expect(inspector.inspect).not.toHaveBeenCalled();
                expect(activity.log).not.toHaveBeenCalled();
                expect(await keys()).toEqual([]);
            });

            it('tells a member that their link was removed: 409 link_not_active', async () => {
                expect(
                    await refusalOf(apps.create(person, 'key-1', body({ link_id: FORMER_LINK }))),
                ).toMatchObject({ status: 409, code: 'link_not_active' });
                expect(membership.ensureMember).toHaveBeenCalledWith(formerOrganization.id, PERSON);
                expect(works.createWork).not.toHaveBeenCalled();
            });

            it('a person whose account is gone is told what a stranger is told', async () => {
                users.findById.mockResolvedValueOnce(null);
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 404,
                    code: 'link_not_found',
                });
                expect(works.createWork).not.toHaveBeenCalled();
            });

            it('a fault of the membership check is a fault, not "not found"', async () => {
                membership.ensureMember.mockRejectedValueOnce(new Error('database is down'));
                await expect(apps.create(person, 'key-1', body())).rejects.toThrow(
                    'database is down',
                );
            });

            it.each([
                ['disconnected', { status: 'disconnected', platformInstanceId: null }],
                ['revoked', { status: 'revoked', platformInstanceId: 'x' }],
                ['waiting for approval', { status: 'pending_approval', platformInstanceId: null }],
            ])('refuses while the installation is %s: 409 not_connected', async (_name, row) => {
                connection.connection.mockResolvedValueOnce(row);
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 409,
                    code: 'not_connected',
                });
                expect(works.createWork).not.toHaveBeenCalled();
            });
        });

        describe('what every create is checked against', () => {
            it('refuses on an installation that does not make Apps: 400 app_works_disabled, before anything is read', async () => {
                for (const value of [undefined, 'false', '1', 'TRUE']) {
                    if (value === undefined) delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
                    else process.env.EVER_WORKS_APP_WORKS_ENABLED = value;
                    expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                        status: 400,
                        code: 'app_works_disabled',
                    });
                }
                expect(connection.connection).not.toHaveBeenCalled();
                expect(catalog.get).not.toHaveBeenCalled();
                expect(works.createWork).not.toHaveBeenCalled();
            });

            it('refuses a person whose Git account is not connected: provider_not_connected, nothing created', async () => {
                inspector.inspect.mockResolvedValueOnce(
                    preview({
                        modes: {
                            link: { available: false, reason: 'provider_not_connected' },
                            fork: { available: false, reason: 'provider_not_connected' },
                            'private-copy': { available: false, reason: 'provider_not_connected' },
                        },
                        defaultMode: null,
                        targetOwners: [],
                    }),
                );
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 400,
                    code: 'provider_not_connected',
                });
                expect(works.createWork).not.toHaveBeenCalled();

                // Also when the inspection itself refuses with it.
                inspector.inspect.mockRejectedValueOnce(
                    new ServiceUnavailableException({
                        status: 'error',
                        code: 'provider_not_connected',
                        message: 'No Git provider is available in this installation.',
                    }),
                );
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 503,
                    code: 'provider_not_connected',
                });
                expect(works.createWork).not.toHaveBeenCalled();
            });

            it.each([
                ['rate_limited', 503],
                ['in_use_by_another_account', 409],
                ['not_found', 400],
                ['archived', 400],
            ])(
                'a repository that offers no mode is refused with its reason: %s',
                async (reason, status) => {
                    inspector.inspect.mockResolvedValueOnce(
                        preview({
                            modes: {
                                link: { available: false, reason },
                                fork: { available: false, reason },
                            },
                            defaultMode: null,
                        }),
                    );
                    expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                        status,
                        code: reason,
                    });
                    expect(works.createWork).not.toHaveBeenCalled();
                },
            );

            it('refuses when the person can create a repository in none of their accounts: target_owner_unavailable', async () => {
                inspector.inspect.mockResolvedValueOnce(
                    preview({ targetOwners: [{ login: 'x', type: 'user', available: false }] }),
                );
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 400,
                    code: 'target_owner_unavailable',
                });
                expect(works.createWork).not.toHaveBeenCalled();
            });

            it('passes on a refusal of the creation path with its own status, code and details', async () => {
                works.createWork.mockRejectedValueOnce(
                    new ConflictException({
                        status: 'error',
                        code: 'app_work_exists',
                        message: 'This repository is already one of your App Works.',
                        details: { workId: 'work-0', workName: 'Booking' },
                    }),
                );
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toEqual({
                    status: 409,
                    code: 'app_work_exists',
                    message: 'This repository is already one of your App Works.',
                    details: { workId: 'work-0', workName: 'Booking' },
                });

                works.createWork.mockRejectedValueOnce(
                    new BadRequestException({
                        status: 'error',
                        code: 'blueprint_mismatch',
                        message: 'That Blueprint is not the one for this repository.',
                    }),
                );
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 400,
                    code: 'blueprint_mismatch',
                });
            });

            it('gives a refusal without a code one, under the same status: create_refused', async () => {
                works.createWork.mockRejectedValueOnce(
                    new BadRequestException('targetOwner must be defined'),
                );
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toEqual({
                    status: 400,
                    code: 'create_refused',
                    message: 'targetOwner must be defined',
                });
                works.createWork.mockRejectedValueOnce(new ForbiddenException());
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 403,
                    code: 'create_refused',
                });
            });

            it('does not dress up a fault as a refusal', async () => {
                const fault = new Error('database is gone');
                works.createWork.mockRejectedValueOnce(fault);
                await expect(apps.create(person, 'key-1', body())).rejects.toBe(fault);
            });
        });

        describe('the Blueprint', () => {
            it('is required: 422 blueprint_required', async () => {
                for (const blueprint of [undefined, null]) {
                    expect(
                        await refusalOf(
                            apps.create(person, 'key-1', body({ blueprint_id: blueprint })),
                        ),
                    ).toMatchObject({ status: 422, code: 'blueprint_required' });
                }
                expect(connection.connection).not.toHaveBeenCalled();
                expect(works.createWork).not.toHaveBeenCalled();
            });

            it('one the catalog does not have: 404 blueprint_not_found', async () => {
                expect(
                    await refusalOf(apps.create(person, 'key-1', body({ blueprint_id: 'umami' }))),
                ).toMatchObject({ status: 404, code: 'blueprint_not_found' });
                expect(inspector.inspect).not.toHaveBeenCalled();
            });

            it('a catalog that cannot be read: 503 catalog_unavailable (never "not found")', async () => {
                catalog.list.mockResolvedValueOnce({ available: false, items: [] });
                expect(
                    await refusalOf(apps.create(person, 'key-1', body({ blueprint_id: 'umami' }))),
                ).toMatchObject({ status: 503, code: 'catalog_unavailable' });
            });

            it.each([
                ['a placeholder', { id: 'soon', selectable: false, upstream: null }],
                ['an entry without a repository', { id: 'soon', selectable: true, upstream: null }],
            ])('%s cannot start an App: 422 blueprint_not_available', async (_name, entry) => {
                catalog.get.mockResolvedValueOnce(entry);
                expect(
                    await refusalOf(apps.create(person, 'key-1', body({ blueprint_id: 'soon' }))),
                ).toMatchObject({ status: 422, code: 'blueprint_not_available' });
                expect(inspector.inspect).not.toHaveBeenCalled();
            });
        });

        describe('what is asked', () => {
            it.each([
                ['no Idempotency-Key', undefined, body(), 'Idempotency-Key'],
                ['an empty Idempotency-Key', '   ', body(), 'Idempotency-Key'],
                ['an Idempotency-Key that is too long', 'k'.repeat(129), body(), 'Idempotency-Key'],
                ['an Idempotency-Key that is not text', 42, body(), 'Idempotency-Key'],
                ['no body', 'key-1', undefined, 'body'],
                ['a list', 'key-1', [body()], 'body'],
                ['text', 'key-1', 'link_id=x', 'body'],
                ['no link', 'key-1', body({ link_id: undefined }), 'link_id'],
                [
                    'a link id that is not one',
                    'key-1',
                    body({ link_id: organization.id }),
                    'link_id',
                ],
                ['a lower-case link id', 'key-1', body({ link_id: LINK.toLowerCase() }), 'link_id'],
                ['no name', 'key-1', body({ name: undefined }), 'name'],
                ['a blank name', 'key-1', body({ name: ' \n\t ' }), 'name'],
                ['a name that is too long', 'key-1', body({ name: 'n'.repeat(101) }), 'name'],
                ['a name that is not text', 'key-1', body({ name: { text: 'x' } }), 'name'],
                [
                    'a Blueprint id that is not one',
                    'key-1',
                    body({ blueprint_id: 'Cal DIY' }),
                    'blueprint_id',
                ],
                [
                    'a Blueprint that is an address',
                    'key-1',
                    body({ blueprint_id: 'https://x.test/a' }),
                    'blueprint_id',
                ],
                [
                    'an install id that is not one',
                    'key-1',
                    body({ install_id: 'install-1' }),
                    'install_id',
                ],
                ['an install id that is not text', 'key-1', body({ install_id: 7 }), 'install_id'],
                [
                    'an auto_provision that is text',
                    'key-1',
                    body({ auto_provision: 'true' }),
                    'auto_provision',
                ],
                [
                    'an auto_provision that is a number',
                    'key-1',
                    body({ auto_provision: 1 }),
                    'auto_provision',
                ],
                [
                    "a repository of the caller's choosing",
                    'key-1',
                    body({ repository_url: 'https://github.com/x/y' }),
                    'repository_url',
                ],
                [
                    "an Organization of the caller's choosing",
                    'key-1',
                    body({ organization_id: organization.id }),
                    'organization_id',
                ],
                [
                    "a person of the caller's choosing",
                    'key-1',
                    body({ user_id: OUTSIDER }),
                    'user_id',
                ],
            ])('refuses %s: 400 validation, naming the field', async (_name, key, sent, field) => {
                expect(await refusalOf(apps.create(person, key, sent))).toMatchObject({
                    status: 400,
                    code: 'validation',
                    details: { field },
                });
                expect(connection.connection).not.toHaveBeenCalled();
                expect(works.createWork).not.toHaveBeenCalled();
                expect(await keys()).toEqual([]);
            });

            it('reads a name as plain text, and the longest name a Work takes', async () => {
                await apps.create(person, 'key-1', body({ name: `  Book\u0000ing\n ` }));
                expect(works.createWork.mock.calls[0][0].name).toBe('Book ing');
                await apps.create(person, 'key-2', body({ name: 'n'.repeat(100) }));
                expect(works.createWork.mock.calls[1][0].name).toHaveLength(100);
            });
        });

        describe('repeat-safe under its Idempotency-Key', () => {
            it('the same key and body answer the App made before, and create nothing', async () => {
                const first = await apps.create(person, 'key-1', body({ install_id: INSTALL }));
                const again = await apps.create(person, 'key-1', body({ install_id: INSTALL }));
                expect(first.replayed).toBe(false);
                expect(again).toEqual({ status: 201, body: first.body, replayed: true });
                expect(works.createWork).toHaveBeenCalledTimes(1);
                expect(inspector.inspect).toHaveBeenCalledTimes(1);
                // Whoever asks again is still checked: the link and the membership.
                expect(membership.ensureMember).toHaveBeenCalledTimes(2);
            });

            it('the order of the fields, and a field left out or null, do not make another request', async () => {
                await apps.create(person, 'key-1', {
                    name: 'Booking',
                    blueprint_id: 'cal-diy',
                    link_id: LINK,
                });
                const again = await apps.create(person, 'key-1', {
                    link_id: LINK,
                    install_id: null,
                    // Left out, null and false are one request: nothing is started.
                    auto_provision: false,
                    blueprint_id: 'cal-diy',
                    name: ' Booking ',
                });
                expect(again.replayed).toBe(true);
                expect(works.createWork).toHaveBeenCalledTimes(1);
            });

            it.each([
                ['another name', { name: 'Calendar' }],
                ['another Blueprint', { blueprint_id: 'umami' }],
                ['another install', { install_id: INSTALL }],
                ['auto_provision turned on', { auto_provision: true }],
            ])(
                'the same key with %s is refused: 409, and nothing is created',
                async (_name, change) => {
                    await apps.create(person, 'key-1', body());
                    expect(
                        await refusalOf(apps.create(person, 'key-1', body(change))),
                    ).toMatchObject({
                        status: 409,
                        code: 'idempotency_key_reused_with_different_body',
                    });
                    expect(works.createWork).toHaveBeenCalledTimes(1);
                },
            );

            it('a request that is still running is not run twice: 409 request_in_progress', async () => {
                let release: (value: unknown) => void = () => undefined;
                works.createWork.mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            release = resolve;
                        }),
                );
                const first = apps.create(person, 'key-1', body());
                // Until the first one reaches the creation path.
                while (works.createWork.mock.calls.length === 0) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    status: 409,
                    code: 'request_in_progress',
                });
                release({ status: 'success', work: { id: 'work-1', name: 'Booking' } });
                expect((await first).body.id).toBe('work-1');
                expect(works.createWork).toHaveBeenCalledTimes(1);
            });

            it('a refused request keeps nothing: the same key can be sent again once the cause is gone', async () => {
                works.createWork.mockRejectedValueOnce(
                    new BadRequestException({
                        status: 'error',
                        code: 'provider_not_connected',
                        message: 'x',
                    }),
                );
                expect(await refusalOf(apps.create(person, 'key-1', body()))).toMatchObject({
                    code: 'provider_not_connected',
                });
                expect(await keys()).toEqual([]);
                expect(await apps.create(person, 'key-1', body())).toMatchObject({
                    status: 201,
                    replayed: false,
                });
            });

            it("a key is one person's: the same key of another person is another request", async () => {
                const other = randomUUID();
                membership.ensureMember.mockImplementation(async () => organization);
                const first = await apps.create(person, 'key-1', body());
                const second = await apps.create(callerOf(other), 'key-1', body());
                expect(second.replayed).toBe(false);
                expect(second.body.id).not.toBe(first.body.id);
                expect(works.createWork).toHaveBeenCalledTimes(2);
            });
        });
    });

    describe('starting a deployment', () => {
        const WORK = randomUUID();
        const accepted = (overrides: Record<string, unknown> = {}) => ({
            status: 'accepted',
            httpStatus: 202,
            code: null,
            deploymentId: 'deployment-1',
            queuedDeploymentId: null,
            runningDeploymentId: null,
            unmet: [],
            advisory: [],
            warnings: [],
            dispatched: true,
            deduplicated: false,
            ...overrides,
        });
        const access = (overrides: Record<string, unknown> = {}, role = 'owner') => ({
            work: { id: WORK, kind: 'app', organizationId: organization.id, ...overrides },
            member: null,
            role,
            isCreator: role === 'owner',
        });

        beforeEach(() => {
            ownership.ensureCanEdit.mockResolvedValue(access());
            deployRequest.request.mockResolvedValue(accepted());
        });

        it('asks the deploy service of the session route, for the person, and answers its 202', async () => {
            const answer = await apps.deploy(person, WORK, { link_id: LINK });

            expect(answer).toEqual({
                status: 202,
                body: { deployment_id: 'deployment-1', status: 'accepted' },
            });
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith(WORK, PERSON);
            // Exactly this: who asked and that a person's app asked. Never the marks of an
            // interactive session, and never a confirmation of a change of cluster.
            expect(deployRequest.request).toHaveBeenCalledTimes(1);
            expect(deployRequest.request).toHaveBeenCalledWith({
                workId: WORK,
                userId: PERSON,
                trigger: 'manual',
            });
        });

        it('answers a deployment that waits behind a running one', async () => {
            deployRequest.request.mockResolvedValueOnce(
                accepted({ status: 'queued', deploymentId: 'deployment-2', dispatched: false }),
            );
            expect(
                await apps.deploy(person, WORK, { link_id: LINK, environment: 'production' }),
            ).toEqual({ status: 202, body: { deployment_id: 'deployment-2', status: 'queued' } });
        });

        it.each([
            [
                'unmet preconditions',
                {
                    httpStatus: 422,
                    code: 'APP_DEPLOY_PRECONDITIONS',
                    unmet: [
                        { code: 'no_target', message: 'Choose where this App runs first.' },
                        { code: 'spec_invalid', message: 'The App spec is not valid.' },
                    ],
                },
                {
                    status: 422,
                    code: 'APP_DEPLOY_PRECONDITIONS',
                    message: 'Choose where this App runs first.',
                    unmet: [
                        { code: 'no_target', message: 'Choose where this App runs first.' },
                        { code: 'spec_invalid', message: 'The App spec is not valid.' },
                    ],
                },
            ],
            [
                'a deployment that is running',
                {
                    httpStatus: 409,
                    code: 'APP_DEPLOY_IN_PROGRESS',
                    runningDeploymentId: 'deployment-0',
                },
                {
                    status: 409,
                    code: 'APP_DEPLOY_IN_PROGRESS',
                    running_deployment_id: 'deployment-0',
                },
            ],
            [
                'no isolated worker',
                {
                    httpStatus: 422,
                    code: 'worker_not_isolated',
                    unmet: [
                        {
                            code: 'worker_not_isolated',
                            message: 'No isolated worker is available.',
                        },
                    ],
                },
                { status: 422, code: 'worker_not_isolated' },
            ],
            [
                'a credential that waits for its owner (the precondition of every trigger)',
                {
                    httpStatus: 422,
                    code: 'APP_DEPLOY_PRECONDITIONS',
                    unmet: [
                        {
                            code: 'cluster_credential_unconfirmed',
                            message: 'The owner deploys it once.',
                        },
                    ],
                },
                {
                    status: 422,
                    code: 'APP_DEPLOY_PRECONDITIONS',
                    unmet: [
                        {
                            code: 'cluster_credential_unconfirmed',
                            message: 'The owner deploys it once.',
                        },
                    ],
                },
            ],
        ])(
            'passes on a refusal of the deploy service with its code: %s',
            async (_name, result, told) => {
                deployRequest.request.mockResolvedValueOnce(
                    accepted({
                        status: 'refused',
                        deploymentId: null,
                        dispatched: false,
                        ...result,
                    }),
                );
                expect(await refusalOf(apps.deploy(person, WORK, { link_id: LINK }))).toMatchObject(
                    told,
                );
            },
        );

        describe('what needs the Work owner at their own keyboard stays refused', () => {
            beforeEach(() => {
                targets.clusterCredentialNeedsOwnerConfirmation.mockResolvedValue(true);
            });

            it('the owner is told that their session is needed: 403 session_required', async () => {
                expect(await refusalOf(apps.deploy(person, WORK, { link_id: LINK }))).toMatchObject(
                    {
                        status: 403,
                        code: 'session_required',
                    },
                );
            });

            it("a member who is not the owner gets the owner gate's own answer: 403 ownerRequired", async () => {
                ownership.ensureCanEdit.mockResolvedValueOnce(access({}, 'editor'));
                expect(await refusalOf(apps.deploy(person, WORK, { link_id: LINK }))).toMatchObject(
                    {
                        status: 403,
                        code: 'ownerRequired',
                    },
                );
            });

            afterEach(() => {
                // Nothing is confirmed for anyone, and nothing is asked of the deploy service.
                expect(targets.clusterCredentialNeedsOwnerConfirmation).toHaveBeenCalledWith(WORK);
                expect(targets.confirmClusterCredential).not.toHaveBeenCalled();
                expect(deployRequest.request).not.toHaveBeenCalled();
            });
        });

        it('with the owner gate switched off here, the deploy service still decides (and nothing is confirmed)', async () => {
            process.env.APP_TARGET_CHANGE_REQUIRES_OWNER = 'false';
            targets.clusterCredentialNeedsOwnerConfirmation.mockResolvedValue(true);
            await apps.deploy(person, WORK, { link_id: LINK });
            expect(targets.confirmClusterCredential).not.toHaveBeenCalled();
            expect(deployRequest.request).toHaveBeenCalledWith({
                workId: WORK,
                userId: PERSON,
                trigger: 'manual',
            });
        });

        describe('which App', () => {
            it.each([
                ['missing', new NotFoundException('Work not found')],
                ['one the person may not change', new ForbiddenException('No edit access')],
            ])('an App that is %s is the same 404 not_found', async (_name, error) => {
                ownership.ensureCanEdit.mockRejectedValueOnce(error);
                expect(await refusalOf(apps.deploy(person, WORK, { link_id: LINK }))).toMatchObject(
                    {
                        status: 404,
                        code: 'not_found',
                    },
                );
                expect(deployRequest.request).not.toHaveBeenCalled();
            });

            it.each([
                ['of another Organization', { organizationId: otherOrganization.id }],
                ["of no Organization (the person's own)", { organizationId: null }],
            ])('an App %s is not there for this link: 404 not_found', async (_name, work) => {
                ownership.ensureCanEdit.mockResolvedValueOnce(access(work));
                expect(await refusalOf(apps.deploy(person, WORK, { link_id: LINK }))).toMatchObject(
                    {
                        status: 404,
                        code: 'not_found',
                    },
                );
                expect(deployRequest.request).not.toHaveBeenCalled();
            });

            it('a Work that is not an App has nothing to deploy this way: 422 notAnAppWork', async () => {
                ownership.ensureCanEdit.mockResolvedValueOnce(access({ kind: 'website' }));
                expect(await refusalOf(apps.deploy(person, WORK, { link_id: LINK }))).toMatchObject(
                    {
                        status: 422,
                        code: 'notAnAppWork',
                    },
                );
                expect(deployRequest.request).not.toHaveBeenCalled();
            });
        });

        it('checks the link and the membership as a create does', async () => {
            const unknown = await refusalOf(apps.deploy(person, WORK, { link_id: UNKNOWN_LINK }));
            expect(unknown).toMatchObject({ status: 404, code: 'link_not_found' });
            // Anyone outside a link is told what a link that is not known answers.
            for (const [caller, linkId] of [
                [callerOf(OUTSIDER), LINK],
                [person, OTHER_LINK],
                [person, ARCHIVED_LINK],
                [callerOf(OUTSIDER), FORMER_LINK],
            ] as const) {
                expect(await refusalOf(apps.deploy(caller, WORK, { link_id: linkId }))).toEqual(
                    unknown,
                );
            }
            // Only a member learns that their link was removed.
            expect(
                await refusalOf(apps.deploy(person, WORK, { link_id: FORMER_LINK })),
            ).toMatchObject({ status: 409, code: 'link_not_active' });
            connection.connection.mockResolvedValueOnce({ status: 'disconnected' });
            expect(await refusalOf(apps.deploy(person, WORK, { link_id: LINK }))).toMatchObject({
                status: 409,
                code: 'not_connected',
            });
            expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
            expect(deployRequest.request).not.toHaveBeenCalled();
            expect(activity.log).not.toHaveBeenCalled();
        });

        it.each([
            ['an App id that is not one', 'not-a-work', { link_id: LINK }, 'workId'],
            ['no body', WORK, undefined, 'body'],
            ['no link', WORK, {}, 'link_id'],
            ['a link id that is not one', WORK, { link_id: 'x' }, 'link_id'],
            [
                'an environment an App does not have',
                WORK,
                { link_id: LINK, environment: 'preview' },
                'environment',
            ],
            [
                'an environment that is not text',
                WORK,
                { link_id: LINK, environment: 1 },
                'environment',
            ],
            [
                'a confirmation of a change of cluster',
                WORK,
                { link_id: LINK, confirmClusterChange: true },
                'confirmClusterChange',
            ],
            ["a Build of the caller's choosing", WORK, { link_id: LINK, buildId: 'b1' }, 'buildId'],
        ])('refuses %s: 400 validation, naming the field', async (_name, workId, sent, field) => {
            expect(await refusalOf(apps.deploy(person, workId, sent))).toMatchObject({
                status: 400,
                code: 'validation',
                details: { field },
            });
            expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
            expect(deployRequest.request).not.toHaveBeenCalled();
        });
    });

    it('names every refusal of its own with a code that does not change', () => {
        expect(EVER_CONNECT_APPS_CODES).toEqual({
            validation: 'validation',
            notConnected: 'not_connected',
            linkNotFound: 'link_not_found',
            linkNotActive: 'link_not_active',
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
            ownerRequired: 'ownerRequired',
            sessionRequired: 'session_required',
            deployRefused: 'deploy_refused',
        });
    });

    /**
     * What an app did for a person is written down for that person: one Activity
     * row per App created and per deployment asked for, naming the app (its
     * client id) and the person, and nothing of the token.
     */
    describe('what was done is written down', () => {
        const WORK = randomUUID();
        const deployAccepted = {
            status: 'accepted',
            httpStatus: 202,
            code: null,
            deploymentId: 'deployment-1',
            runningDeploymentId: null,
            unmet: [],
        };
        const caller: DelegatedCaller = {
            auth: { userId: PERSON, authMethod: 'ever-id-delegated' } as DelegatedCaller['auth'],
            delegation: {
                identityId: 'identity-of-the-person',
                clientId: 'app-ever-co',
                scopes: ['apps:read', 'apps:write'],
            },
        };

        beforeEach(() => {
            ownership.ensureCanEdit.mockResolvedValue({
                work: { id: WORK, kind: 'app', organizationId: organization.id },
                role: 'owner',
            });
            deployRequest.request.mockResolvedValue(deployAccepted);
        });

        it('a created App: one row, for the person, naming the app that acted', async () => {
            works.createWork.mockResolvedValueOnce({
                status: 'success',
                work: { id: 'work-1', name: 'Booking' },
            });
            await apps.create(caller, 'key-1', body({ install_id: INSTALL }));

            expect(activity.log).toHaveBeenCalledTimes(1);
            expect(activity.log).toHaveBeenCalledWith({
                userId: PERSON,
                workId: 'work-1',
                actionType: ActivityActionType.WORK_CREATED,
                action: 'app.created.delegated',
                status: ActivityStatus.COMPLETED,
                summary: 'App created by app-ever-co, acting for you',
                actorKind: 'external',
                actorLabel: 'app-ever-co',
                metadata: {
                    via: 'ever-id-delegated',
                    clientId: 'app-ever-co',
                    linkId: LINK,
                    blueprintId: 'cal-diy',
                    autoProvision: false,
                    installId: INSTALL,
                },
                // In the Organization the link is for.
                tenantId: tenant,
                organizationId: organization.id,
            });
        });

        it('a deployment asked for: one row, with the deployment it is', async () => {
            await apps.deploy(caller, WORK, { link_id: LINK });

            expect(activity.log).toHaveBeenCalledTimes(1);
            expect(activity.log).toHaveBeenCalledWith({
                userId: PERSON,
                workId: WORK,
                actionType: ActivityActionType.APP_DEPLOY,
                action: 'app.deploy.requested.delegated',
                status: ActivityStatus.COMPLETED,
                summary: 'Deployment asked for by app-ever-co, acting for you',
                actorKind: 'external',
                actorLabel: 'app-ever-co',
                metadata: {
                    via: 'ever-id-delegated',
                    clientId: 'app-ever-co',
                    linkId: LINK,
                    deploymentId: 'deployment-1',
                    status: 'accepted',
                },
                tenantId: tenant,
                organizationId: organization.id,
            });
        });

        it('nothing of the token is in a row: identifiers of the app, the link and the App only', async () => {
            await apps.create(caller, 'key-1', body());
            await apps.deploy(caller, WORK, { link_id: LINK });
            const written = JSON.stringify(activity.log.mock.calls);
            expect(written).not.toMatch(/identity-of-the-person|apps:write|apps:read|scopes/);
            expect(written).not.toMatch(/eyJ|Bearer|token/i);
        });

        it('writes nothing for what did not happen', async () => {
            // An App that was already there, and the stored answer of an earlier request.
            works.createWork.mockResolvedValueOnce({
                status: 'success',
                work: { id: 'work-1', name: 'Booking' },
                alreadyExisted: true,
            });
            await apps.create(caller, 'key-1', body());
            await apps.create(caller, 'key-1', body());
            // A create and a deployment that were refused.
            works.createWork.mockRejectedValueOnce(new ConflictException('taken'));
            await refusalOf(apps.create(caller, 'key-2', body()));
            deployRequest.request.mockResolvedValueOnce({
                status: 'refused',
                httpStatus: 422,
                code: 'APP_DEPLOY_PRECONDITIONS',
                deploymentId: null,
                unmet: [{ code: 'no_target', message: 'Choose where this App runs first.' }],
            });
            await refusalOf(apps.deploy(caller, WORK, { link_id: LINK }));

            expect(activity.log).not.toHaveBeenCalled();
        });

        it('a repeated create writes one row, not two', async () => {
            await apps.create(caller, 'key-1', body());
            await apps.create(caller, 'key-1', body());
            expect(activity.log).toHaveBeenCalledTimes(1);
        });

        it('a store that cannot be written to never fails what already happened', async () => {
            activity.log.mockRejectedValueOnce(new Error('the activity store is down'));
            expect(await apps.create(caller, 'key-1', body())).toMatchObject({ status: 201 });
            activity.log.mockImplementationOnce(() => {
                throw new Error('not bound');
            });
            expect(await apps.deploy(caller, WORK, { link_id: LINK })).toMatchObject({
                status: 202,
            });
        });

        it('without the Activity store in the graph, both still work', async () => {
            const lean = appsWith(membership, undefined);
            expect(await lean.create(caller, 'key-1', body())).toMatchObject({ status: 201 });
            expect(await lean.deploy(caller, WORK, { link_id: LINK })).toMatchObject({
                status: 202,
            });
        });
    });

    /**
     * The same questions on the REAL `OrganizationMembershipService` (the tests
     * above play it with a stand-in that copies its contract): a member of the
     * account that owns the Organization is let through; a person of another
     * account, a person with no account and a person who does not exist are told
     * what a link that is not known answers.
     */
    describe("against the real membership rule: another account's link", () => {
        const NEWCOMER = randomUUID();
        const GHOST = randomUUID();
        const people: Record<string, { id: string; tenantId: string | null }> = {
            [PERSON]: { id: PERSON, tenantId: tenant },
            [OUTSIDER]: { id: OUTSIDER, tenantId: otherOrganization.tenantId },
            // Signed up, with no account of their own yet.
            [NEWCOMER]: { id: NEWCOMER, tenantId: null },
        };
        const organizations = [
            organization,
            formerOrganization,
            otherOrganization,
            goneOrganization,
        ];
        const WORK = randomUUID();
        let real: EverConnectAppsService;

        beforeEach(() => {
            real = appsWith(
                new OrganizationMembershipService(
                    {
                        findById: async (id: string) =>
                            organizations.find((candidate) => candidate.id === id) ?? null,
                    } as unknown as OrganizationRepository,
                    {
                        findById: async (id: string) => people[id] ?? null,
                    } as unknown as UserRepository,
                ),
            );
            ownership.ensureCanEdit.mockResolvedValue({
                work: { id: WORK, kind: 'app', organizationId: organization.id },
                role: 'owner',
            });
            deployRequest.request.mockResolvedValue({
                status: 'accepted',
                httpStatus: 202,
                code: null,
                deploymentId: 'deployment-1',
                unmet: [],
            });
        });

        it('a member of the account creates and deploys in the linked Organization', async () => {
            expect(await real.create(person, 'key-1', body())).toMatchObject({ status: 201 });
            expect(await real.deploy(person, WORK, { link_id: LINK })).toMatchObject({
                status: 202,
            });
        });

        it.each([
            ["a person of another account, naming this account's link", OUTSIDER, LINK],
            ["the person, naming another account's link", PERSON, OTHER_LINK],
            ["the person, naming another account's removed link", PERSON, ARCHIVED_LINK],
            [
                "a person of another account, naming this account's removed link",
                OUTSIDER,
                FORMER_LINK,
            ],
            ['a person with no account', NEWCOMER, LINK],
            ['a person who does not exist here', GHOST, LINK],
        ])(
            '%s: 404 link_not_found for a create and for a deployment',
            async (_n, userId, linkId) => {
                const unknown = await refusalOf(
                    real.create(person, 'key-0', body({ link_id: UNKNOWN_LINK })),
                );
                expect(unknown).toMatchObject({ status: 404, code: 'link_not_found' });

                const caller = callerOf(userId);
                expect(
                    await refusalOf(real.create(caller, 'key-1', body({ link_id: linkId }))),
                ).toEqual(unknown);
                expect(await refusalOf(real.deploy(caller, WORK, { link_id: linkId }))).toEqual(
                    unknown,
                );
                // Nothing was looked at, created, started or written down.
                expect(catalog.get).not.toHaveBeenCalled();
                expect(inspector.inspect).not.toHaveBeenCalled();
                expect(works.createWork).not.toHaveBeenCalled();
                expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
                expect(deployRequest.request).not.toHaveBeenCalled();
                expect(activity.log).not.toHaveBeenCalled();
                expect(await keys()).toEqual([]);
            },
        );

        it('only a member is told that a link of their account was removed', async () => {
            expect(
                await refusalOf(real.create(person, 'key-1', body({ link_id: FORMER_LINK }))),
            ).toMatchObject({ status: 409, code: 'link_not_active' });
            expect(
                await refusalOf(real.deploy(person, WORK, { link_id: FORMER_LINK })),
            ).toMatchObject({ status: 409, code: 'link_not_active' });
        });
    });
});
