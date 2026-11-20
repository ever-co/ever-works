'use server';

import {
    worksAPI,
    type QuickCreateWorkRequest,
    type QuickCreateWorkResponse,
} from '@/lib/api/works';
import { ApiResponseError } from '@/lib/api/server-api';
import type { ActionResult } from '@/app/actions/plugins';

/** How the wizard names a provider category of a provider refusal. */
const PROVIDER_LABELS: Record<string, string> = {
    pipeline: 'Pipeline',
    ai: 'AI provider',
    search: 'Search',
    contentExtractor: 'Content extractor',
    screenshot: 'Screenshot',
};

/**
 * The message the wizard shows for a failed quick-create. A provider refusal (the API's
 * `{ message, providerErrors }` envelope, the same one the Generate form gets) names each
 * missing provider on its own line, so a visitor sees what to set up rather than only
 * "One or more selected providers are not available."
 */
function quickCreateErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
        return 'Failed to start generation';
    }
    const providerErrors =
        error instanceof ApiResponseError ? error.details?.providerErrors : undefined;
    if (!providerErrors || typeof providerErrors !== 'object' || Array.isArray(providerErrors)) {
        return error.message || 'Failed to start generation';
    }
    const lines = Object.entries(providerErrors as Record<string, unknown>)
        .filter(([, message]) => typeof message === 'string' && message.length > 0)
        .map(
            ([category, message]) =>
                `${PROVIDER_LABELS[category] ?? category}: ${message as string}`,
        );
    return [error.message, ...lines].filter(Boolean).join('\n');
}

/**
 * EW-617 G4 — server action that the wizard's `CreateWorkStep` calls when
 * the user clicks "Generate now". Mirrors the existing onboarding action
 * shape (success-or-error envelope) so callers can `if (!result.success)`
 * uniformly.
 */
export async function quickCreateWorkAction(
    body: QuickCreateWorkRequest,
): Promise<ActionResult<QuickCreateWorkResponse>> {
    try {
        const data = await worksAPI.quickCreate(body);
        return { success: true, data };
    } catch (error) {
        console.error('Failed to quick-create work:', error);
        return {
            success: false,
            error: quickCreateErrorMessage(error),
        };
    }
}
