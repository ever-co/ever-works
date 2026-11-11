/**
 * The largest account export the import accepts — the API's import body limit
 * (`DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES`, the ingress `proxy-body-size`).
 */
export const ACCOUNT_IMPORT_MAX_BYTES = 25 * 1024 * 1024;

/** What the import routes answer — the shape the `previewImport` / `applyImport` actions had. */
export type AccountImportAnswer<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };
