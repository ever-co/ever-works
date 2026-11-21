'use server';

import { getAuthFromCookie } from '@/lib/auth';
import { workAPI } from '@/lib/api/work';
import { ApiResponseError } from '@/lib/api/server-api';
import type { WorkStatusResult } from '@/components/onboarding/generation-console';

/**
 * The onboarding console's status read: `GET /api/works/:id`, answered as the
 * Work's `generateStatus` only, or as WHY it could not be read.
 *
 * `getWorkForStatusRefresh` (what the Work page polls) answers `null` for every
 * failure alike, so a visitor whose (anonymous) session ended saw "Can't reach
 * the server — still trying" forever. Here an ended session and a Work that is
 * not there (any more) are told apart from a transient error: the console
 * stops on the first two and says what to do, and backs off on the third.
 */
export async function getWorkGenerationStatusAction(workId: string): Promise<WorkStatusResult> {
    const user = await getAuthFromCookie();
    if (!user) {
        return { ok: false, reason: 'unauthenticated' };
    }

    try {
        const { work } = await workAPI.get(workId);
        return { ok: true, status: work.generateStatus ?? {} };
    } catch (error) {
        const statusCode = error instanceof ApiResponseError ? error.statusCode : undefined;
        if (statusCode === 401) {
            return { ok: false, reason: 'unauthenticated' };
        }
        if (statusCode === 403 || statusCode === 404) {
            return { ok: false, reason: 'not-found' };
        }
        console.error('Failed to read the generation status for the onboarding console:', error);
        return { ok: false, reason: 'error' };
    }
}
