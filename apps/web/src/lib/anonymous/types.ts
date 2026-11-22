/**
 * What the dashboard hands `<SaveAccountStrip>`, and the anonymous-account context's value.
 * Client-safe: imported by the server-only builder and by client components alike.
 */
export interface SaveAccountStripProps {
    /** The account's `anonymousExpiresAt`, ISO 8601; null when the API did not say. */
    expiresAt: string | null;
}
