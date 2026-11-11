import { computeNextTemplateOccurrence, fromFloatingTime, toFloatingTime } from '../recurrence';

const next = (rule: string, from: string, timezone?: string | null) =>
    computeNextTemplateOccurrence({ rule, from: new Date(from), timezone })?.toISOString() ?? null;

const nextCron = (cron: string, from: string, timezone?: string | null) =>
    computeNextTemplateOccurrence({ cron, from: new Date(from), timezone })?.toISOString() ?? null;

describe('recurring Tasks run at the wall-clock time of their time zone', () => {
    it('"Monday 09:00" in Europe/Berlin fires at 09:00 Berlin time, not 09:00 UTC', () => {
        // November: CET = UTC+1. It used to answer 09:00Z (10:00 in Berlin).
        expect(
            next(
                'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
                '2026-11-08T12:00:00Z',
                'Europe/Berlin',
            ),
        ).toBe('2026-11-09T08:00:00.000Z');
        // July: CEST = UTC+2.
        expect(
            next(
                'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
                '2026-07-04T12:00:00Z',
                'Europe/Berlin',
            ),
        ).toBe('2026-07-06T07:00:00.000Z');
    });

    it('keeps 09:00 local across the DST change', () => {
        // Europe/Berlin leaves summer time on 2026-10-25.
        const rule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
        const first = next(rule, '2026-10-24T00:00:00Z', 'Europe/Berlin');
        expect(first).toBe('2026-10-24T07:00:00.000Z');
        const second = next(rule, first!, 'Europe/Berlin');
        expect(second).toBe('2026-10-25T08:00:00.000Z');
    });

    it('applies the zone to cron cadences too', () => {
        // America/New_York in November: EST = UTC-5.
        expect(nextCron('0 9 * * 1', '2026-11-08T12:00:00Z', 'America/New_York')).toBe(
            '2026-11-09T14:00:00.000Z',
        );
    });

    it('leaves UTC templates (and an unknown zone) on UTC', () => {
        expect(next('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '2026-11-09T10:00:00Z', 'UTC')).toBe(
            '2026-11-10T09:00:00.000Z',
        );
        expect(next('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '2026-11-09T10:00:00Z', null)).toBe(
            '2026-11-10T09:00:00.000Z',
        );
        expect(next('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '2026-11-09T10:00:00Z', 'Mars/Phobos')).toBe(
            '2026-11-10T09:00:00.000Z',
        );
        expect(nextCron('0 9 * * *', '2026-11-09T10:00:00Z', null)).toBe(
            '2026-11-10T09:00:00.000Z',
        );
    });

    it('fires on whole minutes — no seconds carried over from "now"', () => {
        // It came back as 09:00:35 when the computation ran at hh:mm:35.
        expect(next('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '2026-11-09T10:12:35.512Z', 'UTC')).toBe(
            '2026-11-10T09:00:00.000Z',
        );
    });

    it('reads an hour without minutes as :00', () => {
        expect(next('FREQ=DAILY;BYHOUR=9', '2026-11-09T10:37:00Z', 'UTC')).toBe(
            '2026-11-10T09:00:00.000Z',
        );
    });

    it('anchors a rule without a time on the slot that fired, so it does not drift', () => {
        // A daily rule with no BYHOUR keeps the time of day of `from`.
        expect(next('FREQ=DAILY', '2026-11-09T06:30:00Z', 'UTC')).toBe('2026-11-10T06:30:00.000Z');
    });

    it('still honours recurrenceEndsAt as an instant', () => {
        expect(
            computeNextTemplateOccurrence({
                rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
                from: new Date('2026-11-09T12:00:00Z'),
                timezone: 'Europe/Berlin',
                recurrenceEndsAt: new Date('2026-11-10T07:59:00Z'),
            }),
        ).toBeNull();
    });
});

describe('floating time helpers', () => {
    it('round-trip an instant through a zone', () => {
        const instant = new Date('2026-03-15T14:45:10.250Z');
        for (const zone of ['Asia/Kolkata', 'America/Los_Angeles', 'Australia/Lord_Howe', 'UTC']) {
            expect(fromFloatingTime(toFloatingTime(instant, zone), zone).toISOString()).toBe(
                instant.toISOString(),
            );
        }
    });

    it('give the wall-clock time in the zone', () => {
        expect(toFloatingTime(new Date('2026-11-09T08:00:00Z'), 'Asia/Kolkata').toISOString()).toBe(
            '2026-11-09T13:30:00.000Z',
        );
    });
});
