import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    API_SRC,
    readApiGraphChildRequest,
    runApiGraphChild,
} from '../../__tests__/api-graph-child.helper-spec';
// Types only at the top: the child `require`s this file before it imports `ApiModule`, and
// must load the API graph in the API's own order. The spec side loads the values itself.
import type { DemoBlockedRoute } from '../demo-restrictions';

/**
 * # Does every row of the demo's blocked-route table name a route the API really serves?
 *
 * `DEMO_BLOCKED_ROUTES` is matched against request paths, so a row whose pattern drifts from
 * its controller (a renamed segment, a moved controller) blocks nothing and fails silently.
 * This spec checks the table against the routes the API registers with `DEMO=true`, and that
 * the guard runs after the session guard that puts the caller on the request.
 *
 * ## How the routes are collected, and why a child process
 *
 * Importing `ApiModule` under this app's jest does not work (`api-graph-child.helper-spec.ts`
 * explains why), so the spec runs itself in a child `node` process with that helper's loader
 * — the one `app-works-di-reachability.spec.ts` uses — which imports the real `ApiModule`
 * with `DEMO=true`.
 *
 * There it runs Nest's own `DependenciesScanner.scan(ApiModule)` — the scan `NestFactory.create`
 * runs, without instantiating anything — and reads, for every module the scan registered, its
 * controllers' routes through Nest's own `PathsExplorer` and `RoutePathFactory` (the classes
 * `RoutesResolver` uses to register them with Express). The app sets no global prefix and no
 * versioning (checked below), so those paths are the paths Express serves. The scanner's list
 * of global enhancers, in registration order, is the order Nest runs the `APP_GUARD`s in.
 *
 * Loading the API graph takes about a minute.
 */

interface RegisteredRoute {
    /** `RequestMethod` name: `GET`, `POST`, …, `ALL`. */
    readonly method: string;
    /** The route template as Express gets it, e.g. `/api/plugins/:pluginId/settings`. */
    readonly path: string;
    readonly controller: string;
    readonly handler: string;
}

interface RegisteredGuard {
    readonly module: string;
    readonly guard: string;
}

interface RouteReport {
    readonly routes: RegisteredRoute[];
    readonly guards: RegisteredGuard[];
}

const CHILD_FLAG = 'EW_DEMO_RESTRICTIONS_ROUTES_CHILD';

/* -------------------------------------------------------------------------- *
 * The child: Nest's own scan of the real ApiModule
 * -------------------------------------------------------------------------- */

export async function runDemoRoutesChild(): Promise<void> {
    const request = readApiGraphChildRequest(CHILD_FLAG);
    writeFileSync(request.out, JSON.stringify(await collectRoutes()));
}

async function collectRoutes(): Promise<RouteReport> {
    const { RequestMethod } = await import('@nestjs/common');
    const { MODULE_PATH, PATH_METADATA } = await import('@nestjs/common/constants');
    const { APP_GUARD } = await import('@nestjs/core');
    const { ApplicationConfig } = await import('@nestjs/core/application-config');
    const { NestContainer } = await import('@nestjs/core/injector/container');
    const { NoopGraphInspector } = await import('@nestjs/core/inspector/noop-graph-inspector');
    const { MetadataScanner } = await import('@nestjs/core/metadata-scanner');
    const { PathsExplorer } = await import('@nestjs/core/router/paths-explorer');
    const { RoutePathFactory } = await import('@nestjs/core/router/route-path-factory');
    const { DependenciesScanner } = await import('@nestjs/core/scanner');
    const { ApiModule } = await import('../../api.module');

    const applicationConfig = new ApplicationConfig();
    const container = new NestContainer(applicationConfig);
    const scanner = new DependenciesScanner(
        container,
        new MetadataScanner(),
        NoopGraphInspector,
        applicationConfig,
    );
    await scanner.scan(ApiModule);

    const modules = container.getModules();
    const pathsExplorer = new PathsExplorer(new MetadataScanner());
    const routePathFactory = new RoutePathFactory(applicationConfig);
    const seen = new Set<string>();
    const routes: RegisteredRoute[] = [];
    // `RoutesResolver.resolve`, minus the Express registration.
    for (const moduleRef of modules.values()) {
        const modulePath =
            Reflect.getMetadata(MODULE_PATH + modules.applicationId, moduleRef.metatype) ??
            Reflect.getMetadata(MODULE_PATH, moduleRef.metatype);
        for (const wrapper of moduleRef.controllers.values()) {
            const controller = wrapper.metatype as { name: string; prototype: object };
            const ctrlPaths = ([] as string[]).concat(
                Reflect.getMetadata(PATH_METADATA, controller) ?? [],
            );
            const definitions = pathsExplorer.scanForPaths(
                Object.create(controller.prototype),
                controller.prototype,
            );
            for (const ctrlPath of ctrlPaths) {
                for (const definition of definitions) {
                    for (const methodPath of definition.path) {
                        for (const path of routePathFactory.create(
                            { ctrlPath, methodPath, modulePath, globalPrefix: '' },
                            definition.requestMethod,
                        )) {
                            const route: RegisteredRoute = {
                                method: RequestMethod[definition.requestMethod],
                                path,
                                controller: controller.name,
                                handler: definition.methodName,
                            };
                            const key = `${route.method} ${route.path} ${route.controller}.${route.handler}`;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            routes.push(route);
                        }
                    }
                }
            }
        }
    }

    // `DependenciesScanner.applyApplicationProviders` walks this list, in this order.
    const applyMap = (
        scanner as unknown as {
            applicationProvidersApplyMap: {
                type: unknown;
                moduleKey: string;
                providerKey: string;
            }[];
        }
    ).applicationProvidersApplyMap;
    const guards: RegisteredGuard[] = applyMap
        .filter((entry) => entry.type === APP_GUARD)
        .map((entry) => {
            const moduleRef = modules.get(entry.moduleKey);
            const wrapper =
                moduleRef?.providers.get(entry.providerKey) ??
                moduleRef?.injectables.get(entry.providerKey);
            return {
                module: moduleRef?.metatype?.name ?? '<unknown>',
                guard: (wrapper?.metatype as { name?: string } | undefined)?.name ?? '<unknown>',
            };
        });

    return { routes, guards };
}

/* -------------------------------------------------------------------------- *
 * The spec side
 * -------------------------------------------------------------------------- */

function runChild(): RouteReport {
    return runApiGraphChild<RouteReport>({
        childFlag: CHILD_FLAG,
        entry: 'runDemoRoutesChild',
        spec: __filename,
        label: 'demo-restrictions-routes',
        env: { DEMO: 'true' },
    });
}

/** A concrete path Express would route to the template: every parameter filled in. */
function samplePathOf(template: string): string {
    return template
        .replace(/[{}]/g, '')
        .replace(/\*[A-Za-z0-9_]*/g, 'sample/sample')
        .replace(/:[A-Za-z0-9_]+/g, 'sample');
}

/** The template as a pattern, to find the real route a concrete path lands on. */
function templatePattern(template: string): RegExp {
    const escaped = template
        .replace(/[{}]/g, '')
        .replace(/[.+?^$()[\]\\|]/g, '\\$&')
        .replace(/\*[A-Za-z0-9_]*/g, '.+')
        .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
    return new RegExp(`^${escaped}$`, 'i');
}

function methodServes(route: RegisteredRoute, method: string): boolean {
    return route.method === 'ALL' || route.method === method;
}

function entryLabel(entry: DemoBlockedRoute): string {
    return `${entry.method} ${entry.path.source} (${entry.feature})`;
}

/**
 * Routes the demo must keep open, with a body where the table looks at it. `POST /api/auth/demo`
 * is the only way into a demo instance; the rest are what a sandbox visitor does all day.
 */
const MUST_STAY_OPEN: { method: string; path: string; body?: unknown }[] = [
    { method: 'POST', path: '/api/auth/demo' },
    { method: 'POST', path: '/api/auth/login' },
    { method: 'POST', path: '/api/auth/logout' },
    { method: 'GET', path: '/api/auth/profile' },
    { method: 'GET', path: '/api/works' },
    { method: 'POST', path: '/api/works', body: { name: 'Tools', kind: 'directory' } },
    { method: 'POST', path: '/api/works/quick-create', body: { prompt: 'AI tools' } },
    { method: 'PUT', path: '/api/works/w-1', body: { name: 'Renamed', organization: false } },
    { method: 'POST', path: '/api/works/w-1/generate' },
    { method: 'GET', path: '/api/plugins/openrouter/models' },
    { method: 'GET', path: '/api/plugins' },
    { method: 'POST', path: '/api/plugins/openrouter/enable', body: {} },
    { method: 'POST', path: '/api/works/w-1/plugins/openrouter/enable', body: { priority: 1 } },
    { method: 'PUT', path: '/api/auth/profile', body: { displayName: 'Demo visitor' } },
    { method: 'POST', path: '/api/uploads/file' },
    // A share link is refused (R38); reading, turning it off and deleting it are not.
    { method: 'GET', path: '/api/organizations/o-1/shared-view' },
    { method: 'GET', path: '/api/organizations/o-1/shared-view/preview' },
    { method: 'PATCH', path: '/api/organizations/o-1/shared-view', body: { status: 'paused' } },
    { method: 'DELETE', path: '/api/organizations/o-1/shared-view' },
    { method: 'GET', path: '/api/oauth/github/connection' },
    // R39: the assistant chat (the AI facade forces OpenRouter, `:free` and the quota).
    {
        method: 'POST',
        path: '/api/v1/chat/completions',
        body: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'Hi' }] },
    },
    // R41 blocks capturing a screenshot; asking whether a provider exists, and the image proxy
    // that serves an already-captured one, are not captures.
    { method: 'GET', path: '/api/screenshot/check-availability' },
    { method: 'GET', path: '/api/screenshot/image/sample.png' },
    // R42 d refuses accepting a claim; the claim landing page's preview stays public.
    { method: 'GET', path: '/api/claim/preview' },
];

if (process.env[CHILD_FLAG] === undefined) {
    describe('DEMO_BLOCKED_ROUTES against the API the demo runs (DEMO=true)', () => {
        const { DEMO_BLOCKED_ROUTES } =
            jest.requireActual<typeof import('../demo-restrictions')>('../demo-restrictions');
        const { findDemoBlockedRoutes } = jest.requireActual<
            typeof import('../demo-restrictions.guard')
        >('../demo-restrictions.guard');
        let report: RouteReport;

        beforeAll(
            () => {
                report = runChild();
            },
            10 * 60 * 1000,
        );

        it('collects the whole API: hundreds of routes, the demo entry among them', () => {
            expect(report.routes.length).toBeGreaterThan(500);
            expect(report.routes).toContainEqual({
                method: 'POST',
                path: '/api/auth/demo',
                controller: 'DemoController',
                handler: 'create',
            });
        });

        it('composes paths exactly as the app does: no global prefix, no versioning', () => {
            const main = readFileSync(join(API_SRC, 'main.ts'), 'utf8');
            expect(main).not.toMatch(/\.setGlobalPrefix\(/);
            expect(main).not.toMatch(/\.enableVersioning\(/);
        });

        it('has at least 15 entries', () => {
            expect(DEMO_BLOCKED_ROUTES.length).toBeGreaterThanOrEqual(15);
        });

        it('every entry matches at least one real route', () => {
            const unmatched = DEMO_BLOCKED_ROUTES.filter(
                (entry) =>
                    !report.routes.some(
                        (route) =>
                            (entry.method === '*' || methodServes(route, entry.method)) &&
                            entry.path.test(samplePathOf(route.path)),
                    ),
            ).map(entryLabel);

            expect(unmatched).toEqual([]);
        });

        it('every entry keeps to a few routes: none sweeps a whole controller', () => {
            for (const entry of DEMO_BLOCKED_ROUTES) {
                const reached = report.routes.filter(
                    (route) =>
                        (entry.method === '*' || methodServes(route, entry.method)) &&
                        entry.path.test(samplePathOf(route.path)),
                );
                expect([entryLabel(entry), reached.length <= 3]).toEqual([entryLabel(entry), true]);
            }
        });

        /** Every real handler the rows of one feature reach, as `METHOD path Controller.handler`. */
        const handlersOf = (feature: string): string[] =>
            DEMO_BLOCKED_ROUTES.filter((entry) => entry.feature === feature)
                .flatMap((entry) =>
                    report.routes.filter(
                        (route) =>
                            (entry.method === '*' || methodServes(route, entry.method)) &&
                            entry.path.test(samplePathOf(route.path)),
                    ),
                )
                .map(
                    (route) => `${route.method} ${route.path} ${route.controller}.${route.handler}`,
                )
                .sort();

        it('R41: the screenshot rows reach exactly the capture handlers', () => {
            expect(handlersOf('screenshots')).toEqual([
                'POST /api/screenshot/capture ScreenshotController.capture',
                'POST /api/screenshot/get-url ScreenshotController.getScreenshotUrl',
                'POST /api/works/:id/bulk-capture-images WorksController.bulkCaptureImages',
            ]);
        });

        it('R42 d: the claim row reaches exactly the accept handler', () => {
            expect(handlersOf('accepting a Work invitation')).toEqual([
                'POST /api/claim/accept ClaimController.accept',
            ]);
        });

        it('R37 and R38: the transfer and share-link rows reach exactly those handlers', () => {
            // Creating an owner-claim link (and any Work invitation): the step a demo user reaches.
            expect(handlersOf('Work invitations and transfer')).toEqual([
                'POST /api/works/:workId/invitations InvitationsController.create',
            ]);
            // Turning sharing on, minting a new link, and a settings change that publishes.
            expect(handlersOf('public share link')).toEqual([
                'PATCH /api/organizations/:orgId/shared-view SharedViewsController.update',
                'POST /api/organizations/:orgId/shared-view SharedViewsController.enable',
                'POST /api/organizations/:orgId/shared-view/regenerate SharedViewsController.regenerate',
            ]);
            expect(
                findDemoBlockedRoutes({
                    method: 'PATCH',
                    path: '/api/organizations/o-1/shared-view',
                    body: { status: 'active' },
                    headers: {},
                }).map((entry) => entry.feature),
            ).toEqual(['public share link']);
        });

        it('keeps the way in, and the everyday routes, open', () => {
            for (const open of MUST_STAY_OPEN) {
                const label = `${open.method} ${open.path}`;
                const real = report.routes.some(
                    (route) =>
                        methodServes(route, open.method) &&
                        templatePattern(route.path).test(open.path),
                );
                expect([label, real]).toEqual([label, true]);
                const blocked = findDemoBlockedRoutes({
                    method: open.method,
                    path: open.path,
                    body: open.body,
                    headers: {},
                }).map(entryLabel);
                expect([label, blocked]).toEqual([label, []]);
            }
        });

        it('runs after the session guard, so a signed-in caller is already on the request', () => {
            const order = report.guards.map((entry) => `${entry.module}:${entry.guard}`);
            const session = order.indexOf('ApiModule:AuthSessionGuard');
            const demo = order.indexOf('DemoModule:DemoRestrictionsGuard');

            expect(session).toBeGreaterThanOrEqual(0);
            expect(demo).toBeGreaterThan(session);
            // Registered once, by the demo module only.
            expect(order.filter((name) => name.endsWith(':DemoRestrictionsGuard'))).toEqual([
                'DemoModule:DemoRestrictionsGuard',
            ]);
        });
    });
}
