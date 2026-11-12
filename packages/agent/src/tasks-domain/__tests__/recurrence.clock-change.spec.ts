import { computeNextTemplateOccurrence, toFloatingTime } from '../recurrence';

/**
 * Recurring Tasks across clock changes, in every zone (review of #3166,
 * finding 1). Each spec passes its zone and its instants explicitly, so none
 * depends on the machine's TZ.
 *
 * West of UTC a run time inside the spring-forward gap used to resolve to the
 * hour BEFORE the gap, which is the slot that had just fired: the next run
 * came out equal to the last one, the per-minute dispatcher found the template
 * due on every tick, and it spawned a Task and an agent run every minute.
 */

const nextRule = (rule: string, from: string, timezone: string, now?: string) =>
    computeNextTemplateOccurrence({
        rule,
        from: new Date(from),
        now: now ? new Date(now) : null,
        timezone,
    })?.toISOString() ?? null;

const nextCron = (cron: string, from: string, timezone: string, now?: string) =>
    computeNextTemplateOccurrence({
        cron,
        from: new Date(from),
        now: now ? new Date(now) : null,
        timezone,
    })?.toISOString() ?? null;

/** Successive next runs, each computed from the one before (what the dispatcher does). */
function chain(next: (from: string) => string | null, from: string, count: number): string[] {
    const out: string[] = [];
    let cursor = from;
    for (let index = 0; index < count; index += 1) {
        const value = next(cursor);
        if (value === null) break;
        out.push(value);
        cursor = value;
    }
    return out;
}

describe('a run time inside the spring-forward gap, west of UTC (the reviewer’s reproductions)', () => {
    it('America/New_York daily 02:30 on 2026-03-08 runs at 03:30 EDT, then 02:30 again', () => {
        // 02:30 does not exist that day (02:00 EST → 03:00 EDT). It used to answer
        // 06:30Z (01:30 EST) and then 06:30Z, 06:30Z, 06:30Z… forever.
        const runs = chain(
            (from) => nextRule('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', from, 'America/New_York'),
            '2026-03-07T07:30:00Z',
            3,
        );
        expect(runs).toEqual([
            '2026-03-08T07:30:00.000Z', // 03:30 EDT, as far past the jump as 02:30 was into it
            '2026-03-09T06:30:00.000Z', // 02:30 EDT
            '2026-03-10T06:30:00.000Z',
        ]);
        // The same as cron.
        expect(
            chain(
                (from) => nextCron('30 2 * * *', from, 'America/New_York'),
                '2026-03-07T07:30:00Z',
                3,
            ),
        ).toEqual(runs);
    });

    it('America/Los_Angeles daily 02:00 on 2026-03-08 runs at 03:00 PDT', () => {
        expect(
            chain(
                (from) => nextRule('FREQ=DAILY;BYHOUR=2;BYMINUTE=0', from, 'America/Los_Angeles'),
                '2026-03-07T10:00:00Z',
                3,
            ),
        ).toEqual([
            '2026-03-08T10:00:00.000Z', // 03:00 PDT
            '2026-03-09T09:00:00.000Z', // 02:00 PDT
            '2026-03-10T09:00:00.000Z',
        ]);
    });

    it('America/Santiago daily 00:00 on 2026-09-06 (the clock jumps at midnight) runs at 01:00', () => {
        expect(
            chain(
                (from) => nextRule('FREQ=DAILY;BYHOUR=0;BYMINUTE=0', from, 'America/Santiago'),
                '2026-09-05T04:00:00Z',
                3,
            ),
        ).toEqual([
            '2026-09-06T04:00:00.000Z', // 01:00 -03
            '2026-09-07T03:00:00.000Z', // 00:00 -03
            '2026-09-08T03:00:00.000Z',
        ]);
    });

    it('America/Havana daily 00:30 on 2026-03-08 (the clock jumps at midnight) runs at 01:30', () => {
        expect(
            chain(
                (from) => nextCron('30 0 * * *', from, 'America/Havana'),
                '2026-03-07T05:30:00Z',
                3,
            ),
        ).toEqual([
            '2026-03-08T05:30:00.000Z', // 01:30 CDT
            '2026-03-09T04:30:00.000Z', // 00:30 CDT
            '2026-03-10T04:30:00.000Z',
        ]);
    });

    it('a gap slot is still owed when "now" is past the jump but before the slot runs', () => {
        // 03:10 EDT on 2026-03-08: the 02:30 slot runs at 03:30 EDT, twenty minutes on.
        expect(nextCron('30 2 * * *', '2026-03-08T07:10:00Z', 'America/New_York')).toBe(
            '2026-03-08T07:30:00.000Z',
        );
        // At 03:30 EDT it has run: tomorrow's 02:30.
        expect(nextCron('30 2 * * *', '2026-03-08T07:30:00Z', 'America/New_York')).toBe(
            '2026-03-09T06:30:00.000Z',
        );
    });
});

describe('the fall-back hour runs once', () => {
    it('Europe/Berlin daily 02:30 on 2026-10-25 runs at the first 02:30 (CEST), once', () => {
        const runs = chain(
            (from) => nextCron('30 2 * * *', from, 'Europe/Berlin'),
            '2026-10-24T00:30:00Z',
            3,
        );
        expect(runs).toEqual([
            '2026-10-25T00:30:00.000Z', // 02:30 CEST — not 01:30Z (02:30 CET) as well
            '2026-10-26T01:30:00.000Z', // 02:30 CET
            '2026-10-27T01:30:00.000Z',
        ]);
        expect(
            chain(
                (from) => nextRule('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', from, 'Europe/Berlin'),
                '2026-10-24T00:30:00Z',
                3,
            ),
        ).toEqual(runs);
    });

    it('America/New_York hourly on 2026-11-01 runs 01:00 once, then 02:00 EST', () => {
        // 01:00–01:59 happens twice (EDT, then EST).
        expect(
            chain(
                (from) => nextCron('0 * * * *', from, 'America/New_York'),
                '2026-11-01T04:00:00Z', // 00:00 EDT
                3,
            ),
        ).toEqual([
            '2026-11-01T05:00:00.000Z', // 01:00 EDT
            '2026-11-01T07:00:00.000Z', // 02:00 EST — 01:00 EST (06:00Z) does not run again
            '2026-11-01T08:00:00.000Z',
        ]);
    });

    it('from inside the repeated hour, the next run is after "now" and runs no wall time twice', () => {
        // 01:10 EST, the second pass: 01:15, 01:30 and 01:45 already ran (EDT), so the next
        // run is 02:00 EST — never an instant before "now", never a second 01:15.
        expect(nextCron('*/15 * * * *', '2026-11-01T06:10:00Z', 'America/New_York')).toBe(
            '2026-11-01T07:00:00.000Z',
        );
        expect(nextRule('FREQ=HOURLY;BYMINUTE=0', '2026-11-01T06:10:00Z', 'America/New_York')).toBe(
            '2026-11-01T07:00:00.000Z',
        );
    });
});

/** `YYYY-MM-DD` of an instant on the wall clock of `zone`. */
const localDate = (iso: string, zone: string) =>
    toFloatingTime(new Date(iso), zone).toISOString().slice(0, 10);

const ZONES = [
    // West of UTC, northern hemisphere: gaps at 02:00 / at midnight.
    'America/New_York',
    'America/Los_Angeles',
    'America/Havana',
    // West of UTC, southern hemisphere: the gap is at midnight.
    'America/Santiago',
    // East of UTC, both hemispheres, incl. a 30-minute change.
    'Europe/Berlin',
    'Australia/Sydney',
    'Australia/Lord_Howe',
    // No clock change at all.
    'Asia/Kolkata',
];

/**
 * Daily times that sit inside a skipped or a repeated stretch somewhere above:
 * 00:00 (Santiago and Havana jump at midnight; Havana repeats 00:xx), 01:45
 * (repeated in New York, Los Angeles and Lord Howe), 02:15 (skipped in New
 * York, Los Angeles, Berlin, Sydney and Lord Howe; repeated in Berlin and
 * Sydney) and 23:30 (repeated in Santiago).
 */
const DAILY_TIMES = [
    [0, 0],
    [1, 45],
    [2, 15],
    [23, 30],
];

const DAILY_CASES = ZONES.filter((zone) => zone !== 'Asia/Kolkata').flatMap((zone) => [
    [zone, 'RRULE'],
    [zone, 'cron'],
]);

describe('every day of 2026, in zones on both sides of UTC and both hemispheres', () => {
    it.each(DAILY_CASES)(
        '%s (%s): each daily run is strictly later than the one before and lands on the next local day',
        (zone, dialect) => {
            for (const [hour, minute] of DAILY_TIMES) {
                const next =
                    dialect === 'RRULE'
                        ? (from: string, now: string) =>
                              nextRule(
                                  `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`,
                                  from,
                                  zone,
                                  now,
                              )
                        : (from: string, now: string) =>
                              nextCron(`${minute} ${hour} * * *`, from, zone, now);
                let from = '2026-01-01T00:00:00.000Z';
                let previousDay: string | null = null;
                for (let day = 0; day < 366; day += 1) {
                    // The dispatcher runs a little after the slot it fires.
                    const now = new Date(new Date(from).getTime() + 30_000).toISOString();
                    const run = next(from, now);
                    expect(run).not.toBeNull();
                    // Strictly after the slot that fired AND after "now": never the same
                    // instant again (the fire-every-minute loop), never earlier.
                    expect(new Date(run!).getTime()).toBeGreaterThan(new Date(now).getTime());
                    // Exactly one run per local day: none twice (fall back), none missing
                    // (spring forward).
                    const runDay = localDate(run!, zone);
                    if (previousDay !== null) {
                        const expected = new Date(`${previousDay}T00:00:00Z`);
                        expected.setUTCDate(expected.getUTCDate() + 1);
                        expect(`${hour}:${minute} ${runDay}`).toBe(
                            `${hour}:${minute} ${expected.toISOString().slice(0, 10)}`,
                        );
                    }
                    previousDay = runDay;
                    from = run!;
                }
            }
        },
    );

    it.each(ZONES)(
        '%s: an hourly cadence over each clock change runs every wall-clock hour once, in order',
        (zone) => {
            // The days around this year's changes in the zone (none in Kolkata).
            const days: string[] = [];
            for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 86_400_000) {
                const offset = (at: number) => toFloatingTime(new Date(at), zone).getTime() - at;
                if (offset(ms) !== offset(ms + 86_400_000)) days.push(new Date(ms).toISOString());
            }
            for (const day of days) {
                const start = new Date(new Date(day).getTime() - 86_400_000).toISOString();
                const end = new Date(day).getTime() + 2 * 86_400_000;
                let from = start;
                const seen = new Set<string>();
                while (new Date(from).getTime() < end) {
                    const run = nextCron('0 * * * *', from, zone);
                    expect(run).not.toBeNull();
                    expect(new Date(run!).getTime()).toBeGreaterThan(new Date(from).getTime());
                    // At most two hours apart (only the repeated hour's second pass is passed
                    // over; a wall hour is never skipped)…
                    expect(new Date(run!).getTime() - new Date(from).getTime()).toBeLessThanOrEqual(
                        2 * 3_600_000,
                    );
                    // …and no wall-clock hour runs twice.
                    const wall = toFloatingTime(new Date(run!), zone).toISOString().slice(0, 13);
                    expect(seen.has(wall)).toBe(false);
                    seen.add(wall);
                    from = run!;
                }
            }
        },
    );
});
