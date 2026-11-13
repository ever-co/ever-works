import { DataSource } from 'typeorm';
import { AddEverConnect1797300000000 } from '../1797300000000-AddEverConnect';
import { AddEverConnectProvision1797400000000 } from '../1797400000000-AddEverConnectProvision';
import { AddEverConnectLinkCodesAndEntitlements1798100000000 } from '../1798100000000-AddEverConnectLinkCodesAndEntitlements';

/**
 * Additive: three nullable columns and one new table. Rows that existed keep
 * their values, the indexes of `ever_connect_links` stay, `up()` re-runs as a
 * no-op, and `down()` takes exactly what `up()` added.
 */
describe('AddEverConnectLinkCodesAndEntitlements1798100000000', () => {
    let dataSource: DataSource;
    const migration = new AddEverConnectLinkCodesAndEntitlements1798100000000();

    const run = async (
        target: { up(r: unknown): Promise<void>; down(r: unknown): Promise<void> },
        direction: 'up' | 'down',
    ) => {
        const runner = dataSource.createQueryRunner();
        await target[direction](runner);
        await runner.release();
    };
    const columns = async (table: string) => {
        const runner = dataSource.createQueryRunner();
        const found = await runner.getTable(table);
        await runner.release();
        return found;
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await run(new AddEverConnect1797300000000(), 'up');
        await run(new AddEverConnectProvision1797400000000(), 'up');
        await dataSource.query(
            `INSERT INTO ever_connect_links ("id", "organizationId", "tenantId", "everOrgId", "handle", "createdVia", "status")
             VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
                     '33333333-3333-4333-8333-333333333333', '01JMQCK0RG000000000000000A', 'acme', 'provisioning', 'active')`,
        );
        await dataSource.query(
            `INSERT INTO ever_connect_connection ("id", "status") VALUES ('self', 'active')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the columns and the table, keeps existing rows and indexes, and runs again as a no-op', async () => {
        await run(migration, 'up');
        await run(migration, 'up');

        const links = await columns('ever_connect_links');
        const added = links?.findColumnByName('productOrgRef');
        expect(added).toMatchObject({ isNullable: true, length: '128' });
        expect(links?.indices.map((index) => index.name).sort()).toEqual([
            'uq_ever_connect_links_ever_org_active',
            'uq_ever_connect_links_organization',
            'uq_ever_connect_links_tenant_active',
        ]);
        expect(
            await dataSource.query(`SELECT "handle", "productOrgRef" FROM ever_connect_links`),
        ).toEqual([{ handle: 'acme', productOrgRef: null }]);

        const connection = await columns('ever_connect_connection');
        expect(connection?.findColumnByName('lastHeartbeatAt')?.isNullable).toBe(true);
        expect(connection?.findColumnByName('appSyncReconciledAt')?.isNullable).toBe(true);
        expect(
            await dataSource.query(
                `SELECT "status", "lastHeartbeatAt", "appSyncReconciledAt" FROM ever_connect_connection`,
            ),
        ).toEqual([{ status: 'active', lastHeartbeatAt: null, appSyncReconciledAt: null }]);

        const entitlements = await columns('ever_connect_entitlements');
        expect(entitlements?.columns.map((column) => column.name).sort()).toEqual([
            'createdAt',
            'document',
            'expiresAt',
            'fetchedAt',
            'issuedAt',
            'lastError',
            'seq',
            'subject',
            'updatedAt',
        ]);
    });

    it('the active-link uniqueness still holds after the column was added', async () => {
        await run(migration, 'up');
        await expect(
            dataSource.query(
                `INSERT INTO ever_connect_links ("id", "organizationId", "tenantId", "everOrgId", "handle", "createdVia", "status")
                 VALUES ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
                         '33333333-3333-4333-8333-333333333333', '01JMQCK0RG000000000000000B', 'globex', 'link_code', 'active')`,
            ),
        ).rejects.toThrow(/UNIQUE/);
    });

    it('keeps one row per subject', async () => {
        await run(migration, 'up');
        const insert = () =>
            dataSource.query(
                `INSERT INTO ever_connect_entitlements ("subject") VALUES ('instance')`,
            );
        await insert();
        await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY/);
    });

    it('down removes what up added and nothing else; up brings it back', async () => {
        await run(migration, 'up');
        await run(migration, 'down');
        expect(await columns('ever_connect_entitlements')).toBeUndefined();
        const links = await columns('ever_connect_links');
        expect(links?.findColumnByName('productOrgRef')).toBeUndefined();
        expect(links?.findColumnByName('platformLinkId')).toBeDefined();
        const connection = await columns('ever_connect_connection');
        expect(connection?.findColumnByName('lastHeartbeatAt')).toBeUndefined();
        expect(connection?.findColumnByName('lastFeedCursor')).toBeDefined();
        expect(await dataSource.query(`SELECT "handle" FROM ever_connect_links`)).toEqual([
            { handle: 'acme' },
        ]);
        await run(migration, 'down');
        await run(migration, 'up');
        expect(await columns('ever_connect_entitlements')).toBeDefined();
    });
});
