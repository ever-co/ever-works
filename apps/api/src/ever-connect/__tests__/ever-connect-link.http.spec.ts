// The Organization module pulls in the whole auth stack, which this app's jest
// cannot load. The link module needs two things of it: the membership service
// and the ownership guard. The guard is the real one; the membership service is
// a small stand-in over `mockOrganizations` with the real one's contract, as
// `organization-access.contract.spec.ts` pins it on the real service: 404 for an
// Organization of another account; `ensureAdmin` lets every member of the
// account through (its role check is opt-in and off by default);
// `ensureRoleAdmin` lets only the owner and an admin through, always.
jest.mock('../../organizations/organizations.module', () => {
    const { ForbiddenException, Module, NotFoundException } = jest.requireActual('@nestjs/common');
    const { OrganizationMembershipService } = jest.requireActual(
        '../../organizations/organization-membership.service',
    );
    const { OrganizationOwnershipGuard } = jest.requireActual(
        '../../organizations/guards/organization-ownership.guard',
    );
    class Membership {
        async ensureMember(orgId: string, userId: string) {
            const organization = mockOrganizations.get(orgId);
            if (!organization || !organization.members.includes(userId)) {
                throw new NotFoundException(`Organization ${orgId} not found`);
            }
            return organization;
        }

        // As the real one while `ORG_ADMIN_ROLE_ENFORCED` is unset: membership only.
        async ensureAdmin(orgId: string, userId: string) {
            mockGeneralAdminChecks.push(userId);
            return this.ensureMember(orgId, userId);
        }

        async ensureRoleAdmin(orgId: string, userId: string) {
            const organization = await this.ensureMember(orgId, userId);
            if (organization.owner !== userId && !organization.admins.includes(userId)) {
                throw new ForbiddenException('Only an organization admin can change this.');
            }
            return organization;
        }

        async isRoleAdmin(orgId: string, userId: string) {
            return this.ensureRoleAdmin(orgId, userId).then(
                () => true,
                () => false,
            );
        }
    }
    class OrganizationsModule {}
    Module({
        providers: [
            { provide: OrganizationMembershipService, useClass: Membership },
            OrganizationOwnershipGuard,
        ],
        exports: [OrganizationMembershipService, OrganizationOwnershipGuard],
    })(OrganizationsModule);
    return { OrganizationsModule };
});

import 'reflect-metadata';
import { Global, Module, type INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import type { DataSource } from 'typeorm';
import { ActivityLogModule, ActivityLogService } from '@ever-works/agent/activity-log';
import { DatabaseModule, ENTITIES, UserRepository } from '@ever-works/agent/database';
import { EverConnectConnection, EverConnectLink } from '@ever-works/agent/entities';
import { everConnectAppSyncModuleImports } from '../app-sync/app-sync.module';
import { EverConnectAdminController } from '../ever-connect-admin.controller';
import { EVER_CONNECT_CONFIG, readEverConnectConfig } from '../ever-connect.config';
import { everConnectModuleImports } from '../ever-connect.module';
import { EverConnectService } from '../ever-connect.service';
import { everConnectLinkModuleImports } from '../links/ever-connect-link.module';

interface TestOrganization {
    id: string;
    tenantId: string;
    slug: string;
    /** The account's owner. */
    owner: string;
    /** Everyone of the account. */
    members: string[];
    /** The members whose role in the Organization is `admin`. */
    admins: string[];
}
const mockOrganizations = new Map<string, TestOrganization>();
/** Who the general (opt-in) admin check was asked about: the link routes must not rely on it. */
const mockGeneralAdminChecks: string[] = [];

/**
 * An Organization's link over HTTP, with the modules wired by Nest as
 * `ApiModule` wires them: who may read, who may change, what a refusal says,
 * and that nothing is asked of Ever Platform before the installation is
 * connected.
 */
@Global()
@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        }),
        TypeOrmModule.forFeature(ENTITIES),
    ],
    providers: [UserRepository],
    exports: [TypeOrmModule, UserRepository],
})
class TestDatabaseModule {}

@Module({
    providers: [{ provide: ActivityLogService, useValue: { log: async () => ({}) } }],
    exports: [ActivityLogService],
})
class TestActivityLogModule {}

const ORG = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ORG = '22222222-2222-4222-8222-222222222222';
const OWNER = 'user-owner';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const LINK = `/api/ever-connect/organizations/${ORG}/link`;

async function boot(env: Record<string, string | undefined>): Promise<INestApplication> {
    @Module({
        imports: [
            ...everConnectModuleImports(env),
            ...everConnectLinkModuleImports(env),
            ...everConnectAppSyncModuleImports(env),
        ],
    })
    class Root {}

    const moduleRef = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot(), Root],
    })
        .overrideModule(DatabaseModule)
        .useModule(TestDatabaseModule)
        .overrideModule(ActivityLogModule)
        .useModule(TestActivityLogModule)
        .overrideProvider(EVER_CONNECT_CONFIG)
        .useValue(readEverConnectConfig(env))
        .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    // The session, as the API's global session guard would have put it on the request.
    app.use(
        (
            req: { headers: Record<string, string>; user?: unknown },
            _res: unknown,
            next: () => void,
        ) => {
            const as = req.headers['x-test-user'];
            if (as) req.user = JSON.parse(as);
            next();
        },
    );
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    return app;
}

const as = (userId: string, authMethod = 'session') => JSON.stringify({ userId, authMethod });

describe("Ever Connect — an Organization's link over HTTP", () => {
    const savedEnv = { ...process.env };
    const ON = {
        EVER_CONNECT_ENABLED: 'true',
        EVER_CONNECT_LINK_CODES_ENABLED: 'true',
        EVER_CONNECT_HEARTBEAT_ENABLED: 'true',
        EVER_CONNECT_ENTITLEMENTS_ENABLED: 'true',
        EVER_CONNECT_APP_SYNC_ENABLED: 'true',
        EVER_PLATFORM_API_URL: 'https://platform.example.test',
    };
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        mockOrganizations.clear();
        mockGeneralAdminChecks.length = 0;
        mockOrganizations.set(ORG, {
            id: ORG,
            tenantId: '33333333-3333-4333-8333-333333333333',
            slug: 'acme-works',
            owner: OWNER,
            members: [OWNER, ADMIN, MEMBER],
            admins: [ADMIN],
        });
        mockOrganizations.set(FOREIGN_ORG, {
            id: FOREIGN_ORG,
            tenantId: '44444444-4444-4444-8444-444444444444',
            slug: 'someone-else',
            owner: 'user-other',
            members: ['user-other'],
            admins: [],
        });
    });

    beforeEach(() => {
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            throw new Error('no request is expected');
        });
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        process.env = { ...savedEnv };
    });

    it('without its switch the link routes do not exist, also with Ever Connect on', async () => {
        const env = {
            EVER_CONNECT_ENABLED: 'true',
            EVER_PLATFORM_API_URL: ON.EVER_PLATFORM_API_URL,
        };
        Object.assign(process.env, env);
        expect(everConnectLinkModuleImports(env)).toEqual([]);
        expect(everConnectAppSyncModuleImports(env)).toEqual([]);
        const app = await boot(env);
        try {
            const http = request(app.getHttpServer());
            await http.get(LINK).set('x-test-user', as(ADMIN)).expect(404);
            await http
                .post(LINK)
                .set('x-test-user', as(ADMIN))
                .send({ code: 'EVL-TEST-0000-0001' })
                .expect(404);
            await http.delete(LINK).set('x-test-user', as(ADMIN)).expect(404);
            // The operator's status says which parts run: none.
            const status = await app.get(EverConnectAdminController).status();
            expect(status.features).toEqual({
                linkCodes: false,
                heartbeat: false,
                entitlements: false,
                appSync: false,
            });
            expect(status.heartbeat).toEqual({ lastSentAt: null });
            expect(status.entitlement).toBeNull();
            expect(status.appSync).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('a member reads the link; an Organization of another account is not found', async () => {
        Object.assign(process.env, ON);
        const app = await boot(ON);
        try {
            const http = request(app.getHttpServer());
            const answer = await http.get(LINK).set('x-test-user', as(MEMBER)).expect(200);
            expect(answer.body).toEqual({
                connected: false,
                link: null,
                entitlement: null,
                appSync: false,
                // A member reads; the page does not offer them to change it.
                canManage: false,
            });
            expect(answer.headers['cache-control']).toBe('no-store');
            for (const administrator of [OWNER, ADMIN]) {
                const theirs = await http
                    .get(LINK)
                    .set('x-test-user', as(administrator))
                    .expect(200);
                expect(theirs.body.canManage).toBe(true);
            }
            // An API key may read as the member it acts for.
            await http.get(LINK).set('x-test-user', as(MEMBER, 'api-key')).expect(200);

            const foreign = `/api/ever-connect/organizations/${FOREIGN_ORG}/link`;
            await http.get(foreign).set('x-test-user', as(MEMBER)).expect(404);
            await http
                .post(foreign)
                .set('x-test-user', as(ADMIN))
                .send({ code: 'EVL-TEST-0000-0001' })
                .expect(404);
            await http.delete(foreign).set('x-test-user', as(ADMIN)).expect(404);
            // No session at all: not found either (fail closed).
            await http.get(LINK).expect(404);
            await http.post(LINK).send({ code: 'EVL-TEST-0000-0001' }).expect(404);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it.each([
        ['unset (the default)', undefined],
        ['false', 'false'],
        ['true', 'true'],
    ])(
        'a plain member of the account neither links nor removes a link, with ORG_ADMIN_ROLE_ENFORCED %s; the owner and an admin do',
        async (_name, enforced) => {
            Object.assign(process.env, ON);
            if (enforced === undefined) delete process.env.ORG_ADMIN_ROLE_ENFORCED;
            else process.env.ORG_ADMIN_ROLE_ENFORCED = enforced;
            const app = await boot(ON);
            try {
                const http = request(app.getHttpServer());
                const code = { code: 'EVL-TEST-0000-0001' };
                const dataSource = app.get<DataSource>(getDataSourceToken());
                const organization = mockOrganizations.get(ORG) as TestOrganization;
                await dataSource.getRepository(EverConnectLink).insert({
                    organizationId: ORG,
                    tenantId: organization.tenantId,
                    everOrgId: '01JMQCK0RG000000000000000B',
                    handle: 'globex',
                    platformLinkId: '01JZ8Q3M4N5P6R7S8T9V0W1XA1',
                    createdVia: 'provisioning',
                    status: 'active',
                });

                // The member: refused on both, and the real link is still there.
                const linking = await http
                    .post(LINK)
                    .set('x-test-user', as(MEMBER))
                    .send(code)
                    .expect(403);
                expect(linking.body.code).not.toBe('session_required');
                await http.delete(LINK).set('x-test-user', as(MEMBER)).expect(403);
                expect(await dataSource.getRepository(EverConnectLink).find()).toMatchObject([
                    { organizationId: ORG, status: 'active' },
                ]);
                // They still read it.
                await http.get(LINK).set('x-test-user', as(MEMBER)).expect(200);

                // The owner and an admin pass the same check: their answers are
                // about the link (it exists) and the connection, not about them.
                for (const administrator of [OWNER, ADMIN]) {
                    const again = await http
                        .post(LINK)
                        .set('x-test-user', as(administrator))
                        .send(code)
                        .expect(409);
                    expect(again.body.code).toBe('not_connected');
                }
                await http.delete(LINK).set('x-test-user', as(ADMIN)).expect(200);
                expect(await dataSource.getRepository(EverConnectLink).find()).toMatchObject([
                    { organizationId: ORG, status: 'archived' },
                ]);
                const gone = await http.delete(LINK).set('x-test-user', as(OWNER)).expect(404);
                expect(gone.body.code).toBe('not_linked');

                // Another account, also its owner: not found, as before.
                const foreign = `/api/ever-connect/organizations/${FOREIGN_ORG}/link`;
                await http.post(foreign).set('x-test-user', as(OWNER)).send(code).expect(404);
                await http.delete(foreign).set('x-test-user', as(MEMBER)).expect(404);
                await http.post(LINK).set('x-test-user', as('user-other')).send(code).expect(404);

                // None of this asked the general admin check, whose role rule is opt-in.
                expect(mockGeneralAdminChecks).toEqual([]);
                expect(fetchSpy).not.toHaveBeenCalled();
            } finally {
                await app.close();
            }
        },
    );

    it('a link is changed only in an interactive session', async () => {
        Object.assign(process.env, ON);
        const app = await boot(ON);
        try {
            const http = request(app.getHttpServer());
            const code = { code: 'EVL-TEST-0000-0001' };
            // An API key acting as the admin is refused.
            const keyed = await http
                .post(LINK)
                .set('x-test-user', as(ADMIN, 'api-key'))
                .send(code)
                .expect(403);
            expect(keyed.body.code).toBe('session_required');
            await http.delete(LINK).set('x-test-user', as(ADMIN, 'api-key')).expect(403);
            // A request whose way of signing in is not known is refused too (fail closed).
            await http
                .post(LINK)
                .set('x-test-user', JSON.stringify({ userId: ADMIN }))
                .send(code)
                .expect(403);
            await http
                .delete(LINK)
                .set('x-test-user', JSON.stringify({ userId: ADMIN }))
                .expect(403);
            await http
                .post(LINK)
                .set('x-test-user', as(ADMIN, 'ever-id-delegated'))
                .send(code)
                .expect(403);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('a code is checked, and nothing is asked of Ever Platform while the installation is not connected', async () => {
        Object.assign(process.env, ON);
        const app = await boot(ON);
        try {
            const http = request(app.getHttpServer());
            const post = (body: unknown) =>
                http
                    .post(LINK)
                    .set('x-test-user', as(ADMIN))
                    .send(body as object);
            for (const body of [{}, { code: 42 }, { code: 'x'.repeat(33) }]) {
                await post(body).expect(400);
            }
            for (const code of [
                'nope',
                'EVC-TEST-0000-0004',
                'EVL-TEST-0000',
                'EVL-IIII-LLLL-OOOO',
                'EVL-TEST-0000-000',
            ]) {
                const refused = await post({ code }).expect(400);
                expect(refused.body.code).toBe('code_invalid');
                // A refused code is not said back, whatever was typed.
                expect(JSON.stringify(refused.body)).not.toContain(code);
            }
            // A code is the same code in any case, as app.ever.co shows it or typed
            // by hand: this one is well formed, so the answer is about the connection.
            const notConnected = await post({ code: 'evl-test-0000-0001' }).expect(409);
            expect(notConnected.body.code).toBe('not_connected');
            const notLinked = await http.delete(LINK).set('x-test-user', as(ADMIN)).expect(404);
            expect(notLinked.body.code).toBe('not_linked');
            // No answer ever carries the code.
            expect(JSON.stringify([notConnected.body, notLinked.body])).not.toMatch(/EVL-/i);
            expect(fetchSpy).not.toHaveBeenCalled();

            // With every part switched on and no connection: the operator's status.
            const status = await app.get(EverConnectAdminController).status();
            expect(status.features).toEqual({
                linkCodes: true,
                heartbeat: true,
                entitlements: true,
                appSync: true,
            });
            expect(status.connection.status).toBe('disconnected');
            expect(status.heartbeat).toEqual({ lastSentAt: null });
            expect(status.entitlement).toBeNull();
            expect(status.appSync).toEqual({
                linksEnabled: 0,
                pending: 0,
                failed: 0,
                lastError: null,
                reconciledAt: null,
            });
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('a link that exists is shown to a member and removed by an admin; not connected, it is removed here only', async () => {
        Object.assign(process.env, ON);
        const app = await boot(ON);
        try {
            const http = request(app.getHttpServer());
            const dataSource = app.get<DataSource>(getDataSourceToken());
            const organization = mockOrganizations.get(ORG) as TestOrganization;
            await dataSource.getRepository(EverConnectLink).insert({
                organizationId: ORG,
                tenantId: organization.tenantId,
                everOrgId: '01JMQCK0RG000000000000000B',
                handle: 'globex',
                platformLinkId: '01JZ8Q3M4N5P6R7S8T9V0W1XA1',
                createdVia: 'provisioning',
                status: 'active',
            });

            const shown = await http.get(LINK).set('x-test-user', as(MEMBER)).expect(200);
            expect(shown.body).toMatchObject({
                connected: false,
                link: {
                    everOrgId: '01JMQCK0RG000000000000000B',
                    handle: 'globex',
                    createdVia: 'provisioning',
                },
                appSync: false,
            });
            // What Ever Platform calls the link stays inside the installation.
            expect(JSON.stringify(shown.body)).not.toContain('01JZ8Q3M4N5P6R7S8T9V0W1XA1');

            // A member may not remove it; an admin may.
            await http.delete(LINK).set('x-test-user', as(MEMBER)).expect(403);
            const removed = await http.delete(LINK).set('x-test-user', as(ADMIN)).expect(200);
            expect(removed.body).toEqual({
                connected: false,
                link: null,
                entitlement: null,
                appSync: false,
                canManage: true,
            });
            const after = await http.get(LINK).set('x-test-user', as(MEMBER)).expect(200);
            expect(after.body.link).toBeNull();
            expect(after.body.canManage).toBe(false);
            const again = await http.delete(LINK).set('x-test-user', as(ADMIN)).expect(404);
            expect(again.body.code).toBe('not_linked');
            // Nothing in Ever Works was deleted: the link is archived.
            expect(await dataSource.getRepository(EverConnectLink).find()).toMatchObject([
                { organizationId: ORG, status: 'archived' },
            ]);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('connected: an admin links with a code and removes the link, Ever Platform played by a fake client', async () => {
        Object.assign(process.env, ON);
        const app = await boot(ON);
        try {
            const http = request(app.getHttpServer());
            const dataSource = app.get<DataSource>(getDataSourceToken());
            const organization = mockOrganizations.get(ORG) as TestOrganization;
            const connection = app.get(EverConnectService);
            // The connection row exists once it was read; then it is a connected installation.
            await connection.status();
            await dataSource
                .getRepository(EverConnectConnection)
                .update(
                    { id: 'self' },
                    { status: 'active', platformInstanceId: '01JZ8Q3M4N5P6R7S8T9V0W1X2Y' },
                );
            const create = jest.fn(async () => ({
                id: '01JZ8Q3M4N5P6R7S8T9V0W1XA1',
                org_id: '01JMQCK0RG000000000000000B',
            }));
            const remove = jest.fn(async () => undefined);
            const unavailable = async () => {
                throw Object.assign(new Error('x'), {
                    name: 'ProblemError',
                    status: 503,
                    code: 'unavailable',
                });
            };
            jest.spyOn(connection, 'client').mockResolvedValue({
                instances: {
                    tenantLinks: { create, remove },
                    integrations: async () => ({ instance: {}, links: {} }),
                    entitlement: unavailable,
                    linkEntitlement: unavailable,
                },
            } as never);

            // The body names a code only: the Organization is the one of the route,
            // checked against the session, never one the body could name.
            const linked = await http
                .post(LINK)
                .set('x-test-user', as(ADMIN))
                .send({
                    code: ' evl-7k2m-9qxr-4htb ',
                    organizationId: FOREIGN_ORG,
                    tenantId: 'someone-else',
                })
                .expect(201);
            expect(linked.body).toMatchObject({
                connected: true,
                link: { everOrgId: '01JMQCK0RG000000000000000B', createdVia: 'link_code' },
            });
            expect(linked.headers['cache-control']).toBe('no-store');
            expect(create).toHaveBeenCalledTimes(1);
            expect((create.mock.calls[0] as unknown[])[0]).toEqual({
                link_code: 'EVL-7K2M-9QXR-4HTB',
                product: 'works',
                product_tenant_id: organization.tenantId,
                product_org_id: 'acme-works',
            });
            expect(JSON.stringify(linked.body)).not.toMatch(/7K2M/i);

            // Linked already: refused here, Ever Platform is not asked again.
            const twice = await http
                .post(LINK)
                .set('x-test-user', as(ADMIN))
                .send({ code: 'EVL-0000-0000-0001' })
                .expect(409);
            expect(twice.body.code).toBe('already_linked');
            expect(JSON.stringify(twice.body)).not.toMatch(/EVL-|0000-0001/i);
            expect(create).toHaveBeenCalledTimes(1);

            const shown = await http.get(LINK).set('x-test-user', as(MEMBER)).expect(200);
            expect(shown.body.link).toMatchObject({ everOrgId: '01JMQCK0RG000000000000000B' });

            const removed = await http.delete(LINK).set('x-test-user', as(ADMIN)).expect(200);
            expect(removed.body).toMatchObject({ connected: true, link: null });
            expect(remove).toHaveBeenCalledWith('01JZ8Q3M4N5P6R7S8T9V0W1XA1');
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });
});
