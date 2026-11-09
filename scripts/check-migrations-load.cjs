#!/usr/bin/env node
/**
 * Load the API's compiled migrations through TypeORM's own directory loader,
 * the way the API does at boot (`migrationsRun`), and fail unless every
 * compiled migration file comes back as a class.
 *
 * Run it from the API's working directory: `apps/api` after a build, or the
 * deployed tree (`/app/deploy` in the image's installer stage, `/app` at
 * runtime): `node <path>/check-migrations-load.cjs`.
 *
 * Why: from 2026-11-07 (#3107's minimatch override) TypeORM's `glob@10`
 * matched 0 files, so prod skipped every new migration while every boot check
 * (all on `synchronize`) stayed green. Background:
 * `packages/agent/src/database/migration-globs.ts`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The root folder of an installed package, found from its entry point.
 * (`require.resolve('<pkg>/package.json')` is not usable: TypeORM's `exports`
 * map rewrites it to `package.json.js`.)
 */
function packageRoot(name, fromDir) {
    let dir = path.dirname(require.resolve(name, { paths: [fromDir] }));
    for (;;) {
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest)) {
            try {
                if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) {
                    return dir;
                }
            } catch {
                // Not a readable manifest; keep walking up.
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`could not find the package root of ${name} from ${fromDir}`);
        }
        dir = parent;
    }
}

function versionAt(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    } catch {
        return 'unknown';
    }
}

async function main() {
    const cwd = process.cwd();
    const dir = path.join(cwd, 'dist', 'migrations');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.js')) : [];
    if (files.length === 0) {
        console.error(`::error::no compiled migrations (*.js) in ${dir}`);
        process.exit(1);
    }

    const typeormDir = packageRoot('typeorm', cwd);
    const globDir = packageRoot('glob', typeormDir);
    const { importClassesFromDirectories } = require(path.join(typeormDir, 'util', 'DirectoryExportedClassesLoader'));

    // Same glob the API builds (`resolveMigrationGlobs()`): absolute, forward slashes.
    const pattern = `${cwd.replace(/\\/g, '/')}/dist/migrations/*.js`;
    const classes = await importClassesFromDirectories({ log() {} }, [pattern]);

    console.log(
        `compiled migration files: ${files.length}; loaded by TypeORM: ${classes.length} ` +
            `(typeorm ${versionAt(typeormDir)} with glob ${versionAt(globDir)})`,
    );
    // Each compiled migration exports its class, so every file must yield at
    // least one loaded class; 0 is the silent failure this script exists for.
    if (classes.length < files.length) {
        console.error(
            `::error::TypeORM loaded ${classes.length} classes from ${files.length} compiled migrations at ${pattern}; ` +
                "the API would skip the rest at boot. Check TypeORM's glob (root package.json override `typeorm>glob`).",
        );
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
