/**
 * The `recurrenceEndsAt` instant for a recurring Task whose "Ends on" date
 * picker says `date` (`YYYY-MM-DD`): the END of that day in the template's
 * time zone, so a run on the chosen last day still happens.
 *
 * The form sent `new Date(date).toISOString()` — midnight UTC at the START of
 * the day — so "every day at 09:00, ends 2026-12-31" never ran on the 31st
 * (09:00 is after midnight), and east of UTC the cut-off fell on the day
 * before.
 */
export function recurrenceEndsAtFor(date: string, timeZone: string): string | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!match) return undefined;
    const [, y, m, d] = match;
    // 23:59:59.999 wall-clock time on that day, as a "floating" UTC date.
    const floating = Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999);
    const zone = validZone(timeZone);
    if (!zone) return new Date(floating).toISOString();
    let guess = floating;
    for (let i = 0; i < 4; i += 1) {
        const offset = wallClock(new Date(guess), zone) - guess;
        const next = floating - offset;
        if (next === guess) break;
        guess = next;
    }
    return new Date(guess).toISOString();
}

function validZone(timeZone: string): string | null {
    if (!timeZone) return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return timeZone;
    } catch {
        return null;
    }
}

/** `instant`'s wall-clock time in `timeZone`, as epoch ms of the same UTC fields. */
function wallClock(instant: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(instant);
    const field = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value ?? 0);
    return Date.UTC(
        field('year'),
        field('month') - 1,
        field('day'),
        field('hour'),
        field('minute'),
        field('second'),
        instant.getUTCMilliseconds(),
    );
}
