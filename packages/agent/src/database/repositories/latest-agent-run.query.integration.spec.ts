import { DataSource, SelectQueryBuilder, type Repository } from 'typeorm';
import { AgentRun } from '../../entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { findLatestEndedRunsByAgent } from './latest-agent-run.query';

/**
 * The Agents card's "Last run": per Agent, its most recent ENDED run of any
 * kind, read from `agent_runs` for a whole page at once — not from
 * `agents.lastRunAt`, which is the heartbeat's own last run.
 *
 * Portable SQL (a grouped MAX joined back; `DISTINCT ON` is Postgres-only),
 * pinned on a real SQLite database and by its Postgres text.
 */
describe('findLatestEndedRunsByAgent', () => {
    const USER = '11111111-1111-4111-8111-111111111111';
    const BUILDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const REVIEWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const IDLE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    describe('on SQLite', () => {
        let dataSource: DataSource;
        let rows: Repository<AgentRun>;

        beforeAll(async () => {
            dataSource = new DataSource({
                type: 'better-sqlite3',
                database: ':memory:',
                entities: ENTITIES,
                synchronize: true,
            });
            await dataSource.initialize();
            await dataSource.query('PRAGMA foreign_keys = OFF');
            rows = dataSource.getRepository(AgentRun);
        });

        afterAll(async () => {
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        beforeEach(() => rows.clear());

        async function run(
            agentId: string,
            status: AgentRun['status'],
            finishedAt: string | null,
            triggerKind: AgentRun['triggerKind'] = 'task',
        ): Promise<AgentRun> {
            return rows.save(
                rows.create({
                    agentId,
                    userId: USER,
                    triggerKind,
                    status,
                    finishedAt: finishedAt ? new Date(finishedAt) : null,
                }),
            );
        }

        it('returns the most recently FINISHED run per Agent, of any kind', async () => {
            await run(BUILDER, 'completed', '2026-11-10T20:00:00.000Z', 'heartbeat');
            const latest = await run(BUILDER, 'failed', '2026-11-10T21:04:00.000Z', 'task');
            await run(BUILDER, 'completed', '2026-11-09T10:00:00.000Z', 'chat');
            const reviewer = await run(REVIEWER, 'cancelled', '2026-11-08T08:00:00.000Z');

            const found = await findLatestEndedRunsByAgent(dataSource.manager, [
                BUILDER,
                REVIEWER,
                IDLE,
            ]);

            expect(found.get(BUILDER)).toEqual({
                runId: latest.id,
                status: 'failed',
                finishedAt: new Date('2026-11-10T21:04:00.000Z'),
            });
            expect(found.get(REVIEWER)?.runId).toBe(reviewer.id);
            expect(found.has(IDLE)).toBe(false);
        });

        it('ignores a run still in progress — it has not ended', async () => {
            const ended = await run(BUILDER, 'completed', '2026-11-10T20:00:00.000Z');
            await run(BUILDER, 'running', null);
            await run(BUILDER, 'queued', null);

            const found = await findLatestEndedRunsByAgent(dataSource.manager, [BUILDER]);

            expect(found.get(BUILDER)?.runId).toBe(ended.id);
        });

        it('reads both halves through idx_agent_runs_agent_finished once the planner has statistics', async () => {
            // A run history across many Agents, then ANALYZE: the planner statistics a
            // long-lived Postgres keeps on its own. Without them SQLite's defaults guess
            // that `status IN (…)` is selective and read `idx_agent_runs_status` instead.
            const history: AgentRun[] = [];
            for (let agent = 0; agent < 20; agent++) {
                const agentId = `${String(agent).padStart(8, '0')}-0000-4000-8000-000000000000`;
                for (let n = 0; n < 10; n++) {
                    history.push(
                        rows.create({
                            agentId,
                            userId: USER,
                            triggerKind: 'task',
                            status: n === 9 ? 'running' : n % 3 === 0 ? 'failed' : 'completed',
                            finishedAt: n === 9 ? null : new Date(Date.UTC(2026, 10, 1, agent, n)),
                        }),
                    );
                }
            }
            await rows.save(history, { chunk: 100 });
            await dataSource.query('ANALYZE');

            let query: [string, unknown[]] = ['', []];
            const getMany = jest
                .spyOn(SelectQueryBuilder.prototype, 'getMany')
                .mockImplementation(function (this: SelectQueryBuilder<AgentRun>) {
                    query = this.getQueryAndParameters();
                    return Promise.resolve([]);
                });
            try {
                await findLatestEndedRunsByAgent(dataSource.manager, [
                    history[0].agentId,
                    history[10].agentId,
                ]);
            } finally {
                getMany.mockRestore();
            }

            const plan = (await dataSource.query(
                `EXPLAIN QUERY PLAN ${query[0]}`,
                query[1],
            )) as Array<{
                detail: string;
            }>;
            const details = plan.map((row) => row.detail);

            // The join back is one seek per Agent; the grouped MAX reads only ended runs.
            expect(details).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(
                        /\brun\b.* USING (COVERING )?INDEX idx_agent_runs_agent_finished \(agentId=\? AND finishedAt=\?\)/,
                    ),
                    expect.stringMatching(
                        /\bended\b.* USING (COVERING )?INDEX idx_agent_runs_agent_finished \(agentId=\? AND finishedAt>\?\)/,
                    ),
                ]),
            );
        });

        it('answers an empty page without a query', async () => {
            const spy = jest.spyOn(dataSource.manager, 'createQueryBuilder');
            await expect(findLatestEndedRunsByAgent(dataSource.manager, [])).resolves.toEqual(
                new Map(),
            );
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });
    });

    it('emits portable, quoted SQL on Postgres (no DISTINCT ON)', async () => {
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: ENTITIES,
        });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        let sql = '';
        const getMany = jest
            .spyOn(SelectQueryBuilder.prototype, 'getMany')
            .mockImplementation(function (this: SelectQueryBuilder<AgentRun>) {
                sql = this.getQuery();
                return Promise.resolve([]);
            });
        try {
            await findLatestEndedRunsByAgent(dataSource.manager, [BUILDER]);
        } finally {
            getMany.mockRestore();
        }

        expect(sql).not.toContain('DISTINCT ON');
        expect(sql).toContain(
            'INNER JOIN (SELECT "ended"."agentId" AS "agentId", MAX("ended"."finishedAt") AS "finishedAt" FROM "agent_runs" "ended"',
        );
        expect(sql).toContain('GROUP BY "ended"."agentId") "latest"');
        expect(sql).toContain(
            'ON "latest"."agentId" = "run"."agentId" AND "latest"."finishedAt" = "run"."finishedAt"',
        );
    });
});
