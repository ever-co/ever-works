import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
 * Importing `ApiModule` under this app's jest does not work (ts-jest type-checks the whole
 * program; api jest's `@src/` mapper hands agent files the API's same-named files; better-auth
 * ships ESM) — `app-works-di-reachability.spec.ts` explains each. So, as that spec does, a
 * child `node` process compiles `.ts` with `@swc/core` and `nest build -b swc`'s options,
 * resolves each package's `paths` aliases against that package's tsconfig and the rest with
 * api jest's `moduleNameMapper`, and imports the real `ApiModule` with `DEMO=true`.
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

interface ChildRequest {
    readonly repo: string;
    readonly apiRoot: string;
    readonly spec: string;
    readonly out: string;
    /** api jest's `moduleNameMapper`, minus its `@src/` rules, `<rootDir>` made absolute. */
    readonly mapper: [string, string[]][];
}

const CHILD_FLAG = 'EW_DEMO_RESTRICTIONS_ROUTES_CHILD';
const API_ROOT = resolve(__dirname, '..', '..', '..');
const API_SRC = join(API_ROOT, 'src');
const REPO = resolve(API_ROOT, '..', '..');

/**
 * The child's loader, plain CommonJS so nothing has to be compiled to start it — the loader of
 * `app-works-di-reachability.spec.ts`, minus its Trigger-task branch.
 */
const CHILD_BOOTSTRAP = [
    "'use strict';",
    "const Module = require('node:module');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const request = JSON.parse(process.env.${CHILD_FLAG});`,
    "const fromApi = Module.createRequire(path.join(request.apiRoot, 'package.json'));",
    "const swc = fromApi('@swc/core');",
    "const ts = fromApi('typescript');",
    'const swcOptions = {',
    "    module: { type: 'commonjs' },",
    '    jsc: {',
    "        target: 'es2021',",
    "        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },",
    '        transform: { legacyDecorator: true, decoratorMetadata: true, useDefineForClassFields: false },',
    '        keepClassNames: true,',
    '    },',
    '    minify: false,',
    '    swcrc: false,',
    '};',
    'const tsconfigs = new Map();',
    'function compilerOptionsOf(root) {',
    '    if (!tsconfigs.has(root)) {',
    "        const read = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);",
    '        tsconfigs.set(root, ts.convertCompilerOptionsFromJson((read.config && read.config.compilerOptions) || {}, root).options);',
    '    }',
    '    return tsconfigs.get(root);',
    '}',
    "Module._extensions['.ts'] = function (module, filename) {",
    "    const source = fs.readFileSync(filename, 'utf8');",
    '    module._compile(swc.transformSync(source, { ...swcOptions, filename }).code, filename);',
    '};',
    'function packageRootOf(file) {',
    '    let dir = path.dirname(file);',
    '    while (dir.startsWith(request.repo) && dir !== request.repo) {',
    "        if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'tsconfig.json'))) return dir;",
    '        dir = path.dirname(dir);',
    '    }',
    '    return null;',
    '}',
    'function candidates(spec, parent) {',
    '    const from = parent && parent.filename;',
    "    if (from && !from.includes(path.sep + 'node_modules' + path.sep)) {",
    '        const root = packageRootOf(from);',
    '        if (root) {',
    '            const options = compilerOptionsOf(root);',
    '            const baseUrl = options.baseUrl || root;',
    '            for (const [pattern, targets] of Object.entries(options.paths || {})) {',
    "                const star = pattern.indexOf('*');",
    '                const prefix = star < 0 ? pattern : pattern.slice(0, star);',
    "                const suffix = star < 0 ? '' : pattern.slice(star + 1);",
    '                const hit = star < 0 ? spec === pattern : spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length;',
    '                if (!hit) continue;',
    "                const middle = star < 0 ? '' : spec.slice(prefix.length, spec.length - suffix.length);",
    "                return targets.map((target) => path.resolve(baseUrl, target.replace('*', middle)));",
    '            }',
    '        }',
    '    }',
    '    for (const [source, targets] of request.mapper) {',
    '        const match = new RegExp(source).exec(spec);',
    "        if (match) return targets.map((target) => target.replace(/\\$(\\d+)/g, (_, i) => match[Number(i)] || ''));",
    '    }',
    '    return null;',
    '}',
    'const resolveFilename = Module._resolveFilename;',
    'Module._resolveFilename = function (spec, parent, isMain, options) {',
    '    const mapped = candidates(spec, parent);',
    '    if (mapped) {',
    '        for (const candidate of mapped) {',
    '            try { return resolveFilename.call(this, candidate, parent, isMain, options); } catch (error) { /* next */ }',
    '        }',
    '    }',
    '    try {',
    '        return resolveFilename.call(this, spec, parent, isMain, options);',
    '    } catch (error) {',
    "        if (spec.startsWith('.') && spec.endsWith('.js')) return resolveFilename.call(this, spec.slice(0, -3), parent, isMain, options);",
    '        throw error;',
    '    }',
    '};',
    "fromApi('reflect-metadata');",
    'require(request.spec).runDemoRoutesChild().then(',
    '    () => process.exit(0),',
    '    (error) => { console.error((error && error.stack) || error); process.exit(1); },',
    ');',
].join('\n');

/* -------------------------------------------------------------------------- *
 * The child: Nest's own scan of the real ApiModule
 * -------------------------------------------------------------------------- */

export async function runDemoRoutesChild(): Promise<void> {
    const request = JSON.parse(process.env[CHILD_FLAG] ?? '{}') as ChildRequest;
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
    const config = jest.requireActual<{ moduleNameMapper: Record<string, string | string[]> }>(
        join(API_ROOT, 'jest.config.js'),
    );
    const mapper: [string, string[]][] = Object.entries(config.moduleNameMapper)
        .filter(([source]) => !source.startsWith('^@src/'))
        .map(([source, target]) => [
            source,
            (Array.isArray(target) ? target : [target]).map((path) =>
                path.replace('<rootDir>', API_SRC),
            ),
        ]);
    const out = join(tmpdir(), `demo-restrictions-routes-${process.pid}-${Date.now()}.json`);
    const request: ChildRequest = { repo: REPO, apiRoot: API_ROOT, spec: __filename, out, mapper };
    try {
        const child = spawnSync(
            process.execPath,
            ['--max-old-space-size=4096', '-e', CHILD_BOOTSTRAP],
            {
                cwd: API_ROOT,
                env: { ...process.env, DEMO: 'true', [CHILD_FLAG]: JSON.stringify(request) },
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                timeout: 10 * 60 * 1000,
            },
        );
        if (child.status !== 0 || !existsSync(out)) {
            throw new Error(
                `The route child failed (status ${String(child.status)}, signal ${String(child.signal)}):\n` +
                    `${child.stderr}\n${String(child.stdout).slice(-4000)}`,
            );
        }
        return JSON.parse(readFileSync(out, 'utf8')) as RouteReport;
    } finally {
        rmSync(out, { force: true });
    }
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
    { method: 'POST', path: '/api/uploads/file' },
    { method: 'GET', path: '/api/oauth/github/connection' },
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
