import { DataSource } from 'typeorm';
import { PinLegacyRecurringTemplateZonesToUtc1798031660000 } from '../1798031660000-PinLegacyRecurringTemplateZonesToUtc';

/**
 * #3166 on deploy — recurring templates saved before it carry a zone the
 * dispatcher never applied (every cadence ran in UTC). From #3166 on the zone
 * applies, so each such template would move by its zone's offset after one
 * more fire. This one-time step sets those templates to `UTC`, the zone they
 * have always run in, so nothing fires at a different time on deploy. Asserted
 * on the PHYSICAL table (in-memory better-sqlite3).
 */
describe('PinLegacyRecurringTemplateZonesToUtc1798031660000', () => {
    let dataSource: DataSource;
    const migration = new PinLegacyRecurringTemplateZonesToUtc1798031660000();
    const NEXT = '2026-11-12 09:00:00';

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    const zones = async () =>
        Object.fromEntries(
            (
                (await dataSource.query(
                    `SELECT "id", "recurrenceTimezone", "nextOccurrenceAt" FROM "tasks" ORDER BY "id"`,
                )) as Array<{
                    id: string;
                    recurrenceTimezone: string | null;
                    nextOccurrenceAt: string | null;
                }>
            ).map((row) => [row.id, [row.recurrenceTimezone, row.nextOccurrenceAt]]),
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "tasks" ("id" varchar PRIMARY KEY, "isRecurring" boolean NOT NULL DEFAULT (0), "recurrenceRule" varchar(200), "recurrenceCron" varchar(120), "recurrenceTimezone" varchar(64) DEFAULT ('UTC'), "nextOccurrenceAt" datetime, "recurrencePausedAt" datetime, "parentRecurringTaskId" varchar)`,
        );
        const insert = (
            id: string,
            isRecurring: boolean,
            zone: string | null,
            over: { cron?: string; paused?: boolean; parent?: string } = {},
        ) =>
            dataSource.query(
                `INSERT INTO "tasks" ("id", "isRecurring", "recurrenceRule", "recurrenceCron", "recurrenceTimezone", "nextOccurrenceAt", "recurrencePausedAt", "parentRecurringTaskId") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    isRecurring ? 1 : 0,
                    isRecurring && !over.cron ? 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' : null,
                    over.cron ?? null,
                    zone,
                    isRecurring ? NEXT : null,
                    over.paused ? NEXT : null,
                    over.parent ?? null,
                ],
            );
        // Saved from the RRULE form (browser zone) and by a Fleet session schedule (computer zone).
        await insert('rrule-berlin', true, 'Europe/Berlin');
        await insert('fleet-cron-ny', true, 'America/New_York', { cron: '30 2 * * *' });
        await insert('paused-kolkata', true, 'Asia/Kolkata', { paused: true });
        // Already UTC (the cron form), or no zone at all: nothing to change.
        await insert('utc', true, 'UTC');
        await insert('etc-utc', true, 'Etc/UTC');
        await insert('no-zone', true, null);
        // Not a template: an instance, and a Task that stopped recurring.
        await insert('instance', false, null, { parent: 'rrule-berlin' });
        await insert('stopped', false, 'Europe/Paris');
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('sets the recurring templates with a non-UTC zone to UTC and leaves every other row and every next fire alone', async () => {
        await run('up');

        expect(await zones()).toEqual({
            'rrule-berlin': ['UTC', NEXT],
            'fleet-cron-ny': ['UTC', NEXT],
            'paused-kolkata': ['UTC', NEXT],
            utc: ['UTC', NEXT],
            'etc-utc': ['Etc/UTC', NEXT],
            'no-zone': [null, NEXT],
            instance: [null, null],
            stopped: ['Europe/Paris', null],
        });
    });

    it('is idempotent, and down changes nothing', async () => {
        await run('up');
        const once = await zones();
        await run('up');
        expect(await zones()).toEqual(once);
        await run('down');
        expect(await zones()).toEqual(once);
    });

    it('is a no-op without the tasks table', async () => {
        await dataSource.query(`DROP TABLE "tasks"`);
        await expect(run('up')).resolves.toBeUndefined();
    });
});
