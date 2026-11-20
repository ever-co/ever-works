import { DataSource } from 'typeorm';
import { DemoGithubRepo } from '../../../entities/demo-github-repo.entity';
import { DemoUsageCounter } from '../../../entities/demo-usage-counter.entity';
import { ENTITIES } from '../../_entities-inventory';
import { DemoGithubRepoRepository } from '../demo-github-repo.repository';
import { DemoUsageCounterRepository } from '../demo-usage-counter.repository';

const SANDBOX_A = '11111111-1111-4111-8111-111111111111';
const SANDBOX_B = '22222222-2222-4222-8222-222222222222';

describe('demo mode tables (SQLite in-memory)', () => {
    let dataSource: DataSource;
    let counters: DemoUsageCounterRepository;
    let ledger: DemoGithubRepoRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        counters = new DemoUsageCounterRepository(dataSource.getRepository(DemoUsageCounter));
        ledger = new DemoGithubRepoRepository(dataSource.getRepository(DemoGithubRepo));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(DemoUsageCounter).clear();
        await dataSource.getRepository(DemoGithubRepo).clear();
    });

    describe('DemoUsageCounterRepository', () => {
        const t0 = new Date('2026-11-19T10:00:00.000Z');
        const windowEnd = new Date('2026-11-19T10:01:00.000Z');

        it('counts 1, 2, 3 inside one window', async () => {
            expect(await counters.increment('k', windowEnd, t0)).toBe(1);
            expect(await counters.increment('k', windowEnd, new Date(t0.getTime() + 1000))).toBe(2);
            expect(await counters.increment('k', windowEnd, new Date(t0.getTime() + 2000))).toBe(3);
        });

        it('resets to 1 with the new window once the stored window has ended (boundary inclusive)', async () => {
            await counters.increment('k', windowEnd, t0);
            await counters.increment('k', windowEnd, t0);
            const nextEnd = new Date('2026-11-19T10:02:00.000Z');
            expect(await counters.increment('k', nextEnd, windowEnd)).toBe(1);
            expect(
                await counters.increment(
                    'k',
                    new Date('2026-11-19T10:03:00.000Z'),
                    new Date('2026-11-19T10:01:30.000Z'),
                ),
            ).toBe(2);
            const row = await dataSource
                .getRepository(DemoUsageCounter)
                .findOneByOrFail({ key: 'k' });
            expect(row.windowEndsAt.getTime()).toBe(nextEnd.getTime());
        });

        it('keeps keys independent', async () => {
            await counters.increment('a', windowEnd, t0);
            await counters.increment('a', windowEnd, t0);
            expect(await counters.increment('b', windowEnd, t0)).toBe(1);
        });

        it('20 concurrent increments of one key end at 20', async () => {
            const results = await Promise.all(
                Array.from({ length: 20 }, () => counters.increment('c', windowEnd, t0)),
            );
            expect([...results].sort((x, y) => x - y)).toEqual(
                Array.from({ length: 20 }, (_, i) => i + 1),
            );
            expect(await counters.peek('c', t0)).toBe(20);
        });

        it('peek returns 0 for a missing key or an ended window, the count otherwise', async () => {
            expect(await counters.peek('missing', t0)).toBe(0);
            await counters.increment('p', windowEnd, t0);
            expect(await counters.peek('p', t0)).toBe(1);
            expect(await counters.peek('p', windowEnd)).toBe(0);
        });
    });

    describe('DemoGithubRepoRepository', () => {
        it('record + pendingForSandbox returns only non-deleted rows of that sandbox', async () => {
            const one = await ledger.record({
                sandboxUserId: SANDBOX_A,
                owner: 'demo-org',
                name: 'demo-one',
                githubId: 123,
            });
            const two = await ledger.record({
                sandboxUserId: SANDBOX_A,
                owner: 'demo-org',
                name: 'demo-two',
                githubId: null,
            });
            await ledger.record({
                sandboxUserId: SANDBOX_B,
                owner: 'demo-org',
                name: 'demo-other',
                githubId: 9,
            });
            expect(one.id).toBeTruthy();
            await ledger.markDeleted(two.id, new Date('2026-11-19T10:00:00.000Z'));

            const pending = await ledger.pendingForSandbox(SANDBOX_A);
            expect(pending.map((r) => r.name)).toEqual(['demo-one']);
            expect(pending[0]).toMatchObject({
                owner: 'demo-org',
                githubId: 123,
                attempts: 0,
                deletedAt: null,
            });
        });

        it('markFailed stores the error and bumps attempts', async () => {
            const row = await ledger.record({
                sandboxUserId: SANDBOX_A,
                owner: 'demo-org',
                name: 'demo-x',
                githubId: 1,
            });
            await ledger.markFailed(row.id, 'boom');
            await ledger.markFailed(row.id, 'boom again');
            const [after] = await ledger.pendingForSandbox(SANDBOX_A);
            expect(after.attempts).toBe(2);
            expect(after.lastError).toBe('boom again');
        });

        it('has no foreign key to users (the ledger outlives the user)', async () => {
            const row = await ledger.record({
                sandboxUserId: SANDBOX_A,
                owner: 'o',
                name: 'demo-y',
                githubId: null,
            });
            expect(row.sandboxUserId).toBe(SANDBOX_A);
            const fks = dataSource.getMetadata(DemoGithubRepo).foreignKeys;
            expect(fks).toHaveLength(0);
        });
    });
});
