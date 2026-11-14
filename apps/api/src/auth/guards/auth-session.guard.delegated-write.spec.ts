jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/fleet', () => ({
    FleetRunCredentialService: class FleetRunCredentialService {},
}));

import 'reflect-metadata';
import {
    Controller,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Post,
    UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ModuleRef, Reflector } from '@nestjs/core';
import { AuthSessionGuard } from './auth-session.guard';
import {
    DELEGATED_READ_ORIGINS,
    DELEGATED_READ_SCOPE,
    DelegatedRead,
} from '../decorators/delegated-read.decorator';
import { DELEGATED_WRITE, DelegatedWrite } from '../decorators/delegated-write.decorator';
import { EVER_ID_DELEGATION_VERIFIER, EVER_ID_SIGNED_OUT_PROBE } from './ever-id-guard.tokens';
import { NO_TOKEN_IN_QUERY, NoTokenInQueryGuard } from './no-token-in-query.guard';
import { EverIdHttpException } from '../services/ever-id-errors';
import {
    DELEGATED_TOKEN_REQUIRED_CODE,
    DelegatedPrincipalGuard,
} from './delegated-principal.guard';

/**
 * The delegated write: a handler marked `@DelegatedWrite('apps:write')` takes
 * the delegated branch of `AuthSessionGuard` with a write scope. What is pinned
 * here: the mark asks the verifier for the write scope (so a token that may
 * only read is refused), a session and an API key are not affected by it, a
 * read handler is still asked exactly as before, and a route that takes a
 * delegated token only refuses every other caller.
 */
const JWT = 'aaaa.bbbb.cccc';
const WRITE = { [DELEGATED_READ_SCOPE]: 'apps:write', [DELEGATED_WRITE]: true };

function createContext(request: unknown): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => function handler() {},
        getClass: () => class Ctrl {},
    } as unknown as ExecutionContext;
}

function createGuard(options: {
    metadata?: Record<string, unknown>;
    providerUser?: unknown;
    delegation?: { authenticate: jest.Mock } | null;
}) {
    const reflector = {
        getAllAndOverride: jest.fn((key: string) => options.metadata?.[key]),
    } as unknown as jest.Mocked<Reflector>;
    const delegation =
        options.delegation === undefined ? { authenticate: jest.fn() } : options.delegation;
    const moduleRef = {
        get: jest.fn((token: unknown) => {
            if (token === EVER_ID_DELEGATION_VERIFIER && delegation) return delegation;
            if (token === EVER_ID_SIGNED_OUT_PROBE) return { wasSignedOut: async () => false };
            throw new Error(`Unexpected token: ${String(token)}`);
        }),
    } as unknown as jest.Mocked<ModuleRef>;
    const authProvider = {
        authenticate: jest.fn().mockResolvedValue(options.providerUser ?? null),
    };
    const guard = new AuthSessionGuard(reflector, moduleRef, authProvider as never);
    return { guard, delegation, authProvider };
}

const principal = (scopes: string[]) => ({
    user: { userId: 'u1', authMethod: 'ever-id-delegated' },
    binding: { identityId: 'i1', clientId: 'app-ever-co', scopes },
});

describe('AuthSessionGuard — the delegated write', () => {
    it('admits a token with the write scope and stamps ever-id-delegated', async () => {
        const admitted = principal(['apps:read', 'apps:write']);
        const delegation = { authenticate: jest.fn().mockResolvedValue(admitted) };
        const { guard, authProvider } = createGuard({ metadata: WRITE, delegation });
        const request: Record<string, unknown> = {
            headers: { authorization: `Bearer ${JWT}`, 'user-agent': 'ever-app/1' },
            ip: '203.0.113.7',
        };

        await expect(guard.canActivate(createContext(request))).resolves.toBe(true);

        // The write scope, and that this is a write: nothing else differs from a read.
        expect(delegation.authenticate).toHaveBeenCalledWith(
            JWT,
            'apps:write',
            { ipAddress: '203.0.113.7', userAgent: 'ever-app/1' },
            { access: 'write' },
        );
        expect(request.user).toEqual(admitted.user);
        expect(request.everIdDelegation).toEqual(admitted.binding);
        // Never the session path: a delegated token opens no session.
        expect(authProvider.authenticate).not.toHaveBeenCalled();
    });

    it('refuses a token without the write scope (one that may only read) with 403 insufficient_scope', async () => {
        // What the verifier answers when the token does not carry the scope it was asked for.
        const delegation = {
            authenticate: jest.fn(async (_token: string, scope: string) => {
                const carried = ['apps:read'];
                if (!carried.includes(scope)) throw new EverIdHttpException('insufficientScope');
                return principal(carried);
            }),
        };
        const { guard, authProvider } = createGuard({ metadata: WRITE, delegation });
        const request: Record<string, unknown> = { headers: { authorization: `Bearer ${JWT}` } };

        const refusal = guard.canActivate(createContext(request));
        await expect(refusal).rejects.toBeInstanceOf(EverIdHttpException);
        await expect(refusal).rejects.toMatchObject({
            status: 403,
            response: { status: 'error', code: 'insufficient_scope' },
        });
        expect(request.user).toBeUndefined();
        expect(request.everIdDelegation).toBeUndefined();
        expect(authProvider.authenticate).not.toHaveBeenCalled();
    });

    it('passes on 403 no_linked_identity: a valid token whose person has no account here', async () => {
        const refusal = new HttpException(
            { status: 'error', code: 'no_linked_identity', message: 'x' },
            HttpStatus.FORBIDDEN,
        );
        const delegation = { authenticate: jest.fn().mockRejectedValue(refusal) };
        const { guard } = createGuard({ metadata: WRITE, delegation });

        await expect(
            guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
        ).rejects.toBe(refusal);
    });

    it('answers the plain 401 for a token that does not verify, and never falls back to the session path', async () => {
        const delegation = { authenticate: jest.fn().mockResolvedValue(null) };
        const { guard, authProvider } = createGuard({ metadata: WRITE, delegation });

        await expect(
            guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(authProvider.authenticate).not.toHaveBeenCalled();
    });

    it('answers 401 when no verifier is bound (Ever ID is not part of this installation)', async () => {
        const { guard } = createGuard({ metadata: WRITE, delegation: null });

        await expect(
            guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a token in the query string before anything else', async () => {
        const { guard, delegation } = createGuard({
            metadata: { ...WRITE, [NO_TOKEN_IN_QUERY]: true },
        });

        await expect(
            guard.canActivate(
                createContext({
                    url: '/api/ever-connect/apps?access_token=x',
                    query: { access_token: 'x' },
                    headers: {},
                }),
            ),
        ).rejects.toMatchObject({ status: 400, response: { code: 'token_in_query' } });
        expect(delegation!.authenticate).not.toHaveBeenCalled();
    });

    it('honours an origin rule exactly as a read does: refused before the token is read', async () => {
        const delegation = {
            authenticate: jest.fn().mockResolvedValue(principal(['apps:write'])),
        };
        const { guard } = createGuard({
            metadata: { ...WRITE, [DELEGATED_READ_ORIGINS]: () => ['https://app.ever.co'] },
            delegation,
        });

        await expect(
            guard.canActivate(
                createContext({
                    headers: { authorization: `Bearer ${JWT}`, origin: 'https://unlisted.example' },
                }),
            ),
        ).rejects.toMatchObject({ status: 403, response: { code: 'origin_not_allowed' } });
        expect(delegation.authenticate).not.toHaveBeenCalled();
    });

    describe('everything else is as it was', () => {
        it('a session on a write handler is a session: the verifier is never asked', async () => {
            const user = { userId: 'u1', iss: 'auth-runtime' };
            const { guard, delegation, authProvider } = createGuard({
                metadata: WRITE,
                providerUser: user,
            });
            const request: Record<string, unknown> = {
                headers: { authorization: 'Bearer opaque-session-token' },
            };

            await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
            expect(delegation!.authenticate).not.toHaveBeenCalled();
            expect(authProvider.authenticate).toHaveBeenCalledTimes(1);
            expect(request.user).toEqual({ ...user, authMethod: 'session' });
            expect(request.everIdDelegation).toBeUndefined();
        });

        it('a cookie session (no bearer at all) on a write handler is a session', async () => {
            const user = { userId: 'u1', iss: 'auth-runtime' };
            const { guard, delegation } = createGuard({ metadata: WRITE, providerUser: user });
            const request: Record<string, unknown> = { headers: { cookie: 'session=abc' } };

            await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
            expect(delegation!.authenticate).not.toHaveBeenCalled();
            expect((request.user as { authMethod: string }).authMethod).toBe('session');
        });

        it('no credential on a write handler is the plain 401', async () => {
            const { guard, delegation } = createGuard({ metadata: WRITE });

            await expect(guard.canActivate(createContext({ headers: {} }))).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
            expect(delegation!.authenticate).not.toHaveBeenCalled();
        });

        it('a write token on a handler without the mark is refused like any invalid credential', async () => {
            const { guard, delegation } = createGuard({});

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(delegation!.authenticate).not.toHaveBeenCalled();
        });

        it('a read handler is asked exactly as before: the read scope, and no fourth argument', async () => {
            const delegation = {
                authenticate: jest.fn().mockResolvedValue(principal(['apps:read'])),
            };
            const { guard } = createGuard({
                metadata: { [DELEGATED_READ_SCOPE]: 'apps:read' },
                delegation,
            });

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).resolves.toBe(true);
            expect(delegation.authenticate.mock.calls[0]).toEqual([
                JWT,
                'apps:read',
                { ipAddress: null, userAgent: null },
            ]);
        });
    });
});

describe('@DelegatedWrite', () => {
    @Controller('x')
    class Marked {
        @Post('write')
        @DelegatedWrite('apps:write')
        write() {
            return 'x';
        }

        @Post('write-from')
        @DelegatedWrite('apps:write', { allowedOrigins: () => ['https://app.ever.co'] })
        writeFrom() {
            return 'x';
        }

        @Post('read')
        @DelegatedRead('apps:read')
        read() {
            return 'x';
        }

        @Post('plain')
        plain() {
            return 'x';
        }
    }
    const meta = (key: string, name: keyof Marked) =>
        Reflect.getMetadata(key, Marked.prototype[name]);

    it('names the write scope under the key the guard reads, and says it is a write', () => {
        expect(meta(DELEGATED_READ_SCOPE, 'write')).toBe('apps:write');
        expect(meta(DELEGATED_WRITE, 'write')).toBe(true);
        expect(meta(NO_TOKEN_IN_QUERY, 'write')).toBe(true);
        expect(meta(GUARDS_METADATA, 'write')).toEqual([NoTokenInQueryGuard]);
        expect(meta(DELEGATED_READ_ORIGINS, 'write')).toBeUndefined();
        expect(meta(DELEGATED_READ_ORIGINS, 'writeFrom')()).toEqual(['https://app.ever.co']);
    });

    it('leaves a read handler and an unmarked handler as they were', () => {
        expect(meta(DELEGATED_READ_SCOPE, 'read')).toBe('apps:read');
        expect(meta(DELEGATED_WRITE, 'read')).toBeUndefined();
        expect(meta(DELEGATED_READ_SCOPE, 'plain')).toBeUndefined();
        expect(meta(DELEGATED_WRITE, 'plain')).toBeUndefined();
    });
});

describe('DelegatedPrincipalGuard', () => {
    const guard = new DelegatedPrincipalGuard();
    const run = (request: unknown) => guard.canActivate(createContext(request));

    it('admits a delegated principal', () => {
        expect(
            run({ user: principal(['apps:write']).user, everIdDelegation: { scopes: [] } }),
        ).toBe(true);
    });

    it.each([
        ['a session', { user: { userId: 'u1', authMethod: 'session' } }],
        [
            'a personal API key or a fleet-run token',
            { user: { userId: 'u1', authMethod: 'api-key' } },
        ],
        ['an integration key', { user: { userId: 'u1', authMethod: 'integration' } }],
        ['a principal without a stamp', { user: { userId: 'u1' } }],
        // The stamp alone, without what the guard leaves on the request, is not enough.
        [
            'a stamp without the delegation',
            { user: { userId: 'u1', authMethod: 'ever-id-delegated' } },
        ],
        ['nobody', {}],
    ])('refuses %s with 403 delegated_token_required', (_name, request) => {
        try {
            run(request);
            throw new Error('expected a refusal');
        } catch (error) {
            expect(error).toBeInstanceOf(HttpException);
            expect((error as HttpException).getStatus()).toBe(403);
            expect((error as HttpException).getResponse()).toMatchObject({
                status: 'error',
                code: DELEGATED_TOKEN_REQUIRED_CODE,
            });
        }
    });
});
