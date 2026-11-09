import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from 'typeorm';
import { importClassesFromDirectories } from 'typeorm/util/DirectoryExportedClassesLoader';
import { resolveMigrationGlobs } from './migration-globs';

/**
 * Prod applies migrations at boot through TypeORM's own directory loader
 * (`DataSource.initialize()` → `importClassesFromDirectories(migrations)`),
 * which matches the globs with the `glob` package TypeORM resolves, which in
 * turn matches with the `minimatch` the lockfile resolves.
 *
 * In round 15 that chain broke without an error: a security override moved
 * `minimatch` to 11.x under TypeORM's `glob@10`, the globs matched 0 files,
 * and prod skipped every new migration (the API booted fine). Unit specs that
 * mock the glob, and boots that use `synchronize`, cannot see this.
 *
 * This spec runs the real chain from the lockfile against real compiled
 * migration files, so a dependency change that breaks it fails here.
 */
describe('migration globs through TypeORM’s directory loader', () => {
    const silentLogger = { log: () => undefined } as unknown as Logger;
    let root: string;
    const migrationNames = ['FirstFixture1700000000001', 'SecondFixture1700000000002'];

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-migration-globs-'));
        // Pin the module type so TypeORM requires the fixtures as CommonJS,
        // whatever package.json sits above the temp directory.
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
        const dir = path.join(root, 'dist', 'migrations');
        fs.mkdirSync(dir, { recursive: true });
        for (const name of migrationNames) {
            const timestamp = name.slice(-13);
            // Shape of a migration compiled by the API build (SWC → CommonJS).
            fs.writeFileSync(
                path.join(dir, `${timestamp}-${name.slice(0, -13)}.js`),
                [
                    '"use strict";',
                    'Object.defineProperty(exports, "__esModule", { value: true });',
                    `class ${name} {`,
                    `    constructor() { this.name = '${name}'; }`,
                    '    async up() {}',
                    '    async down() {}',
                    '}',
                    `exports.${name} = ${name};`,
                    '',
                ].join('\n'),
            );
        }
        // Not a migration: the `*.js` globs must leave it alone.
        fs.writeFileSync(path.join(dir, 'README.md'), 'not a migration\n');
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('builds absolute forward-slash globs for the image and the workspace layouts', () => {
        const globs = resolveMigrationGlobs('C:\\app');
        expect(globs).toEqual(['C:/app/dist/migrations/*.js', 'C:/app/apps/api/dist/migrations/*.js']);
    });

    it('defaults to the process working directory', () => {
        const cwd = process.cwd().replace(/\\/g, '/');
        expect(resolveMigrationGlobs()[0]).toBe(`${cwd}/dist/migrations/*.js`);
    });

    it('loads every compiled migration the globs point at', async () => {
        const classes = await importClassesFromDirectories(silentLogger, resolveMigrationGlobs(root));

        expect(classes.map((migration) => (migration as { name: string }).name).sort()).toEqual(migrationNames);
    });

    it('loads nothing (and does not throw) for a layout without compiled migrations', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-migration-globs-empty-'));
        try {
            await expect(importClassesFromDirectories(silentLogger, resolveMigrationGlobs(empty))).resolves.toEqual(
                [],
            );
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });
});
