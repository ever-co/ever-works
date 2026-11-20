import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UserRepository } from '@ever-works/agent/database';
import { DemoFeatureDisabledError } from '@ever-works/agent/demo';
import { getOptionalProvider } from '@ever-works/agent/utils';
import type { AuthProvider } from '../auth/providers/auth-provider.abstract';
import { AUTH_PROVIDER } from '../auth/providers/auth-provider.constants';
import { toHeaders } from '../auth/providers/request-headers';
import {
    DEMO_BLOCKED_ROUTES,
    type DemoBlockedRoute,
    type DemoRouteRequest,
} from './demo-restrictions';

/** How long a user's "is a demo sandbox" answer is reused before the row is read again. */
const DEMO_USER_CACHE_MS = 60_000;
/**
 * Bound on that per-user cache. Entries keep the order they were written in (a row read from the
 * database is written again, at the end); the one written longest ago goes first.
 */
const DEMO_USER_CACHE_MAX = 1_000;

/** The parts of an Express request the guard reads (`user` is in `DemoRouteRequest`). */
export interface DemoGuardedRequest extends DemoRouteRequest {
    readonly method?: unknown;
    readonly path?: unknown;
    readonly originalUrl?: unknown;
    readonly url?: unknown;
}

/**
 * Platform demo mode (`DEMO=true`) — refuses the routes `DEMO_BLOCKED_ROUTES` names with
 * `DemoFeatureDisabledError` (`DEMO_DISABLED`, 403, rendered by `DemoErrorFilter`). Registered
 * as an `APP_GUARD` by `DemoModule` only when the demo is on.
 *
 * A request no row names passes at once, with no lookup. An `everyone` row refuses whoever asks.
 * A `demo-users` row refuses a caller whose account has `registrationProvider = 'demo'`, read
 * with `UserRepository.findById` (the session's `provider` is not trusted for it: an
 * integration key acting for someone carries its owner's) and cached for 60 s per user.
 *
 * Who the caller is: `req.user`, which `AuthSessionGuard` sets. Nest runs global guards in
 * module-scan order and the API root registers the session guard before it imports this module,
 * so in the API it has already run (`demo-restrictions.routes.spec.ts` pins that). The guard
 * does not depend on it: with no `req.user` it resolves the caller from the request's session
 * through the same `AUTH_PROVIDER.authenticate` lookup, so a demo sandbox's bearer is recognised
 * in either order, and on a `@Public()` route, where the session guard sets no user.
 */
@Injectable()
export class DemoRestrictionsGuard implements CanActivate {
    private readonly demoUsers = new Map<string, { isDemo: boolean; readAt: number }>();
    private authProvider: AuthProvider | null | undefined;

    constructor(
        private readonly users: UserRepository,
        private readonly moduleRef: ModuleRef,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== 'http') return true;
        const request = context.switchToHttp().getRequest<DemoGuardedRequest>();

        const blocked = findDemoBlockedRoutes(request);
        if (blocked.length === 0) return true;

        const forEveryone = blocked.find((entry) => entry.scope === 'everyone');
        if (forEveryone) throw new DemoFeatureDisabledError(forEveryone.feature);

        if (await this.isDemoUser(request)) throw new DemoFeatureDisabledError(blocked[0].feature);
        return true;
    }

    private async isDemoUser(request: DemoGuardedRequest): Promise<boolean> {
        const signedIn = request.user?.userId;
        const userId =
            typeof signedIn === 'string' && signedIn ? signedIn : await this.sessionUserId(request);
        if (!userId) return false;

        const cached = this.demoUsers.get(userId);
        if (cached && Date.now() - cached.readAt < DEMO_USER_CACHE_MS) return cached.isDemo;

        const user = await this.users.findById(userId);
        const isDemo = user?.registrationProvider === 'demo';

        this.demoUsers.delete(userId);
        if (this.demoUsers.size >= DEMO_USER_CACHE_MAX) {
            const oldest = this.demoUsers.keys().next().value;
            if (oldest !== undefined) this.demoUsers.delete(oldest);
        }
        this.demoUsers.set(userId, { isDemo, readAt: Date.now() });
        return isDemo;
    }

    /**
     * The caller of a request `AuthSessionGuard` has not resolved (yet): the session lookup it
     * uses. Anything it refuses is "no caller" here; refusing is the session guard's answer.
     */
    private async sessionUserId(request: DemoGuardedRequest): Promise<string | undefined> {
        if (this.authProvider === undefined) {
            this.authProvider =
                getOptionalProvider<AuthProvider>(this.moduleRef, AUTH_PROVIDER) ?? null;
        }
        if (!this.authProvider) return undefined;
        try {
            const user = await this.authProvider.authenticate(
                toHeaders((request.headers ?? {}) as Record<string, string | string[] | undefined>),
            );
            return user?.userId || undefined;
        } catch {
            return undefined;
        }
    }
}

/** The rows of `DEMO_BLOCKED_ROUTES` that apply to the request (its method, path and `when`). */
export function findDemoBlockedRoutes(request: DemoGuardedRequest): DemoBlockedRoute[] {
    const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
    // Express answers HEAD with the GET handler.
    const verb = method === 'HEAD' ? 'GET' : method;
    const path = requestPathOf(request);
    return DEMO_BLOCKED_ROUTES.filter(
        (entry) =>
            (entry.method === '*' || entry.method === verb) &&
            entry.path.test(path) &&
            (!entry.when || entry.when(request)),
    );
}

/**
 * The path Express routes: `req.path` (its parsed pathname, which its router matches), else the
 * pathname of `originalUrl` / `url`; trailing slashes dropped (Express routing ignores one).
 */
export function requestPathOf(request: DemoGuardedRequest): string {
    let path = typeof request.path === 'string' ? request.path : undefined;
    if (path === undefined) {
        const raw =
            typeof request.originalUrl === 'string'
                ? request.originalUrl
                : typeof request.url === 'string'
                  ? request.url
                  : '';
        path = pathnameOf(raw);
    }
    return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

function pathnameOf(raw: string): string {
    if (raw.startsWith('/')) return raw.split(/[?#]/, 1)[0];
    try {
        return new URL(raw).pathname;
    } catch {
        return raw.split(/[?#]/, 1)[0];
    }
}
