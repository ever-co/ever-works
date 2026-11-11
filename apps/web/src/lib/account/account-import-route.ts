import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { accountTransferAPI } from '@/lib/api/account-transfer';
import type { AccountExportPayload, ConflictResolution } from '@/lib/api/account-transfer.types';
import { getAuthFromCookie } from '@/lib/auth';
import { accountExportPayloadSchema } from '@/app/actions/account-transfer-schemas';
import { ACCOUNT_IMPORT_MAX_BYTES } from './account-import.shared';

/**
 * The account import's route handlers (`/api/account/import/{preview,apply}`).
 *
 * The import used to go through two server actions (`previewImport`,
 * `applyImport`), and Next caps every server action body at 1 MB — so an
 * account export over 1 MB could be exported but never imported back (the
 * dialog showed a generic "previewError"). Raising the server-action limit
 * would raise it for EVERY action; these two routes take the large body
 * instead, with their own cap (the API's import limit, 25 MB), and keep the
 * actions' checks: a signed-in user, the payload's shape and count caps, and
 * the same `{ success, data, error }` answer.
 */

type ImportAnswer<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

function answer<T>(body: ImportAnswer<T>, status = 200) {
    return NextResponse.json(body, { status });
}

/** Read and parse the JSON body, refusing one over the cap BEFORE buffering it where possible. */
async function readJsonBody(
    request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
    const declared = Number(request.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > ACCOUNT_IMPORT_MAX_BYTES) {
        return {
            ok: false,
            status: 413,
            error: 'The export is larger than the import limit (25 MB).',
        };
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > ACCOUNT_IMPORT_MAX_BYTES) {
        return {
            ok: false,
            status: 413,
            error: 'The export is larger than the import limit (25 MB).',
        };
    }
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false, status: 400, error: 'The import body is not JSON.' };
    }
}

const resolutionsSchema = z.array(z.unknown()).max(10_000);

export async function handleAccountImport(request: Request, step: 'preview' | 'apply') {
    const user = await getAuthFromCookie();
    if (!user) {
        return answer({ success: false, data: null, error: 'Not signed in.' }, 401);
    }
    const body = await readJsonBody(request);
    if (!body.ok) {
        return answer({ success: false, data: null, error: body.error }, body.status);
    }
    const input = body.value as { payload?: unknown; resolutions?: unknown } | null;
    const payload = accountExportPayloadSchema.safeParse(input?.payload);
    if (!payload.success) {
        return answer({ success: false, data: null, error: 'Invalid import payload shape' }, 400);
    }
    try {
        if (step === 'preview') {
            const data = await accountTransferAPI.previewImport(
                input!.payload as AccountExportPayload,
            );
            return answer({ success: true, data, error: null });
        }
        const resolutions = resolutionsSchema.safeParse(input?.resolutions ?? []);
        if (!resolutions.success) {
            return answer(
                {
                    success: false,
                    data: null,
                    error: 'Invalid resolutions array (too large or wrong shape)',
                },
                400,
            );
        }
        const data = await accountTransferAPI.applyImport(
            input!.payload as AccountExportPayload,
            resolutions.data as ConflictResolution[],
        );
        return answer({ success: true, data, error: null });
    } catch (error) {
        return answer({
            success: false,
            data: null,
            error:
                error instanceof Error
                    ? error.message
                    : step === 'preview'
                      ? 'Failed to preview import'
                      : 'Failed to apply import',
        });
    }
}
