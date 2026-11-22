import { OAuthProvider } from '@/lib/api/enums';

/**
 * EW-617 — saving a temporary account with GitHub or Google. Client-safe: the save-account
 * page, its form, the OAuth callback route and the dashboard notice all read these.
 */

/** The providers `/save-account` offers, in display order (only those the API has configured). */
export const SAVE_ACCOUNT_OAUTH_PROVIDERS: readonly OAuthProvider[] = [
    OAuthProvider.GITHUB,
    OAuthProvider.GOOGLE,
];

export function isSaveAccountOAuthProvider(value: unknown): value is OAuthProvider {
    return SAVE_ACCOUNT_OAUTH_PROVIDERS.includes(value as OAuthProvider);
}

/** Query params the callback sends a failed save back to `/save-account` with. */
export const SAVE_ACCOUNT_OAUTH_ERROR_PARAM = 'oauthError';
export const SAVE_ACCOUNT_OAUTH_PROVIDER_PARAM = 'provider';

/** `/save-account?oauthError=…&provider=…`, the page a failed save goes back to. */
export function saveAccountOAuthErrorHref(
    saveAccountRoute: string,
    error: SaveAccountOAuthError,
    provider: OAuthProvider,
): string {
    const params = new URLSearchParams({ [SAVE_ACCOUNT_OAUTH_ERROR_PARAM]: error });
    if (isSaveAccountOAuthProvider(provider)) {
        params.set(SAVE_ACCOUNT_OAUTH_PROVIDER_PARAM, provider);
    }
    return `${saveAccountRoute}?${params.toString()}`;
}

/**
 * Why a save with a provider failed. `identity_taken` and `email_taken` are the API's 409s:
 * the provider account, or its email, already belongs to another account, which is never
 * merged into this one. `other_identity`: this account is already connected to a different
 * account of the provider (e.g. through the GitHub App), which a save would replace.
 */
export const SAVE_ACCOUNT_OAUTH_ERRORS = [
    'identity_taken',
    'email_taken',
    'other_identity',
    'not_temporary',
    'too_many_attempts',
    'rejected',
    'failed',
] as const;

export type SaveAccountOAuthError = (typeof SAVE_ACCOUNT_OAUTH_ERRORS)[number];

/** The error named in the URL, or null; anything not on the list is ignored. */
export function readSaveAccountOAuthError(value: unknown): SaveAccountOAuthError | null {
    return SAVE_ACCOUNT_OAUTH_ERRORS.includes(value as SaveAccountOAuthError)
        ? (value as SaveAccountOAuthError)
        : null;
}

/**
 * Query param the dashboard reads, next to `accountSaved`, to say WHICH way the account now
 * signs in. Absent after the email + password save.
 */
export const ACCOUNT_SAVED_WITH_PARAM = 'savedWith';
