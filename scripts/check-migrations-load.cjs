#!/usr/bin/env node
/**
 * Load the API's compiled migrations through TypeORM's own directory loader,
 * the way the API does at boot (`migrationsRun`), and fail unless every
 * compiled migration file comes back as a class.
 *
 * Run it from the API's working directory: `apps/api` after a build, or
 * `/app` inside the API image (`node /path/to/check-migrations-load.cjs`).
 *
 * Why: from round 15 a `minimatch` override left TypeORM's `glob` matching 0
 * files, so prod skipped every new migration while every boot check (all on
 * `synchronize`) stayed green. Background:
 * `packages/agent/src/database/migration-globs.ts`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function versionOf(pkg, fromDir) {
    try {
        return require(require.resolve(`${pkg}/package.json`, { paths: [fromDir] })).version;
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

    const typeormDir = path.dirname(require.resolve('typeorm/package.json', { paths: [cwd] }));
    const globDir = path.dirname(require.resolve('glob/package.json', { paths: [typeormDir] }));
    const { importClassesFromDirectories } = require(path.join(typeormDir, 'util', 'DirectoryExportedClassesLoader'));

    // Same glob the API builds (`resolveMigrationGlobs()`): absolute, forward slashes.
    const pattern = `${cwd.replace(/\\/g, '/')}/dist/migrations/*.js`;
    const classes = await importClassesFromDirectories({ log() {} }, [pattern]);

    console.log(
        `compiled migration files: ${files.length}; loaded by TypeORM: ${classes.length} ` +
            `(typeorm ${versionOf('typeorm', cwd)}, its glob ${versionOf('glob', typeormDir)}, ` +
            `that glob's minimatch ${versionOf('minimatch', globDir)})`,
    );
    if (classes.length < files.length) {
        console.error(
            `::error::TypeORM loaded ${classes.length} of ${files.length} compiled migrations from ${pattern}; ` +
                'the API would skip the rest at boot. Check that TypeORM\'s glob can read the installed minimatch.',
        );
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
