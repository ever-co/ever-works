/**
 * Resolve TypeORM migration globs for the runtime path. TypeORM accepts
 * an array of globs and silently ignores any that don't match files, so
 * listing the candidate layouts is safe and idempotent.
 *
 * **Only `.js` patterns**, intentionally. TypeORM 0.3.x's
 * `DirectoryExportedClassesLoader` loads matched files via
 * `Promise.all(import(file))`. On Node ≥ 22, requiring `.ts` files (even
 * after Nest+SWC transpilation) goes through the ESM loader and
 * `Promise.all`-importing several at once trips Node's internal
 * "Unexpected module status 0" assertion (a known race between
 * `require()` and dynamic `import()` on the same module). Compiled JS
 * doesn't hit this path. The manual `pnpm typeorm migration:generate /
 * migration:run` commands keep their own `'.ts'` glob in
 * `apps/api/typeorm.config.ts` and run under `ts-node`, which loads
 * synchronously and is unaffected.
 *
 * Paths are absolute and use forward slashes, which TypeORM's glob engine
 * (the `glob` package, `glob.sync`) handles on Windows too.
 *
 * 🛑 TypeORM's glob must actually match. On 2026-11-07 a security override
 * (#3107) moved every `minimatch` onto 11.x while TypeORM still used
 * `glob@10`, which `require`s minimatch and cannot read minimatch 11's
 * compiled patterns: these globs matched **nothing**, without an error, and
 * prod skipped every new migration. The root `package.json` therefore pins
 * `typeorm>glob` to glob 14, whose CommonJS build bundles its own matcher (so
 * minimatch overrides no longer reach it). Three checks hold it:
 * `migration-globs.spec.ts` runs these globs through TypeORM's real loader,
 * `scripts/check-migrations-load.cjs` loads the built migrations (api-boot CI),
 * and the API refuses to boot when `migrationsRun` is on and no migration
 * loaded (`apps/api/src/config/migrations-loaded.ts`).
 *
 *   - Docker / prod:        `/app/dist/migrations/*.js` (cwd = /app)
 *   - Local API workspace:  `apps/api/dist/migrations/*.js` (from repo root)
 *   - From apps/api cwd:    `dist/migrations/*.js`
 *
 * For local dev: run `pnpm build --filter ever-works-api` (or `pnpm dev`
 * which builds before watching) to populate `apps/api/dist/migrations/`,
 * then the API will pick up pending migrations on next boot. Authoring
 * a new migration still goes through `pnpm typeorm migration:generate`
 * (which produces `.ts` next to the existing ones) — the build step
 * compiles it to `.js` automatically.
 */
export function resolveMigrationGlobs(cwd: string = process.cwd()): string[] {
    const root = cwd.replace(/\\/g, '/');
    return [`${root}/dist/migrations/*.js`, `${root}/apps/api/dist/migrations/*.js`];
}
