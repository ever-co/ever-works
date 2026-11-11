import {
    fleetScheduleCadenceToCron,
    previewFleetScheduleFires,
    type FleetScheduleCadence,
} from '@ever-works/contracts';
import { computeNextTemplateOccurrence, toFloatingTime } from '../recurrence';

/**
 * An Agent-session schedule on a computer IS a recurring Task (R-29): the
 * dialog and the confirmation card preview its next runs with
 * `previewFleetScheduleFires` (contracts), and the Task dispatcher runs it
 * through `computeNextTemplateOccurrence` with the cron and the computer's
 * zone that `FleetScheduleTasksAdapter` files. Review of #3166, finding 4: on
 * the autumn change they disagreed by an hour (cron `30 2 * * *` in Berlin on
 * 2026-10-25: preview 00:30Z, the first 02:30; run 01:30Z, the second). The
 * runner now reads wall times with the preview's own helper, and this spec
 * holds the two to the same answers around every 2026 clock change.
 */

const cadence = (kind: FleetScheduleCadence['kind'], value: string): FleetScheduleCadence =>
    kind === 'daily' || kind === 'weekdays'
        ? { kind, at: value, timezone: 'node' }
        : { kind, expr: value, timezone: 'node' };

/** What the Task dispatcher will do: each next run computed from the one before. */
function runnerFires(schedule: FleetScheduleCadence, zone: string, afterMs: number, count = 3) {
    const cron = fleetScheduleCadenceToCron(schedule)!;
    const out: number[] = [];
    let from = new Date(afterMs);
    for (let index = 0; index < count; index += 1) {
        const next = computeNextTemplateOccurrence({ cron, from, timezone: zone });
        if (!next) break;
        out.push(next.getTime());
        from = next;
    }
    return out;
}

const iso = (values: number[]) => values.map((ms) => new Date(ms).toISOString());

describe('the Fleet schedule preview and the Task dispatcher agree', () => {
    it('Berlin, cron 30 2 * * *, on the autumn change: both answer the first 02:30 (00:30Z)', () => {
        const now = Date.parse('2026-10-24T12:00:00Z');
        const schedule = cadence('cron', '30 2 * * *');
        expect(iso(runnerFires(schedule, 'Europe/Berlin', now))).toEqual([
            '2026-10-25T00:30:00.000Z',
            '2026-10-26T01:30:00.000Z',
            '2026-10-27T01:30:00.000Z',
        ]);
        expect(iso(previewFleetScheduleFires(schedule, 'Europe/Berlin', now, 3))).toEqual(
            iso(runnerFires(schedule, 'Europe/Berlin', now)),
        );
    });

    const SCHEDULES = [
        cadence('daily', '02:30'),
        cadence('daily', '00:00'),
        cadence('weekdays', '01:30'),
        cadence('interval', '30'),
        cadence('cron', '15 2 * * *'),
    ];
    const ZONES = [
        'Europe/Berlin',
        'America/New_York',
        'America/Santiago',
        'Australia/Sydney',
        'Australia/Lord_Howe',
    ];

    it.each(ZONES)(
        '%s: the same next three runs from every 40 minutes around each 2026 clock change',
        (zone) => {
            const offset = (at: number) => toFloatingTime(new Date(at), zone).getTime() - at;
            const changes: number[] = [];
            for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 86_400_000) {
                if (offset(ms) !== offset(ms + 86_400_000)) changes.push(ms);
            }
            expect(changes.length).toBeGreaterThan(0);
            for (const day of changes) {
                const last = day + 36 * 3_600_000;
                for (let now = day - 12 * 3_600_000; now < last; now += 40 * 60_000) {
                    for (const schedule of SCHEDULES) {
                        const label = `${schedule.kind} ${schedule.at ?? schedule.expr} from ${iso([now])}`;
                        expect([label, ...iso(runnerFires(schedule, zone, now))]).toEqual([
                            label,
                            ...iso(previewFleetScheduleFires(schedule, zone, now, 3)),
                        ]);
                    }
                }
            }
        },
    );
});
