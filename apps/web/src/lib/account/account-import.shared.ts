/**
 * The largest account export the import accepts by default — the API's import
 * body limit (`DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES`, the ingress
 * `proxy-body-size`). `ACCOUNT_IMPORT_BODY_LIMIT` lowers or raises it on both
 * the API and the web, up to {@link ACCOUNT_IMPORT_MAX_BYTES_CEILING}.
 */
export const ACCOUNT_IMPORT_MAX_BYTES = 25 * 1024 * 1024;

/** `MAX_ACCOUNT_IMPORT_BODY_LIMIT_BYTES` in the API. */
export const ACCOUNT_IMPORT_MAX_BYTES_CEILING = 50 * 1024 * 1024;

/**
 * `ACCOUNT_IMPORT_BODY_LIMIT` (`25mb`, `10MB`, `5242880`…) in bytes, read the
 * way the API reads it (`resolveAccountImportBodyLimit`): blank, invalid or
 * over the ceiling → the default. The web must not accept more than the API,
 * or a lowered API limit answers the user with a raw 413.
 */
export function resolveAccountImportMaxBytes(requested: string | undefined): number {
    const trimmed = requested?.trim().toLowerCase();
    if (!trimmed) return ACCOUNT_IMPORT_MAX_BYTES;
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(trimmed);
    if (!match) return ACCOUNT_IMPORT_MAX_BYTES;
    const unit = match[2] ?? 'b';
    const multiplier =
        unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
    const bytes = Number(match[1]) * multiplier;
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > ACCOUNT_IMPORT_MAX_BYTES_CEILING) {
        return ACCOUNT_IMPORT_MAX_BYTES;
    }
    return Math.floor(bytes);
}

/** "25 MB" — the limit as the import's error message states it. */
export function formatImportLimit(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** What the import routes answer — the shape the `previewImport` / `applyImport` actions had. */
export type AccountImportAnswer<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };
