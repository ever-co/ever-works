// The Organization module pulls in the whole auth stack, which this app's jest
// cannot load. The link module needs two things of it: the membership service
// and the ownership guard. The guard is the real one; the membership service is
// a small stand-in over `mockOrganizations` with the real one's contract (404
// for an Organization of another account, 403 for a member who is not an admin).
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

        async ensureAdmin(orgId: string, userId: string) {
            const organization = await this.ensureMember(orgId, userId);
            if (!organization.admins.includes(userId)) {
                throw new ForbiddenException('Only an organization admin can change this.');
            }
            return organization;
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
import { TypeOrmModule } from '@nestjs/typeorm';
import * as request from 'supertest';
import { ActivityLogModule, ActivityLogService } from '@ever-works/agent/activity-log';
import { DatabaseModule, ENTITIES, UserRepository } from '@ever-works/agent/database';
import { everConnectAppSyncModuleImports } from '../app-sync/app-sync.module';
import { EverConnectAdminController } from '../ever-connect-admin.controller';
import { EVER_CONNECT_CONFIG, readEverConnectConfig } from '../ever-connect.config';
import { everConnectModuleImports } from '../ever-connect.module';
import { everConnectLinkModuleImports } from '../links/ever-connect-link.module';

interface TestOrganization {
    id: string;
    tenantId: string;
    slug: string;
    members: string[];
    admins: string[];
}
const mockOrganizations = new Map<string, TestOrganization>();

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

    beforeAll(() => {
        mockOrganizations.set(ORG, {
            id: ORG,
            tenantId: '33333333-3333-4333-8333-333333333333',
            slug: 'acme-works',
            members: [ADMIN, MEMBER],
            admins: [ADMIN],
        });
        mockOrganizations.set(FOREIGN_ORG, {
            id: FOREIGN_ORG,
            tenantId: '44444444-4444-4444-8444-444444444444',
            slug: 'someone-else',
            members: ['user-other'],
            admins: ['user-other'],
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
            });
            expect(answer.headers['cache-control']).toBe('no-store');
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

    it('only an admin of the Organization changes the link, and only in an interactive session', async () => {
        Object.assign(process.env, ON);
        const app = await boot(ON);
        try {
            const http = request(app.getHttpServer());
            const code = { code: 'EVL-TEST-0000-0001' };
            await http.post(LINK).set('x-test-user', as(MEMBER)).send(code).expect(403);
            await http.delete(LINK).set('x-test-user', as(MEMBER)).expect(403);
            // An API key acting as the admin is refused.
            const keyed = await http
                .post(LINK)
                .set('x-test-user', as(ADMIN, 'api-key'))
                .send(code)
                .expect(403);
            expect(keyed.body.code).toBe('session_required');
            await http.delete(LINK).set('x-test-user', as(ADMIN, 'api-key')).expect(403);
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
            }
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
});
