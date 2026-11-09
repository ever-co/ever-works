import type { MigrationInterface } from 'typeorm';
import { assertMigrationsLoaded, type MigrationsLoadedSource } from './migrations-loaded';

function migration(name: string): MigrationInterface {
    return { name, up: async () => undefined, down: async () => undefined };
}

function source(
    migrationsRun: boolean | undefined,
    migrations: MigrationInterface[],
): MigrationsLoadedSource {
    return {
        options: { type: 'postgres', migrationsRun, migrations: ['/app/dist/migrations/*.js'] },
        migrations,
    } as unknown as MigrationsLoadedSource;
}

describe('assertMigrationsLoaded', () => {
    it('refuses to boot when migrationsRun is on and TypeORM loaded no migration', () => {
        const logger = { log: jest.fn() };

        expect(() => assertMigrationsLoaded(source(true, []), logger)).toThrow(
            /TypeORM loaded 0 migrations from \["\/app\/dist\/migrations\/\*\.js"\] while migrationsRun is on/,
        );
        expect(logger.log).not.toHaveBeenCalled();
    });

    it('logs the count and the newest migration when migrations loaded', () => {
        const logger = { log: jest.fn() };
        const loaded = [
            migration('InitialSchema1700000000000'),
            migration('AddEverConnectInstallRequests1797500000000'),
            migration('AddSomething1780000000000'),
        ];

        assertMigrationsLoaded(source(true, loaded), logger);

        expect(logger.log).toHaveBeenCalledWith(
            'TypeORM loaded 3 migrations (migrationsRun on); newest: AddEverConnectInstallRequests1797500000000',
        );
    });

    it.each([false, undefined])(
        'does nothing when migrationsRun is %s (synchronize, CLI, tests)',
        (run) => {
            const logger = { log: jest.fn() };

            expect(() => assertMigrationsLoaded(source(run, []), logger)).not.toThrow();
            expect(logger.log).not.toHaveBeenCalled();
        },
    );
});
