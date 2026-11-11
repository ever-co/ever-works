import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { accountTransferAPI } from '@/lib/api/account-transfer';
import type { AccountExportPayload, ConflictResolution } from '@/lib/api/account-transfer.types';
import { getAuthFromCookie } from '@/lib/auth';
import { BROWSER_WORKSPACE_SCOPE_HEADER, parseWorkspaceSelector } from '@/lib/workspace-scope';
import { accountExportPayloadSchema } from '@/app/actions/account-transfer-schemas';
import { formatImportLimit, resolveAccountImportMaxBytes } from './account-import.shared';

/**
 * The account import's route handlers (`/api/account/import/{preview,apply}`).
 *
 * The import used to go through two server actions (`previewImport`,
 * `applyImport`), and Next caps every server action body at 1 MB — so an
 * account export over 1 MB could be exported but never imported back (the
 * dialog showed a generic "previewError"). Raising the server-action limit
 * would raise it for EVERY action; these two routes take the large body
 * instead, with their own cap (the API's import limit: 25 MB, or
 * `ACCOUNT_IMPORT_BODY_LIMIT` as the API reads it), and keep the actions'
 * checks: a signed-in user, the payload's shape and count caps, and the same
 * `{ success, data, error }` answer.
 *
 * Cheap checks run before the body is read: the session, then the workspace
 * selector `serverFetch` needs anyway (a request without it was read and
 * parsed in full only to be refused). The body is read as a stream with a
 * running byte count, so a chunked upload without `content-length` is cut off
 * at the limit instead of being buffered whole.
 */

type ImportAnswer<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

function answer<T>(body: ImportAnswer<T>, status = 200) {
    return NextResponse.json(body, { status });
}

type BodyRead = { ok: true; value: unknown } | { ok: false; status: number; error: string };

function tooLarge(maxBytes: number): BodyRead {
    return {
        ok: false,
        status: 413,
        error: `The export is larger than the import limit (${formatImportLimit(maxBytes)}).`,
    };
}

/**
 * Read and parse the JSON body, refusing one over `maxBytes` by its declared
 * length before reading, and while reading when it declares none (or lies).
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyRead> {
    const declared = Number(request.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
        return tooLarge(maxBytes);
    }
    if (!request.body) {
        return { ok: false, status: 400, error: 'The import body is not JSON.' };
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return tooLarge(maxBytes);
        }
        chunks.push(value);
    }
    // One joined copy, decoded once; the chunk list is dropped right after.
    const text = new TextDecoder().decode(Buffer.concat(chunks, total));
    chunks.length = 0;
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
    try {
        parseWorkspaceSelector(request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER));
    } catch {
        return answer({ success: false, data: null, error: 'Invalid workspace scope' }, 400);
    }
    const maxBytes = resolveAccountImportMaxBytes(process.env.ACCOUNT_IMPORT_BODY_LIMIT);
    const body = await readJsonBody(request, maxBytes);
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
        // The API's own import limit answered (an operator set it lower than
        // the web's): say so instead of passing its raw 413 text on.
        // (`ApiResponseError.statusCode`, read structurally.)
        if ((error as { statusCode?: unknown } | null)?.statusCode === 413) {
            return answer(
                {
                    success: false,
                    data: null,
                    error: 'The export is larger than the import limit.',
                },
                413,
            );
        }
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
