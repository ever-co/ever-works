/**
 * `AuthSessionGuard` → `ApiKeyService` / Ever ID services reach better-auth's ESM through this
 * one file under api Jest. Nothing here builds an auth runtime: the bearer path the demo uses
 * (`Authorization: Bearer <token>` → `auth_sessions.tokenHash`) never touches it.
 */
jest.mock('../../auth/providers/auth-runtime.instance', () => ({
    createAuthRuntimeInstance: jest.fn(),
}));

import type { ExecutionContext } from '@nestjs/common';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { getMetadataStorage } from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ENTITIES, UserRepository } from '@ever-works/agent/database';
import { DemoFeatureDisabledError } from '@ever-works/agent/demo';
import { CreateWorkDto, QuickCreateWorkDto, UpdateWorkDto } from '@ever-works/agent/dto';
import { AuthSession, User } from '@ever-works/agent/entities';
import { UpdateProfileDto } from '../../auth/dto/update-profile.dto';
import {
    EnableUserPluginDto,
    EnableWorkPluginDto,
} from '../../plugins/dto/update-plugin-settings.dto';
import { UpdateSharedViewDto } from '../../shared-views/dto/shared-view.dto';
import { AuthSessionGuard } from '../../auth/guards/auth-session.guard';
import { AUTH_PROVIDER, AUTH_RUNTIME_INSTANCE } from '../../auth/providers/auth-provider.constants';
import { AuthProviderService, hashSessionToken } from '../../auth/providers/auth-provider.service';
import { AuthSyncService } from '../../auth/providers/auth-sync.service';
import { DEMO_BLOCKED_ROUTES } from '../demo-restrictions';
import { DemoRestrictionsGuard } from '../demo-restrictions.guard';

/**
 * Platform demo mode — the route guard (design §5.2.4 "Blocked in demo" and "Registration").
 *
 * `everyone` entries refuse every caller, signed in or not: nobody registers or mints an
 * anonymous user on a demo host (the only way in is `POST /api/auth/demo`). `demo-users`
 * entries refuse a caller whose account is a demo sandbox (`registrationProvider = 'demo'`)
 * and nobody else: the operators who run the instance keep every feature.
 */

type Request = {
    method: string;
    path?: string;
    url?: string;
    originalUrl?: string;
    headers?: Record<string, string>;
    body?: unknown;
    user?: { userId: string; username?: string };
};

function http(request: Request): ExecutionContext {
    return {
        getType: () => 'http',
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => ({}),
            getNext: () => undefined,
        }),
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
    } as unknown as ExecutionContext;
}

const DEMO_USER_ID = 'demo-user-id';
const OPERATOR_ID = 'operator-id';

/** A `UserRepository` that knows one demo user and one operator. */
function usersStub() {
    return {
        findById: jest.fn(async (id: string) => {
            if (id === DEMO_USER_ID) return { id, registrationProvider: 'demo' } as User;
            if (id === OPERATOR_ID) return { id, registrationProvider: 'local' } as User;
            return null;
        }),
    };
}

/** A `ModuleRef` with no `AUTH_PROVIDER` bound (Nest throws for an absent provider). */
const NO_AUTH_PROVIDER = {
    get: () => {
        throw new UnknownElementException('AUTH_PROVIDER');
    },
};

function guardWith(users = usersStub(), moduleRef: unknown = NO_AUTH_PROVIDER) {
    return {
        users,
        guard: new DemoRestrictionsGuard(users as unknown as UserRepository, moduleRef as never),
    };
}

const demoUser = { userId: DEMO_USER_ID };
const operator = { userId: OPERATOR_ID };

async function expectDisabled(promise: Promise<boolean>, feature: string): Promise<void> {
    const error = await promise.then(
        () => undefined,
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DemoFeatureDisabledError);
    expect(error).toMatchObject({ code: 'DEMO_DISABLED', httpStatus: 403, feature });
}

describe('DemoRestrictionsGuard', () => {
    describe('the table', () => {
        it('names at least 15 routes, each one anchored, case-insensitive, with a short feature', () => {
            expect(DEMO_BLOCKED_ROUTES.length).toBeGreaterThanOrEqual(15);
            for (const entry of DEMO_BLOCKED_ROUTES) {
                const label = `${entry.method} ${entry.path.source}`;
                // Express routes `/API/Auth/Register` to the register handler too.
                expect([label, entry.path.flags]).toEqual([label, 'i']);
                expect([label, entry.path.source.startsWith('^\\/api\\/')]).toEqual([label, true]);
                expect([label, entry.path.source.endsWith('$')]).toEqual([label, true]);
                expect(['demo-users', 'everyone']).toContain(entry.scope);
                expect(entry.feature.length).toBeGreaterThan(0);
                expect(entry.feature.length).toBeLessThanOrEqual(32);
            }
        });

        it('reads only body fields the DTOs behind those routes still declare', () => {
            // The validation pipe whitelists DTO fields: a `when` reading a field its DTO no
            // longer declares would watch for a request the API refuses anyway, and miss the new
            // field. Each pair is a field a `when` in `demo-restrictions.ts` reads.
            const declared = (dto: Function): Set<string> =>
                new Set(
                    getMetadataStorage()
                        .getTargetValidationMetadatas(dto, '', true, false)
                        .map((metadata) => metadata.propertyName),
                );
            const reads: [Function, string[]][] = [
                [CreateWorkDto, ['kind']],
                [QuickCreateWorkDto, ['kind']],
                [UpdateWorkDto, ['owner', 'organization']],
                [EnableUserPluginDto, ['settings', 'secretSettings']],
                [EnableWorkPluginDto, ['settings']],
                [
                    UpdateSharedViewDto,
                    ['status', 'sections', 'knowledgeClasses', 'searchIndexable'],
                ],
                [UpdateProfileDto, ['username']],
            ];
            for (const [dto, fields] of reads) {
                const names = declared(dto);
                for (const field of fields) {
                    expect([dto.name, field, names.has(field)]).toEqual([dto.name, field, true]);
                }
            }
        });

        it('blocks registration, magic link, social sign-in and anonymous users for everyone', () => {
            const everyone = DEMO_BLOCKED_ROUTES.filter((entry) => entry.scope === 'everyone');
            expect(new Set(everyone.map((entry) => entry.feature))).toEqual(
                new Set([
                    'registration',
                    'anonymous sign-in',
                    'magic link sign-in',
                    'social sign-in',
                    'GitHub App sign-in',
                    'Ever ID sign-in',
                    'anonymous uploads',
                ]),
            );
        });
    });

    describe('for a demo user', () => {
        it('refuses a plugin settings write with DEMO_DISABLED', async () => {
            const { guard } = guardWith();

            await expectDisabled(
                guard.canActivate(
                    http({
                        method: 'PATCH',
                        path: '/api/plugins/openrouter/settings',
                        user: demoUser,
                    }),
                ),
                'plugin settings',
            );
        });

        it('allows everything the table does not name (GET /api/works)', async () => {
            const { guard } = guardWith();

            await expect(
                guard.canActivate(http({ method: 'GET', path: '/api/works', user: demoUser })),
            ).resolves.toBe(true);
        });

        // R39: the web's assistant chat calls this route (`lib/ai/agent.ts`, `${API_URL}/v1`).
        // The AI facade already forces OpenRouter, a `:free` model and the quota on every call,
        // and a demo user cannot mint an API key, so the route stays open to the visitor.
        it('lets a chat completion through: the assistant chat calls it (R39)', async () => {
            const { guard } = guardWith();

            for (const stream of [true, false]) {
                await expect(
                    guard.canActivate(
                        http({
                            method: 'POST',
                            path: '/api/v1/chat/completions',
                            body: { model: 'auto', stream, messages: [] },
                            user: demoUser,
                        }),
                    ),
                ).resolves.toBe(true);
            }
        });

        it.each([
            ['PATCH', '/api/works/w-1/plugins/openrouter/settings', 'plugin settings'],
            ['POST', '/api/auth/api-keys', 'API keys'],
            ['POST', '/api/model-accounts/acc-1/credentials', 'model account credentials'],
            ['POST', '/api/webhooks', 'webhooks'],
            ['POST', '/api/mcp-connections', 'MCP connections'],
            ['GET', '/api/oauth/github/connect/url', 'connected accounts'],
            ['POST', '/api/deploy/works/w-1', 'deploy'],
            ['POST', '/api/deploy/works/w-1/domains', 'custom domains'],
            ['POST', '/api/auth/claim', 'account claim'],
            ['POST', '/api/auth/update-password', 'password change'],
            ['POST', '/api/account-deletion/me', 'account deletion'],
            ['POST', '/api/organizations/org-1/invitations', 'invitations by email'],
            ['POST', '/api/works/w-1/members', 'invitations by email'],
            ['POST', '/api/works/w-1/invitations', 'Work invitations and transfer'],
            ['POST', '/api/organizations/org-1/shared-view', 'public share link'],
            ['POST', '/api/organizations/org-1/shared-view/regenerate', 'public share link'],
            ['GET', '/api/account/export', 'data export'],
            ['PUT', '/api/fleet/runners/jobs/watched', 'plugin settings'],
            ['PUT', '/api/deploy/works/w-1/runtime-env', 'runtime environment'],
            ['PUT', '/api/deploy/works/w-1/subdomain', 'subdomains'],
            ['PUT', '/api/works/w-1/repositories/visibility', 'repository visibility'],
            ['POST', '/api/device-auth/codex/start', 'device sign-in'],
            ['GET', '/api/device-auth/codex/status', 'device sign-in'],
            ['POST', '/api/works/import', 'importing a repository'],
            [
                'POST',
                '/api/github-app/installations/inst-1/repositories/repo-1/onboard',
                'importing a repository',
            ],
            ['POST', '/api/templates/fork', 'copying a template repository'],
            ['POST', '/api/templates/custom-from-base', 'copying a template repository'],
            ['POST', '/api/account/import/preview', 'account import'],
            ['POST', '/api/account/import/apply', 'account import'],
            ['POST', '/api/organizations/import-company', 'company import'],
        ])('refuses %s %s (%s)', async (method, path, feature) => {
            const { guard } = guardWith();

            await expectDisabled(
                guard.canActivate(http({ method, path, user: demoUser })),
                feature,
            );
        });

        it('matches the path the way Express routes it: case, trailing slash, query, HEAD', async () => {
            const { guard } = guardWith();

            for (const request of [
                { method: 'patch', path: '/API/Plugins/openrouter/Settings' },
                { method: 'PATCH', path: '/api/plugins/openrouter/settings/' },
                { method: 'PATCH', url: '/api/plugins/openrouter/settings?scope=user' },
                { method: 'PATCH', originalUrl: '/api/plugins/openrouter/settings/?x=1' },
                // Express answers HEAD with the GET handler (which runs; the body is dropped).
                { method: 'HEAD', path: '/api/account/export' },
            ]) {
                const feature = request.method === 'HEAD' ? 'data export' : 'plugin settings';
                await expectDisabled(
                    guard.canActivate(http({ ...request, user: demoUser })),
                    feature,
                );
            }
        });

        it('refuses creating an App Work, and nothing else POST /api/works makes', async () => {
            const { guard } = guardWith();
            const create = (body: unknown, user = demoUser) =>
                guard.canActivate(http({ method: 'POST', path: '/api/works', body, user }));

            await expectDisabled(create({ name: 'My app', kind: 'app' }), 'App Works');
            await expectDisabled(create({ name: 'My app', kind: ' APP ' }), 'App Works');
            await expect(create({ name: 'Tools', kind: 'directory' })).resolves.toBe(true);
            await expect(create({ name: 'Tools' })).resolves.toBe(true);
            await expect(create({ name: 'Mine', kind: 'app' }, operator)).resolves.toBe(true);

            const quick = (body: unknown) =>
                guard.canActivate(
                    http({ method: 'POST', path: '/api/works/quick-create', body, user: demoUser }),
                );
            await expectDisabled(quick({ prompt: 'x', kind: 'app' }), 'App Works');
            await expect(quick({ prompt: 'x', kind: 'directory' })).resolves.toBe(true);
        });

        it("refuses naming a Work's repository owner, not a plain settings save", async () => {
            const { guard } = guardWith();
            const save = (method: string, body: unknown) =>
                guard.canActivate(http({ method, path: '/api/works/w-1', body, user: demoUser }));

            await expectDisabled(save('PUT', { owner: 'acme' }), 'Work repository owner');
            await expectDisabled(save('PATCH', { organization: true }), 'Work repository owner');
            // What the web sends for a Work whose owner is not being chosen.
            await expect(save('PUT', { name: 'Renamed', organization: false })).resolves.toBe(true);
            await expect(save('PATCH', { description: 'x', owner: '  ' })).resolves.toBe(true);
        });

        it('refuses an enable that writes settings (BYOK), not a plain enable', async () => {
            const { guard } = guardWith();
            const enable = (path: string, body: unknown, user = demoUser) =>
                guard.canActivate(http({ method: 'POST', path, body, user }));

            for (const path of [
                '/api/plugins/openrouter/enable',
                '/api/works/w-1/plugins/openrouter/enable',
            ]) {
                await expectDisabled(
                    enable(path, { secretSettings: { apiKey: 'sk-own' } }),
                    'plugin settings',
                );
                await expectDisabled(enable(path, { settings: { model: 'x' } }), 'plugin settings');
                await expect(enable(path, {})).resolves.toBe(true);
                await expect(
                    enable(path, { settings: {}, autoEnableForWorks: true }),
                ).resolves.toBe(true);
                await expect(
                    enable(path, { secretSettings: { apiKey: 'sk-own' } }, operator),
                ).resolves.toBe(true);
            }
        });

        it('refuses every Work invitation: a mailed one, and an owner-claim link (R37)', async () => {
            const { guard } = guardWith();
            const invite = (body: unknown, user = demoUser) =>
                guard.canActivate(
                    http({ method: 'POST', path: '/api/works/w-1/invitations', body, user }),
                );
            const ownerClaim = { role: 'owner-claim', metadata: { expectedProviderUsername: 'x' } };

            // Redeeming an owner-claim link moves the Work's repositories to the redeemer's git
            // login: out of the demo org and out of the sweeper's reach.
            await expectDisabled(invite(ownerClaim), 'Work invitations and transfer');
            await expectDisabled(
                invite({ ...ownerClaim, expectedProviderUsername: 'x', email: 'a@example.com' }),
                'Work invitations and transfer',
            );
            await expectDisabled(
                invite({ email: 'someone@example.com', role: 'editor' }),
                'Work invitations and transfer',
            );
            // An operator issues both as before.
            await expect(invite(ownerClaim, operator)).resolves.toBe(true);
            await expect(
                invite({ email: 'someone@example.com', role: 'editor' }, operator),
            ).resolves.toBe(true);
        });

        it('refuses publishing a share link, not turning it off, deleting or reading it (R38)', async () => {
            const { guard } = guardWith();
            const call = (method: string, path: string, body?: unknown, user = demoUser) =>
                guard.canActivate(http({ method, path, body, user }));
            const view = '/api/organizations/org-1/shared-view';

            await expectDisabled(call('POST', view, {}), 'public share link');
            await expectDisabled(call('POST', `${view}/regenerate`, {}), 'public share link');
            for (const publishes of [
                { status: 'active' },
                { status: 'paused', sections: { board: true } },
                { sections: { knowledge: true } },
                { knowledgeClasses: ['guide'] },
                { searchIndexable: true },
                // Not spelled out as "off": fail closed.
                { status: null },
                { sections: null },
                { knowledgeClasses: 'guide' },
                { searchIndexable: 'yes' },
            ]) {
                await expectDisabled(call('PATCH', view, publishes), 'public share link');
            }

            for (const unpublishes of [
                { status: 'paused' },
                { sections: { board: false, knowledge: false } },
                { knowledgeClasses: [] },
                { searchIndexable: false },
                { status: 'paused', sections: { board: false }, searchIndexable: false },
                {},
            ]) {
                await expect(call('PATCH', view, unpublishes)).resolves.toBe(true);
            }
            await expect(call('DELETE', view)).resolves.toBe(true);
            await expect(call('GET', view)).resolves.toBe(true);
            await expect(call('GET', `${view}/preview`)).resolves.toBe(true);

            // An operator publishes as before.
            await expect(call('POST', view, {}, operator)).resolves.toBe(true);
            await expect(call('POST', `${view}/regenerate`, {}, operator)).resolves.toBe(true);
            await expect(call('PATCH', view, { status: 'active' }, operator)).resolves.toBe(true);
        });

        it('refuses a profile save that changes the username, not one that keeps it', async () => {
            const { guard } = guardWith();
            const save = (body: unknown, user: Request['user']) =>
                guard.canActivate(http({ method: 'PUT', path: '/api/auth/profile', body, user }));
            const signedIn = { ...demoUser, username: 'demo-0a1b2c3d' };

            await expectDisabled(save({ username: 'renamed' }, signedIn), 'username change');
            await expect(
                save({ username: 'demo-0a1b2c3d', displayName: 'Me' }, signedIn),
            ).resolves.toBe(true);
            await expect(save({ displayName: 'Me' }, signedIn)).resolves.toBe(true);
            await expect(
                save({ username: 'renamed' }, { ...operator, username: 'operator' }),
            ).resolves.toBe(true);
        });

        it('reads the account once a minute, and only for a route the table names', async () => {
            const { guard, users } = guardWith();
            const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
            try {
                const write = () =>
                    guard.canActivate(
                        http({ method: 'POST', path: '/api/webhooks', user: demoUser }),
                    );

                await guard.canActivate(
                    http({ method: 'GET', path: '/api/works', user: demoUser }),
                );
                expect(users.findById).not.toHaveBeenCalled();

                await expectDisabled(write(), 'webhooks');
                await expectDisabled(write(), 'webhooks');
                expect(users.findById).toHaveBeenCalledTimes(1);

                now.mockReturnValue(1_000_000 + 60_000);
                await expectDisabled(write(), 'webhooks');
                expect(users.findById).toHaveBeenCalledTimes(2);
                expect(users.findById).toHaveBeenCalledWith(DEMO_USER_ID);
            } finally {
                now.mockRestore();
            }
        });

        it('keeps 1,000 accounts at most, dropping the one written longest ago', async () => {
            const { guard, users } = guardWith();
            const write = (userId: string) =>
                guard.canActivate(
                    http({ method: 'POST', path: '/api/webhooks', user: { userId } }),
                );

            await expectDisabled(write(DEMO_USER_ID), 'webhooks');
            for (let index = 0; index < 999; index += 1) await write(`other-${index}`);
            // Read from the cache: a hit does not move an entry.
            await expectDisabled(write(DEMO_USER_ID), 'webhooks');
            expect(users.findById).toHaveBeenCalledTimes(1_000);

            await write('one-more'); // 1,001st account: the first one written goes.
            await expectDisabled(write(DEMO_USER_ID), 'webhooks');
            expect(users.findById).toHaveBeenCalledTimes(1_002);
            expect(users.findById).toHaveBeenLastCalledWith(DEMO_USER_ID);
        });
    });

    describe('for an operator (a non-demo account)', () => {
        it('allows a plugin settings write', async () => {
            const { guard } = guardWith();

            await expect(
                guard.canActivate(
                    http({
                        method: 'PATCH',
                        path: '/api/plugins/openrouter/settings',
                        user: operator,
                    }),
                ),
            ).resolves.toBe(true);
        });

        it('allows every demo-users entry, and signing in', async () => {
            const { guard } = guardWith();

            for (const [method, path] of [
                ['POST', '/api/auth/api-keys'],
                ['GET', '/api/oauth/github/connect/url'],
                ['GET', '/api/oauth/github/callback/plugins'],
                ['POST', '/api/deploy/works/w-1'],
                ['POST', '/api/works/import'],
                ['POST', '/api/templates/fork'],
                ['POST', '/api/account/import/apply'],
                ['POST', '/api/organizations/import-company'],
                ['POST', '/api/works/w-1/invitations'],
                ['POST', '/api/organizations/org-1/shared-view'],
                ['POST', '/api/organizations/org-1/shared-view/regenerate'],
                ['POST', '/api/v1/chat/completions'],
                ['POST', '/api/auth/login'],
            ]) {
                await expect(
                    guard.canActivate(http({ method, path, user: operator })),
                ).resolves.toBe(true);
            }
        });
    });

    describe('for everyone', () => {
        it('refuses POST /api/auth/register, signed in or not', async () => {
            const { guard, users } = guardWith();

            await expectDisabled(
                guard.canActivate(http({ method: 'POST', path: '/api/auth/register' })),
                'registration',
            );
            await expectDisabled(
                guard.canActivate(
                    http({ method: 'POST', path: '/api/auth/register', user: operator }),
                ),
                'registration',
            );
            // An `everyone` entry never needs to know who is asking.
            expect(users.findById).not.toHaveBeenCalled();
        });

        it.each([
            // Zero-friction registration: an account (`registrationProvider: 'github'`) + a Work.
            ['POST', '/api/register-work', 'registration'],
            ['POST', '/api/auth/anonymous', 'anonymous sign-in'],
            ['POST', '/api/auth/magic-link', 'magic link sign-in'],
            ['POST', '/api/auth/magic-link/redeem', 'magic link sign-in'],
            ['GET', '/api/oauth/github/url', 'social sign-in'],
            ['GET', '/api/oauth/google/callback', 'social sign-in'],
            ['GET', '/api/github-app/setup', 'GitHub App sign-in'],
            ['GET', '/api/github-app/callback', 'GitHub App sign-in'],
            ['POST', '/api/auth/ever-id/authorize', 'Ever ID sign-in'],
            ['POST', '/api/auth/ever-id/sign-up/confirm', 'Ever ID sign-in'],
            // A device token exchanged for a session.
            ['POST', '/api/auth/ever-id/session', 'Ever ID sign-in'],
            ['POST', '/api/uploads/anonymous', 'anonymous uploads'],
            ['POST', '/api/uploads/anonymous/file', 'anonymous uploads'],
        ])('refuses %s %s (%s)', async (method, path, feature) => {
            const { guard } = guardWith();

            await expectDisabled(guard.canActivate(http({ method, path })), feature);
        });

        it('refuses a presigned upload only when it would mint an anonymous user', async () => {
            const { guard } = guardWith();

            await expectDisabled(
                guard.canActivate(http({ method: 'POST', path: '/api/uploads/presign' })),
                'anonymous uploads',
            );
            await expect(
                guard.canActivate(
                    http({
                        method: 'POST',
                        path: '/api/uploads/presign',
                        headers: { authorization: 'Bearer some-session' },
                        user: operator,
                    }),
                ),
            ).resolves.toBe(true);
        });

        it('keeps the way in open: POST /api/auth/demo and POST /api/auth/login', async () => {
            const { guard } = guardWith();

            for (const path of ['/api/auth/demo', '/api/auth/login']) {
                await expect(guard.canActivate(http({ method: 'POST', path }))).resolves.toBe(true);
            }
        });
    });

    it('passes a non-HTTP context through untouched', async () => {
        const { guard } = guardWith();
        const context = { getType: () => 'ws' } as unknown as ExecutionContext;

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    /**
     * Nest runs `APP_GUARD`s in module-scan order, and `DemoModule` is not the module that
     * registers `AuthSessionGuard`. `demo-restrictions.routes.spec.ts` pins that, in the API's
     * real graph, the session guard comes first; this block proves the guard does not depend
     * on it: a demo sandbox's real bearer — a session row exactly like the one
     * `DemoSandboxService` writes — is recognised before the session guard has run and after.
     */
    describe("a demo sandbox's real bearer token", () => {
        let moduleRef: TestingModule;
        let dataSource: DataSource;
        let demoToken: string;
        let operatorToken: string;

        async function sessionFor(user: User): Promise<string> {
            const raw = randomBytes(32).toString('base64url');
            await dataSource.getRepository(AuthSession).save({
                id: randomUUID(),
                userId: user.id,
                token: null,
                tokenHash: hashSessionToken(raw),
                expiresAt: new Date(Date.now() + 3_600_000),
                ipAddress: null,
                userAgent: null,
            });
            return raw;
        }

        beforeAll(async () => {
            moduleRef = await Test.createTestingModule({
                imports: [
                    TypeOrmModule.forRoot({
                        type: 'better-sqlite3',
                        database: ':memory:',
                        entities: ENTITIES,
                        synchronize: true,
                    }),
                    TypeOrmModule.forFeature([User, AuthSession]),
                ],
                providers: [
                    UserRepository,
                    AuthProviderService,
                    { provide: AUTH_PROVIDER, useExisting: AuthProviderService },
                    // The cookie path; a bearer never reaches it.
                    { provide: AUTH_RUNTIME_INSTANCE, useValue: { api: {} } },
                    { provide: AuthSyncService, useValue: {} },
                    AuthSessionGuard,
                    DemoRestrictionsGuard,
                ],
            }).compile();
            dataSource = moduleRef.get<DataSource>(getDataSourceToken());
            const users = moduleRef.get(UserRepository);

            // The row `DemoSandboxService.createSandbox` writes.
            const sandbox = await users.create({
                username: 'demo-0a1b2c3d',
                slug: 'demo-0a1b2c3d',
                displayName: 'Demo User',
                email: null,
                password: null,
                isAnonymous: true,
                anonymousExpiresAt: new Date(Date.now() + 24 * 3_600_000),
                registrationProvider: 'demo',
                emailVerified: false,
                isActive: true,
            } as Partial<User>);
            const owner = await users.create({
                username: 'operator',
                slug: 'operator',
                email: 'ops@example.com',
                registrationProvider: 'local',
                emailVerified: true,
                isActive: true,
            } as Partial<User>);
            demoToken = await sessionFor(sandbox);
            operatorToken = await sessionFor(owner);
        });

        afterAll(async () => {
            await moduleRef?.close();
        });

        const settingsWrite = (token: string): Request => ({
            method: 'PATCH',
            path: '/api/plugins/openrouter/settings',
            url: '/api/plugins/openrouter/settings',
            headers: { authorization: `Bearer ${token}` },
        });

        it('is recognised before the session guard has run (no req.user yet)', async () => {
            const guard = moduleRef.get(DemoRestrictionsGuard);

            await expectDisabled(
                guard.canActivate(http(settingsWrite(demoToken))),
                'plugin settings',
            );
            await expect(guard.canActivate(http(settingsWrite(operatorToken)))).resolves.toBe(true);
        });

        it('is recognised after the session guard has put the user on the request', async () => {
            const sessionGuard = moduleRef.get(AuthSessionGuard);
            const guard = moduleRef.get(DemoRestrictionsGuard);

            const demoRequest = settingsWrite(demoToken);
            await expect(sessionGuard.canActivate(http(demoRequest))).resolves.toBe(true);
            expect(demoRequest.user).toMatchObject({ provider: 'demo', authMethod: 'session' });
            await expectDisabled(guard.canActivate(http(demoRequest)), 'plugin settings');

            const operatorRequest = settingsWrite(operatorToken);
            await expect(sessionGuard.canActivate(http(operatorRequest))).resolves.toBe(true);
            await expect(guard.canActivate(http(operatorRequest))).resolves.toBe(true);
        });

        it('lets an unknown bearer through to the session guard, which answers 401', async () => {
            const guard = moduleRef.get(DemoRestrictionsGuard);

            await expect(guard.canActivate(http(settingsWrite('not-a-session')))).resolves.toBe(
                true,
            );
        });
    });
});
