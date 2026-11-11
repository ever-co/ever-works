import { DataSource } from 'typeorm';
import { AddAgentRunLatestEndedIndex1797700000000 } from '../1797700000000-AddAgentRunLatestEndedIndex';

/**
 * The Agents list's "Last run" index on `agent_runs (agentId, finishedAt)`, on in-memory
 * better-sqlite3 (the PHYSICAL index through `PRAGMA`): created, idempotent, dropped by
 * `down`, and a no-op without the table or its columns.
 */
describe('AddAgentRunLatestEndedIndex1797700000000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentRunLatestEndedIndex1797700000000();

    const indexColumns = async (index: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_info("${index}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const indexNames = async (): Promise<string[]> =>
        (
            (await dataSource.query(`PRAGMA index_list("agent_runs")`)) as Array<{
                name: string;
            }>
        ).map((row) => row.name);
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "agent_runs" ("id" varchar PRIMARY KEY, "agentId" varchar NOT NULL, "status" varchar(16) NOT NULL, "startedAt" datetime, "finishedAt" datetime)`,
        );
        await dataSource.query(
            `CREATE INDEX "idx_agent_runs_agent_started" ON "agent_runs" ("agentId", "startedAt")`,
        );
        await dataSource.query(
            `INSERT INTO "agent_runs" ("id", "agentId", "status", "startedAt", "finishedAt") VALUES ('run-1', 'agent-1', 'completed', '2026-11-10 20:00:00', '2026-11-10 20:04:00')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the (agentId, finishedAt) index and is idempotent', async () => {
        await run('up');
        await run('up');
        expect(await indexColumns('idx_agent_runs_agent_finished')).toEqual([
            'agentId',
            'finishedAt',
        ]);
        expect(
            (await indexNames()).filter((name) => name === 'idx_agent_runs_agent_finished'),
        ).toHaveLength(1);
        expect(await indexNames()).toContain('idx_agent_runs_agent_started');
    });

    it('down() drops the index and keeps the rows and the other indexes', async () => {
        await run('up');
        await run('down');
        expect(await indexNames()).not.toContain('idx_agent_runs_agent_finished');
        expect(await indexNames()).toContain('idx_agent_runs_agent_started');
        expect(await dataSource.query(`SELECT id FROM agent_runs`)).toEqual([{ id: 'run-1' }]);
        await expect(run('down')).resolves.toBeUndefined();
    });

    it('is a no-op without the table or without its columns', async () => {
        await dataSource.query(`DROP TABLE agent_runs`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
        await dataSource.query(
            `CREATE TABLE "agent_runs" ("id" varchar PRIMARY KEY, "agentId" varchar)`,
        );
        await expect(run('up')).resolves.toBeUndefined();
        expect(await indexNames()).not.toContain('idx_agent_runs_agent_finished');
    });
});
