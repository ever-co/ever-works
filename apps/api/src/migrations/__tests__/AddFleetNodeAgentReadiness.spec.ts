import { DataSource } from 'typeorm';
import { AddFleetNodeAgentReadiness1797600000000 } from '../1797600000000-AddFleetNodeAgentReadiness';

/**
 * Migration test for the node's agent readiness report:
 * `fleet_nodes.agentReadiness`. In-memory better-sqlite3, asserting the
 * PHYSICAL schema via PRAGMA, like `AddFleetNodeSelfUpdate.spec`.
 */
describe('AddFleetNodeAgentReadiness1797600000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeAgentReadiness1797600000000();

    const columns = async (): Promise<
        Array<{ name: string; notnull: number; dflt_value: string | null; type: string }>
    > => dataSource.query(`PRAGMA table_info("fleet_nodes")`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar(200) NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name") VALUES ('n1', 'u1', 'everdesk3-vm')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable text agentReadiness; an existing row reads never reported', async () => {
        await migration.up(dataSource.createQueryRunner());
        const column = (await columns()).find((entry) => entry.name === 'agentReadiness');
        expect(column?.type.toLowerCase()).toBe('text');
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
        const [row] = await dataSource.query(`SELECT "agentReadiness" FROM "fleet_nodes"`);
        expect(row.agentReadiness).toBeNull();
    });

    it('applies twice without error (a partially applied database converges)', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.up(dataSource.createQueryRunner());
        expect((await columns()).filter((entry) => entry.name === 'agentReadiness')).toHaveLength(
            1,
        );
    });

    it('reverts cleanly, and a revert on a database without the column is a no-op', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.down(dataSource.createQueryRunner());
        expect((await columns()).some((entry) => entry.name === 'agentReadiness')).toBe(false);
        await migration.down(dataSource.createQueryRunner());
    });
});
