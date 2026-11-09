import type { DataSource } from 'typeorm';

/** The two `DataSource` members the check reads (a full `DataSource` fits). */
export type MigrationsLoadedSource = Pick<DataSource, 'options' | 'migrations'>;

export interface MigrationsLoadedLogger {
    log(message: string): void;
}

/**
 * Refuse to serve when the API is meant to apply migrations at boot but
 * TypeORM loaded none.
 *
 * TypeORM treats migration globs that match nothing as "no migrations": with
 * `migrationsRun` on, `DataSource.initialize()` then applies nothing, logs
 * nothing and the API boots normally on an unmigrated schema. That happened in
 * prod from round 15 (2026-11-07): a `minimatch` override left TypeORM's
 * `glob@10` matching 0 files, and round 16's migration silently never ran.
 * Stage runs `synchronize` (`DATABASE_AUTOMIGRATE=true`), where `migrationsRun`
 * is off, so only prod-shaped deploys reach this check.
 *
 * The API ships hundreds of migrations, so 0 loaded with `migrationsRun` on is
 * always a broken loader or a broken build, never a valid state. Failing the
 * boot keeps the previous pods serving and makes the rollout visibly stall,
 * instead of letting the schema drift. Opt out explicitly with
 * `RUN_MIGRATIONS=false` (diagnostic pods) or `DATABASE_AUTOMIGRATE=true`.
 *
 * Call it from the API's `main.ts` only: Trigger.dev workers import the same
 * `DatabaseModule` with the API's defaults but ship no compiled migrations.
 */
export function assertMigrationsLoaded(dataSource: MigrationsLoadedSource, logger: MigrationsLoadedLogger): void {
    const options = dataSource.options as { migrationsRun?: boolean; migrations?: unknown };
    if (!options.migrationsRun) {
        return;
    }

    const loaded = dataSource.migrations.length;
    if (loaded === 0) {
        throw new Error(
            `TypeORM loaded 0 migrations from ${JSON.stringify(options.migrations)} while migrationsRun is on, ` +
                'so no pending migration would be applied. Refusing to start on a possibly unmigrated schema. ' +
                'Check that the build produced dist/migrations/*.js in the working directory and that ' +
                "TypeORM's glob can read the installed minimatch (packages/agent/src/database/migration-globs.ts). " +
                'Set RUN_MIGRATIONS=false only to boot a diagnostic instance.',
        );
    }

    const newest = dataSource.migrations.reduce(
        (latest, migration) => {
            const name = migration.name ?? migration.constructor.name;
            const timestamp = Number(/(\d{13})$/.exec(name)?.[1] ?? 0);
            return timestamp > latest.timestamp ? { name, timestamp } : latest;
        },
        { name: '', timestamp: 0 },
    );
    logger.log(
        `TypeORM loaded ${loaded} migrations (migrationsRun on)` + (newest.name ? `; newest: ${newest.name}` : ''),
    );
}
