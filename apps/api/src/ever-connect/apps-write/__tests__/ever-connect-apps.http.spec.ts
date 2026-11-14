// The module composes the Work, App and deploy modules, whose barrels pull
// packages jest cannot parse. What is driven here is the HTTP surface: the real
// session guard, the real marks on the real controller, and the service behind
// it as a double (its own decisions are pinned by `ever-connect-apps.service.spec.ts`).
jest.mock('@ever-works/agent/services', () => ({
    WorkModule: class WorkModule {},
    WorkLifecycleService: class WorkLifecycleService {},
    WorkOwnershipService: class WorkOwnershipService {},
    WorkQueryService: class WorkQueryService {},
}));
jest.mock('@ever-works/agent/app-runtime', () => ({
    AppDeployRequestModule: class AppDeployRequestModule {},
    AppDeployRequestService: class AppDeployRequestService {},
    AppTargetService: class AppTargetService {},
    APPS_TIER_POLICY: Symbol('APPS_TIER_POLICY'),
}));
jest.mock('@ever-works/agent/app-works', () => ({
    AppWorksModule: class AppWorksModule {},
    AppSourceInspectorService: class AppSourceInspectorService {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    FacadesModule: class FacadesModule {},
    GitFacadeService: class GitFacadeService {},
}));
jest.mock('@ever-works/agent/fleet', () => ({
    FleetRunCredentialService: class FleetRunCredentialService {},
}));
jest.mock('../../../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));

import 'reflect-metadata';
import {
    HttpException,
    HttpStatus,
    Module,
    ValidationPipe,
    type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AuthSessionGuard } from '../../../auth/guards/auth-session.guard';
import { DelegatedPrincipalGuard } from '../../../auth/guards/delegated-principal.guard';
import { EVER_ID_DELEGATION_VERIFIER } from '../../../auth/guards/ever-id-guard.tokens';
import { AUTH_PROVIDER } from '../../../auth/providers/auth-provider.constants';
import { EverIdHttpException } from '../../../auth/services/ever-id-errors';
import { EverConnectAppsController } from '../ever-connect-apps.controller';
import { EverConnectAppsModule, everConnectAppsModuleImports } from '../ever-connect-apps.module';
import { EverConnectAppsService } from '../ever-connect-apps.service';

/**
 * `POST /api/ever-connect/apps` and `POST /api/ever-connect/apps/:workId/deploy`
 * over HTTP, behind the API's real session guard: that they do not exist
 * without their switch, who is let through to them, and what travels to the
 * service and back.
 */
const LINK = '01JZ8Q3M4N5P6R7S8T9V0W1XA1';
const WORK = '9c0a3f7e-2b1d-4c8e-9f11-0a2b3c4d5e6f';
/** Shaped like a compact JWS: what the guard takes for a delegated token. */
const WRITE_TOKEN = 'write.token.sig';
const READ_TOKEN = 'read.token.sig';
const STRANGER_TOKEN = 'stranger.token.sig';
const BAD_TOKEN = 'bad.token.sig';
/** An Ever Works session bearer never contains a dot. */
const SESSION = 'opaque-session-token';

const ON = { EVER_CONNECT_ENABLED: 'true', EVER_CONNECT_APPS_WRITE_ENABLED: 'true' };

const apps = { create: jest.fn(), deploy: jest.fn() };
const authProvider = { authenticate: jest.fn() };
/** The verifier's contract: the principal, `null` (401), or a coded 403. */
const verifier = {
    authenticate: jest.fn(async (token: string, scope: string) => {
        if (token === BAD_TOKEN) return null;
        if (token === STRANGER_TOKEN) {
            throw new HttpException(
                { status: 'error', code: 'no_linked_identity', message: 'x' },
                HttpStatus.FORBIDDEN,
            );
        }
        const carried = token === WRITE_TOKEN ? ['apps:read', 'apps:write'] : ['apps:read'];
        if (!carried.includes(scope)) throw new EverIdHttpException('insufficientScope');
        return {
            user: { userId: 'user-1', authMethod: 'ever-id-delegated' },
            binding: { identityId: 'identity-1', clientId: 'app-ever-co', scopes: carried },
        };
    }),
};

/** The API with the module as `ApiModule` would have it for `env`. */
async function boot(env: Record<string, string | undefined>): Promise<INestApplication> {
    const switchedOn = everConnectAppsModuleImports(env).length > 0;

    // What the module declares for HTTP, with its service as a double.
    @Module({
        controllers: Reflect.getMetadata('controllers', EverConnectAppsModule),
        providers: [DelegatedPrincipalGuard, { provide: EverConnectAppsService, useValue: apps }],
    })
    class AppsHttp {}

    const moduleRef = await Test.createTestingModule({
        imports: switchedOn ? [AppsHttp] : [],
        providers: [
            { provide: AUTH_PROVIDER, useValue: authProvider },
            { provide: EVER_ID_DELEGATION_VERIFIER, useValue: verifier },
            { provide: APP_GUARD, useClass: AuthSessionGuard },
        ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    // The API's own pipe: it must leave these bodies to the service.
    app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    return app;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Ever Connect — apps for a person, over HTTP', () => {
    let app: INestApplication;

    beforeEach(() => {
        apps.create.mockReset();
        apps.deploy.mockReset();
        authProvider.authenticate.mockReset();
        verifier.authenticate.mockClear();
        authProvider.authenticate.mockResolvedValue(null);
        apps.create.mockResolvedValue({
            status: 201,
            replayed: false,
            body: {
                id: WORK,
                name: 'Booking',
                url: `https://works.example.test/org/acme/works/${WORK}`,
            },
        });
        apps.deploy.mockResolvedValue({
            status: 202,
            body: { deployment_id: 'deployment-1', status: 'accepted' },
        });
    });

    afterEach(async () => {
        await app?.close();
    });

    describe('without its switch', () => {
        it.each([
            ['nothing set', {}],
            ['Ever Connect on, the switch unset', { EVER_CONNECT_ENABLED: 'true' }],
            ['the switch on, Ever Connect off', { EVER_CONNECT_APPS_WRITE_ENABLED: 'true' }],
            ['a value that is not `true`', { ...ON, EVER_CONNECT_APPS_WRITE_ENABLED: '1' }],
            [
                'every other part on',
                {
                    EVER_CONNECT_ENABLED: 'true',
                    EVER_CONNECT_LINK_CODES_ENABLED: 'true',
                    EVER_CONNECT_APP_SYNC_ENABLED: 'true',
                    EVER_CONNECT_PROVISIONING_ENABLED: 'true',
                },
            ],
        ])('the routes do not exist (%s): 404, like any unknown address', async (_name, env) => {
            expect(everConnectAppsModuleImports(env)).toEqual([]);
            app = await boot(env);
            const http = request(app.getHttpServer());
            const unknown = await http.post('/api/ever-connect/no-such-route').send({});
            for (const path of [
                '/api/ever-connect/apps',
                `/api/ever-connect/apps/${WORK}/deploy`,
            ]) {
                // With the best credential there is, and with none.
                for (const headers of [bearer(WRITE_TOKEN), {}]) {
                    const answer = await http.post(path).set(headers).send({ link_id: LINK });
                    expect(answer.status).toBe(404);
                    // The same answer as an address nothing serves (its message names the path).
                    expect({ ...answer.body, message: '' }).toEqual({
                        ...unknown.body,
                        message: '',
                    });
                }
            }
            expect(verifier.authenticate).not.toHaveBeenCalled();
            expect(apps.create).not.toHaveBeenCalled();
            expect(apps.deploy).not.toHaveBeenCalled();
        });

        it('with its switch the API imports the module, and only then', () => {
            expect(everConnectAppsModuleImports(ON)).toEqual([EverConnectAppsModule]);
            expect(Reflect.getMetadata('controllers', EverConnectAppsModule)).toEqual([
                EverConnectAppsController,
            ]);
        });
    });

    describe('with its switch', () => {
        beforeEach(async () => {
            app = await boot(ON);
        });

        const create = (headers: Record<string, string>, body: object = { link_id: LINK }) =>
            request(app.getHttpServer()).post('/api/ever-connect/apps').set(headers).send(body);
        const deploy = (headers: Record<string, string>, body: object = { link_id: LINK }) =>
            request(app.getHttpServer())
                .post(`/api/ever-connect/apps/${WORK}/deploy`)
                .set(headers)
                .send(body);

        it('creates an App for a delegated token with apps:write: 201, the body as it came', async () => {
            const sent = {
                link_id: LINK,
                name: 'Booking',
                blueprint_id: 'cal-diy',
                install_id: '01JC5R7Y6K1M9E0V3Q2A8XW4TB',
            };
            const answer = await create(
                { ...bearer(WRITE_TOKEN), 'Idempotency-Key': 'key-1' },
                sent,
            );

            expect(answer.status).toBe(201);
            expect(answer.body).toEqual({
                id: WORK,
                name: 'Booking',
                url: `https://works.example.test/org/acme/works/${WORK}`,
            });
            expect(answer.headers['cache-control']).toBe('no-store');
            expect(answer.headers['idempotent-replayed']).toBeUndefined();
            // The write scope, asked of the verifier as a write.
            expect(verifier.authenticate).toHaveBeenCalledWith(
                WRITE_TOKEN,
                'apps:write',
                expect.any(Object),
                { access: 'write' },
            );
            // The person and the app acting for them, the key, and the body untouched.
            expect(apps.create).toHaveBeenCalledWith(
                {
                    auth: { userId: 'user-1', authMethod: 'ever-id-delegated' },
                    delegation: {
                        identityId: 'identity-1',
                        clientId: 'app-ever-co',
                        scopes: ['apps:read', 'apps:write'],
                    },
                },
                'key-1',
                sent,
            );
        });

        it('answers the stored answer of an earlier request as such', async () => {
            apps.create.mockResolvedValueOnce({
                status: 201,
                replayed: true,
                body: { id: WORK, name: 'Booking', url: 'https://works.example.test/x' },
            });
            const answer = await create({ ...bearer(WRITE_TOKEN), 'Idempotency-Key': 'key-1' });
            expect(answer.status).toBe(201);
            expect(answer.headers['idempotent-replayed']).toBe('true');
        });

        it('the pipe leaves the body to the service: a field it does not know is refused there, with a code', async () => {
            apps.create.mockRejectedValueOnce(
                new HttpException(
                    {
                        status: 'error',
                        code: 'validation',
                        message: 'Unknown field: repository_url.',
                        details: { field: 'repository_url' },
                    },
                    HttpStatus.BAD_REQUEST,
                ),
            );
            const answer = await create(
                { ...bearer(WRITE_TOKEN), 'Idempotency-Key': 'key-1' },
                { link_id: LINK, repository_url: 'https://github.com/x/y' },
            );
            expect(answer.status).toBe(400);
            // Not the pipe's own "property … should not exist" body.
            expect(answer.body).toEqual({
                status: 'error',
                code: 'validation',
                message: 'Unknown field: repository_url.',
                details: { field: 'repository_url' },
            });
            expect(apps.create.mock.calls[0][2]).toEqual({
                link_id: LINK,
                repository_url: 'https://github.com/x/y',
            });
        });

        it('starts a deployment for a delegated token with apps:write: 202 with its id', async () => {
            const answer = await deploy(bearer(WRITE_TOKEN), {
                link_id: LINK,
                environment: 'production',
            });
            expect(answer.status).toBe(202);
            expect(answer.body).toEqual({ deployment_id: 'deployment-1', status: 'accepted' });
            expect(answer.headers['cache-control']).toBe('no-store');
            expect(apps.deploy).toHaveBeenCalledWith(
                expect.objectContaining({ auth: expect.objectContaining({ userId: 'user-1' }) }),
                WORK,
                { link_id: LINK, environment: 'production' },
            );
        });

        it('passes on a refusal of the deploy service as it is', async () => {
            apps.deploy.mockRejectedValueOnce(
                new HttpException(
                    {
                        status: 'error',
                        code: 'APP_DEPLOY_PRECONDITIONS',
                        message: 'Choose where this App runs first.',
                        unmet: [
                            { code: 'no_target', message: 'Choose where this App runs first.' },
                        ],
                    },
                    HttpStatus.UNPROCESSABLE_ENTITY,
                ),
            );
            const answer = await deploy(bearer(WRITE_TOKEN));
            expect(answer.status).toBe(422);
            expect(answer.body).toMatchObject({
                code: 'APP_DEPLOY_PRECONDITIONS',
                unmet: [{ code: 'no_target' }],
            });
        });

        describe.each([
            ['create', () => create],
            ['deploy', () => deploy],
        ])('who is let through to %s', (_name, route) => {
            const call = (headers: Record<string, string>) =>
                route()({ ...headers, 'Idempotency-Key': 'key-1' });
            const reached = () => apps.create.mock.calls.length + apps.deploy.mock.calls.length;

            it('a token that may only read is refused: 403 insufficient_scope', async () => {
                const answer = await call(bearer(READ_TOKEN));
                expect(answer.status).toBe(403);
                expect(answer.body).toMatchObject({ status: 'error', code: 'insufficient_scope' });
                expect(reached()).toBe(0);
            });

            it('a valid token of a person with no account here: 403 no_linked_identity', async () => {
                const answer = await call(bearer(STRANGER_TOKEN));
                expect(answer.status).toBe(403);
                expect(answer.body).toMatchObject({ status: 'error', code: 'no_linked_identity' });
                expect(reached()).toBe(0);
            });

            it('a token that does not verify: the plain 401, and never the session path', async () => {
                const answer = await call(bearer(BAD_TOKEN));
                expect(answer.status).toBe(401);
                expect(answer.body).not.toHaveProperty('code');
                expect(authProvider.authenticate).not.toHaveBeenCalled();
                expect(reached()).toBe(0);
            });

            it('no credential at all: 401', async () => {
                const answer = await call({});
                expect(answer.status).toBe(401);
                expect(verifier.authenticate).not.toHaveBeenCalled();
                expect(reached()).toBe(0);
            });

            it("a person's own session is a session, and this route is not for it: 403 delegated_token_required", async () => {
                authProvider.authenticate.mockResolvedValue({ userId: 'user-1' });
                const answer = await call(bearer(SESSION));
                expect(answer.status).toBe(403);
                expect(answer.body).toMatchObject({
                    status: 'error',
                    code: 'delegated_token_required',
                });
                // The session was authenticated as it always is; the verifier was never asked.
                expect(authProvider.authenticate).toHaveBeenCalledTimes(1);
                expect(verifier.authenticate).not.toHaveBeenCalled();
                expect(reached()).toBe(0);
            });

            it('a token in the address is refused before anything else: 400 token_in_query', async () => {
                const path =
                    _name === 'create'
                        ? '/api/ever-connect/apps'
                        : `/api/ever-connect/apps/${WORK}/deploy`;
                const answer = await request(app.getHttpServer())
                    .post(`${path}?access_token=${WRITE_TOKEN}`)
                    .send({ link_id: LINK });
                expect(answer.status).toBe(400);
                expect(answer.body).toMatchObject({ code: 'token_in_query' });
                expect(verifier.authenticate).not.toHaveBeenCalled();
                expect(reached()).toBe(0);
            });
        });
    });
});
