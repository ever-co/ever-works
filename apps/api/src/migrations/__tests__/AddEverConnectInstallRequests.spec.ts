import { DataSource } from 'typeorm';
import { AddEverConnectInstallRequests1797500000000 } from '../1797500000000-AddEverConnectInstallRequests';

/**
 * The table exists with its indexes; one row per install id; `up()` re-runs as
 * a no-op; `down()` removes the table and `up()` brings it back.
 */
describe('AddEverConnectInstallRequests1797500000000', () => {
    let dataSource: DataSource;
    const migration = new AddEverConnectInstallRequests1797500000000();
    const TABLE = 'ever_connect_install_requests';

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the table and its indexes, runs again as a no-op, goes down and up again', async () => {
        await run('up');
        await run('up');
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable(TABLE);
        expect(table).toBeDefined();
        expect(table?.indices.map((index) => index.name).sort()).toEqual([
            'idx_ever_connect_install_requests_report',
            'idx_ever_connect_install_requests_state',
        ]);
        await run('down');
        expect(await runner.hasTable(TABLE)).toBe(false);
        await run('up');
        expect(await runner.hasTable(TABLE)).toBe(true);
        await runner.release();
    });

    it('keeps one row per install id, and a new row starts requested with nothing reported', async () => {
        await run('up');
        const insert = () =>
            dataSource.query(
                `INSERT INTO ${TABLE} ("installId", "listingSlug", "sourceKind", "receivedAt")
                 VALUES ('01JZ8Q3M4N5P6R7S8T9V0W1X2Y', 'timeclock', 'registry', CURRENT_TIMESTAMP)`,
            );
        await insert();
        await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY/);
        const [row] = await dataSource.query(
            `SELECT state, "reportState", "allowlistAdded", "reportAttempts" FROM ${TABLE}`,
        );
        expect(row).toEqual({
            state: 'requested',
            reportState: null,
            allowlistAdded: 0,
            reportAttempts: 0,
        });
    });
});
