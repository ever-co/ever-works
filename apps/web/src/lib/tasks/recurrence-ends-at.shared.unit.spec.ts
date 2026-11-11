import { describe, expect, it } from 'vitest';
import { recurrenceEndsAtFor } from './recurrence-ends-at.shared';

describe('recurrenceEndsAtFor', () => {
    it('is the end of the chosen day in the template time zone, so the last day still runs', () => {
        // Europe/Berlin in December: UTC+1.
        expect(recurrenceEndsAtFor('2026-12-31', 'Europe/Berlin')).toBe('2026-12-31T22:59:59.999Z');
        // A 09:00 Berlin run on the 31st (08:00Z) is before that cut-off. The
        // old value, midnight UTC at the start of the 31st, was not.
        expect(new Date('2026-12-31T08:00:00Z').getTime()).toBeLessThan(
            new Date(recurrenceEndsAtFor('2026-12-31', 'Europe/Berlin')!).getTime(),
        );
    });

    it('works west of UTC and in UTC', () => {
        expect(recurrenceEndsAtFor('2026-07-01', 'America/Los_Angeles')).toBe(
            '2026-07-02T06:59:59.999Z',
        );
        expect(recurrenceEndsAtFor('2026-07-01', 'UTC')).toBe('2026-07-01T23:59:59.999Z');
    });

    it('falls back to UTC for an unknown zone and ignores a malformed date', () => {
        expect(recurrenceEndsAtFor('2026-07-01', 'Mars/Phobos')).toBe('2026-07-01T23:59:59.999Z');
        expect(recurrenceEndsAtFor('', 'UTC')).toBeUndefined();
        expect(recurrenceEndsAtFor('07/01/2026', 'UTC')).toBeUndefined();
    });
});
