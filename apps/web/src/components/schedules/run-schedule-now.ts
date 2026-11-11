import { runScheduleNow } from '@/app/actions/dashboard/schedules';

/** The refusal of a recurring Task at its open-instance limit (`recurrenceMaxOpenInstances`). */
export const SCHEDULE_TOO_MANY_OPEN = 'SCHEDULE_TOO_MANY_OPEN';

/**
 * Run a schedule now. When a recurring Task answers that too many earlier runs are still open,
 * running anyway is the owner's call: `askToRunAnyway` asks (a `window.confirm` in the callers),
 * and only a yes sends the same request again with `force`. Answers the final response, or
 * `null` when the owner declined (nothing ran; the caller shows nothing).
 *
 * One place for the Schedules menu and a computer's Schedules tab, so both read a refusal the
 * same way.
 */
export async function runScheduleNowAskingPastLimit(
    id: string,
    options: { confirm?: boolean },
    askToRunAnyway: () => boolean,
): Promise<Awaited<ReturnType<typeof runScheduleNow>> | null> {
    const first = await runScheduleNow(id, options);
    if (first.ok || first.code !== SCHEDULE_TOO_MANY_OPEN) return first;
    if (!askToRunAnyway()) return null;
    return runScheduleNow(id, { ...options, force: true });
}
