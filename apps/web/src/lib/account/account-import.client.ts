import { browserApiFetch } from '@/lib/api/browser-api';
import type {
    AccountExportPayload,
    ConflictResolution,
    ImportPreview,
    ImportResult,
} from '@/lib/api/account-transfer.types';
import type { AccountImportAnswer } from './account-import.shared';

/**
 * Browser side of the import: POST to the route handlers (not server actions,
 * which Next caps at 1 MB) and answer the same `{ success, data, error }` the
 * actions did, so the dialog's handling is unchanged. `browserApiFetch` stamps
 * the workspace selector, so the import lands in the Organization the user is
 * in (the route forwards it through `serverFetch`), as with the actions.
 */
async function post<T>(step: 'preview' | 'apply', body: unknown): Promise<AccountImportAnswer<T>> {
    try {
        const res = await browserApiFetch(`/api/account/import/${step}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => null)) as AccountImportAnswer<T> | null;
        if (json && typeof json === 'object' && 'success' in json) return json;
        return { success: false, data: null, error: `HTTP ${res.status}` };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : 'Network error',
        };
    }
}

export function previewAccountImport(payload: AccountExportPayload) {
    return post<ImportPreview>('preview', { payload });
}

export function applyAccountImport(
    payload: AccountExportPayload,
    resolutions: ConflictResolution[],
) {
    return post<ImportResult>('apply', { payload, resolutions });
}
