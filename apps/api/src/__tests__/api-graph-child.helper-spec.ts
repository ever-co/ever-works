import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * # A child `node` process that loads the API's real module graph
 *
 * Shared by the specs that must read the graph the API actually boots
 * (`app-works-di-reachability.spec.ts`, `demo/__tests__/demo-restrictions.routes.spec.ts`).
 * Importing `ApiModule` under this app's jest does not work and could not be trusted if it
 * did: ts-jest type-checks the whole API program (it ran out of an 8 GB heap), and api jest's
 * `^@src/(.*)$` mapper hands AGENT files the API's same-named files, which builds a different
 * graph from the one the API boots. So the spec runs itself again in a child `node` process
 * with the loader below, and the child writes its findings to a JSON file the spec reads.
 *
 * A spec using it:
 *   - exports its child entry point (`export async function runXChild()`), which reads the
 *     request with {@link readApiGraphChildRequest} and writes `request.out`;
 *   - registers its `describe` blocks only when `process.env[childFlag]` is unset — the child
 *     `require`s the spec file itself;
 *   - calls {@link runApiGraphChild} from the jest side.
 *
 * The two specs cannot share one load: the reachability spec walks the graph with `DEMO`
 * unset and the demo routes spec needs `DEMO=true` (`DemoModule.register()` reads it when
 * `ApiModule` is imported, so the graphs differ), and jest runs each spec file in its own
 * worker process.
 */

/** `apps/api`. */
export const API_ROOT = join(__dirname, '..', '..');
/** `apps/api/src`. */
export const API_SRC = join(API_ROOT, 'src');
/** The monorepo root. */
export const REPO = join(API_ROOT, '..', '..');

/** What the jest side hands the child, as JSON in `process.env[childFlag]`. */
export interface ApiGraphChildRequest {
    readonly repo: string;
    readonly apiRoot: string;
    readonly tasksRoot: string;
    /** The spec file the child `require`s for its entry point. */
    readonly spec: string;
    /** Where the child writes its JSON report. */
    readonly out: string;
    /** api jest's `moduleNameMapper`, minus its `@src/` rules, `<rootDir>` made absolute. */
    readonly mapper: [string, string[]][];
}

/**
 * The child's loader, as plain CommonJS so nothing has to be compiled to start it.
 *
 * `.ts` under `packages/tasks` is compiled as the Trigger bundle compiles it
 * (`ts.transpileModule` with the tasks tsconfig — `@trigger.dev/build`'s
 * `emitDecoratorMetadata`); every other `.ts` by `@swc/core` with `nest build -b swc`'s
 * options (`@nestjs/cli/lib/compiler/defaults/swc-defaults.js`). A `paths` alias
 * (`@src/*`, `@/*`) resolves against the tsconfig of the package that WRITES the import;
 * anything else goes through api jest's own mapper. Once installed it calls
 * `require(request.spec)[entry]()` and exits 0 when that resolves, 1 when it rejects.
 */
export function apiGraphChildBootstrap(childFlag: string, entry: string): string {
    return [
        "'use strict';",
        "const Module = require('node:module');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `const request = JSON.parse(process.env.${childFlag});`,
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
        '    if (filename.startsWith(request.tasksRoot + path.sep)) {',
        '        const options = { ...compilerOptionsOf(request.tasksRoot), module: ts.ModuleKind.CommonJS, sourceMap: false, inlineSourceMap: false, declaration: false };',
        '        module._compile(ts.transpileModule(source, { fileName: filename, compilerOptions: options }).outputText, filename);',
        '        return;',
        '    }',
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
        `require(request.spec).${entry}().then(`,
        '    () => process.exit(0),',
        '    (error) => { console.error((error && error.stack) || error); process.exit(1); },',
        ');',
    ].join('\n');
}

/** The child side: the request the jest side sent. */
export function readApiGraphChildRequest(childFlag: string): ApiGraphChildRequest {
    return JSON.parse(process.env[childFlag] ?? '{}') as ApiGraphChildRequest;
}

/**
 * The jest side: run `spec`'s `entry` in a child process (extra `env` on top of this
 * process's) and answer the JSON report it wrote. Throws with the child's output when it
 * fails. Loading the API graph takes about a minute.
 */
export function runApiGraphChild<T>(options: {
    readonly childFlag: string;
    readonly entry: string;
    readonly spec: string;
    /** Prefix of the temporary report file. */
    readonly label: string;
    readonly env?: Readonly<Record<string, string>>;
}): T {
    const config = jest.requireActual<{ moduleNameMapper: Record<string, string | string[]> }>(
        join(API_ROOT, 'jest.config.js'),
    );
    // Api jest's `@src/` rules are the ambiguous ones (see above); the child resolves
    // `@src/` per package instead.
    const mapper: [string, string[]][] = Object.entries(config.moduleNameMapper)
        .filter(([source]) => !source.startsWith('^@src/'))
        .map(([source, target]) => [
            source,
            (Array.isArray(target) ? target : [target]).map((path) =>
                path.replace('<rootDir>', API_SRC),
            ),
        ]);
    const out = join(tmpdir(), `${options.label}-${process.pid}-${Date.now()}.json`);
    const request: ApiGraphChildRequest = {
        repo: REPO,
        apiRoot: API_ROOT,
        tasksRoot: join(REPO, 'packages', 'tasks'),
        spec: options.spec,
        out,
        mapper,
    };
    try {
        const child = spawnSync(
            process.execPath,
            [
                '--max-old-space-size=4096',
                '-e',
                apiGraphChildBootstrap(options.childFlag, options.entry),
            ],
            {
                cwd: API_ROOT,
                env: {
                    ...process.env,
                    ...options.env,
                    [options.childFlag]: JSON.stringify(request),
                },
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                timeout: 10 * 60 * 1000,
            },
        );
        if (child.status !== 0 || !existsSync(out)) {
            throw new Error(
                `The graph child failed (status ${String(child.status)}, signal ${String(child.signal)}):\n` +
                    `${child.stderr}\n${String(child.stdout).slice(-4000)}`,
            );
        }
        return JSON.parse(readFileSync(out, 'utf8')) as T;
    } finally {
        rmSync(out, { force: true });
    }
}
