'use server';

import { redirect } from 'next/navigation';
import type { HomeBlockId, HomeSummaryDto } from '@ever-works/contracts';
import { createTaskAction } from '@/app/actions/tasks';
import { canSubmitComposer, deriveTaskTitle } from '@/components/home/home.shared';
import { homeAPI, type HomeSummaryParams } from '@/lib/api/home';
import { ApiResponseError } from '@/lib/api/server-api';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

// Security: defense-in-depth auth guard at the web layer, the same one every
// sibling action file uses. It rejects unauthenticated callers before any
// request is issued; authenticated callers are unaffected (cache()d).
async function requireHomeAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

/**
 * The composed morning read.
 *
 * `tz` is an explicit override (it wins over the profile). `browserTz` is the
 * browser's own zone, which the API uses ONLY when the profile has no
 * timezone — the dashboard always sends it, so the profile keeps winning when
 * set.
 *
 * A `400` is retried, never shown as a blank screen: first without the `tz` a
 * runtime may not know, then without `browserTz` too — an API older than the
 * `browserTz` parameter refuses any unknown query parameter
 * (`forbidNonWhitelisted`). The last answer resolves to the profile timezone
 * or UTC and says so. Any other failure is thrown at once.
 */
export async function getHomeSummaryAction(
    tz?: string | null,
    browserTz?: string | null,
): Promise<HomeSummaryDto> {
    await requireHomeAuth();
    const attempts = homeSummaryAttempts(tz, browserTz);
    for (let i = 0; ; i += 1) {
        const params = attempts[i];
        try {
            return await (Object.keys(params).length > 0
                ? homeAPI.summary(params)
                : homeAPI.summary());
        } catch (error) {
            const refused = error instanceof ApiResponseError && error.statusCode === 400;
            if (!refused || i === attempts.length - 1) throw error;
        }
    }
}

/**
 * The parameter sets a summary read tries, in order, each dropping what an API
 * may refuse: an unknown `tz`, then a `browserTz` an older API does not know.
 * Never empty; no set is tried twice.
 */
function homeSummaryAttempts(tz?: string | null, browserTz?: string | null): HomeSummaryParams[] {
    const candidates: HomeSummaryParams[] = [{ tz, browserTz }, { browserTz }, { tz }, {}];
    const seen = new Set<string>();
    const attempts: HomeSummaryParams[] = [];
    for (const candidate of candidates) {
        const params: HomeSummaryParams = {};
        if (candidate.tz) params.tz = candidate.tz;
        if (candidate.browserTz) params.browserTz = candidate.browserTz;
        const key = JSON.stringify(params);
        if (seen.has(key)) continue;
        seen.add(key);
        attempts.push(params);
    }
    return attempts;
}

/** Re-read one block of the summary (a per-block retry). */
export async function refreshHomeBlockAction(
    blockId: HomeBlockId,
    tz?: string | null,
    browserTz?: string | null,
): Promise<HomeSummaryDto> {
    await requireHomeAuth();
    const params: HomeSummaryParams = { blocks: [blockId] };
    if (tz) params.tz = tz;
    if (browserTz) params.browserTz = browserTz;
    return homeAPI.summary(params);
}

export type CreateHomeTaskResult =
    | { ok: true; task: { id: string; title: string } }
    | { ok: false; reason: 'invalid' | 'throttled' | 'failed' };

/**
 * The composer: one sentence becomes one Task, through the existing Task
 * create action — the same endpoint, throttle and audit as the Task form.
 * Only a title and the sentence are sent: no owner and no status, so the Task
 * is unscoped and lands in the board's first lane (the create default).
 *
 * Failures come back as a reason rather than a thrown error, because a server
 * action's error message does not survive to the browser and the composer has
 * to tell a throttle apart from anything else.
 */
export async function createHomeTaskAction(text: string): Promise<CreateHomeTaskResult> {
    await requireHomeAuth();
    if (typeof text !== 'string' || !canSubmitComposer(text)) {
        return { ok: false, reason: 'invalid' };
    }
    try {
        const task = await createTaskAction({
            title: deriveTaskTitle(text),
            description: text.trim(),
        });
        return { ok: true, task: { id: task.id, title: task.title } };
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 429) {
            return { ok: false, reason: 'throttled' };
        }
        console.error('[home] composer: POST /api/tasks failed', error);
        return { ok: false, reason: 'failed' };
    }
}
