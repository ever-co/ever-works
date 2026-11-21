import { describe, expect, it } from 'vitest';
import { timeLeft } from './time-left';

const NOW = Date.parse('2026-11-21T22:00:00.000Z');
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('timeLeft', () => {
    it('reads days and the hours past them, rounded down', () => {
        expect(timeLeft(at(2 * 24 * HOUR + 23.9 * HOUR), NOW)).toEqual({
            kind: 'days',
            days: 2,
            hours: 23,
        });
        expect(timeLeft(at(24 * HOUR), NOW)).toEqual({ kind: 'days', days: 1, hours: 0 });
    });

    it('reads hours under a day', () => {
        expect(timeLeft(at(23.5 * HOUR), NOW)).toEqual({ kind: 'hours', hours: 23 });
        expect(timeLeft(at(HOUR), NOW)).toEqual({ kind: 'hours', hours: 1 });
    });

    it.each([[0.5 * HOUR], [0], [-5 * HOUR]])(
        'reads "soon" for %i ms left, never 0 or negative (cleanup runs once a day)',
        (offset) => {
            expect(timeLeft(at(offset), NOW)).toEqual({ kind: 'soon' });
        },
    );

    it.each([[null], [undefined], [''], ['not a date']])('reads %p as unknown', (value) => {
        expect(timeLeft(value, NOW)).toEqual({ kind: 'unknown' });
    });
});
