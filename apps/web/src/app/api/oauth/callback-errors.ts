import { ApiResponseError } from '@/lib/api';

const PROVIDER_CONFLICT_CODE = 'PROVIDER_ACCOUNT_ALREADY_LINKED';
/**
 * The API refused to link a verified social sign-in into an existing account whose own email
 * was never verified (account pre-hijacking guard). Also a 409, so it is matched by code before
 * the generic conflict below.
 */
const EXISTING_ACCOUNT_UNVERIFIED_CODE = 'EXISTING_ACCOUNT_EMAIL_UNVERIFIED';
const ACCOUNT_LOCKED_SNIPPET = 'suspended';

export type OAuthRouteErrorCode =
    | 'account_locked'
    | 'oauth_callback'
    | 'oauth_connect_failed'
    | 'oauth_existing_account_unverified'
    | 'oauth_provider_conflict';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || '');
}

export function getOAuthRouteErrorCode(
    error: unknown,
    fallback: OAuthRouteErrorCode,
): OAuthRouteErrorCode {
    if (error instanceof ApiResponseError) {
        if (error.code === EXISTING_ACCOUNT_UNVERIFIED_CODE) {
            return 'oauth_existing_account_unverified';
        }
        if (error.code === PROVIDER_CONFLICT_CODE || error.statusCode === 409) {
            return 'oauth_provider_conflict';
        }
    }

    const message = getErrorMessage(error).toLowerCase();

    if (message.includes(ACCOUNT_LOCKED_SNIPPET)) {
        return 'account_locked';
    }

    return fallback;
}

export function appendQueryParams(
    href: string,
    params: Record<string, string | undefined>,
): string {
    const url = new URL(href, 'http://localhost');

    for (const [key, value] of Object.entries(params)) {
        if (!value) {
            continue;
        }
        url.searchParams.set(key, value);
    }

    return `${url.pathname}${url.search}${url.hash}`;
}
