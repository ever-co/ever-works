import { revalidatePath } from 'next/cache';
import { redirect } from '@/i18n/navigation';
import { authAPI } from '@/lib/api';
import { ApiResponseError } from '@/lib/api/server-api';
import type { OAuthProvider } from '@/lib/api/enums';
import { setAuthCookies, type OAuthSaveAccountIntent } from '@/lib/auth/cookies';
import { withUnverifiedEmailNotice } from '@/lib/auth/unverified-email';
import { ACCOUNT_SAVED_PARAM } from '@/lib/anonymous/account-saved';
import {
    ACCOUNT_SAVED_WITH_PARAM,
    isSaveAccountOAuthProvider,
    saveAccountOAuthErrorHref,
    type SaveAccountOAuthError,
} from '@/lib/anonymous/save-account-oauth';
import { ROUTES, withAppUrl } from '@/lib/constants';

/** The API's codes for "this belongs to another account" (`SocialClaimService`). */
const IDENTITY_TAKEN_CODE = 'PROVIDER_ACCOUNT_ALREADY_LINKED';
const EMAIL_TAKEN_CODE = 'EMAIL_ALREADY_IN_USE';

/** Our own name for a failed save; the upstream message never reaches the page. */
export function saveAccountOAuthErrorFor(error: unknown): SaveAccountOAuthError {
    if (!(error instanceof ApiResponseError)) {
        return 'failed';
    }
    if (error.code === EMAIL_TAKEN_CODE) {
        return 'email_taken';
    }
    if (error.code === IDENTITY_TAKEN_CODE || error.statusCode === 409) {
        return 'identity_taken';
    }
    switch (error.statusCode) {
        case 403:
            return 'not_temporary';
        case 429:
            return 'too_many_attempts';
        case 400:
            return 'rejected';
        default:
            return 'failed';
    }
}

/**
 * EW-617 — the callback half of saving a temporary account with GitHub or Google.
 *
 * `handleOAuthCallback` comes here instead of signing in when the round trip was started on
 * `/save-account` (its `oauth_save_account` cookie names this very `state`). It posts the code
 * to `POST /oauth/:p/claim` with the visitor's anonymous session, which attaches the identity
 * to THAT account, so the Works stay. On success the API returns a regular session, which
 * replaces the anonymous cookie, and the visitor lands on the dashboard with the "account
 * saved" notice. If the identity or its email already belongs to another account the API
 * refuses (nothing is merged) and the visitor goes back to `/save-account`, which says why.
 */
export async function saveAccountWithOAuth(
    provider: OAuthProvider,
    code: string,
    state: string,
    intent: OAuthSaveAccountIntent,
    locale: string,
) {
    let href: string;

    if (!isSaveAccountOAuthProvider(provider)) {
        href = saveAccountOAuthErrorHref(ROUTES.SAVE_ACCOUNT, 'failed', provider);
    } else {
        try {
            const saved = await authAPI.claimAccountWithOAuth(provider, {
                code,
                state,
                terms: intent.terms.length > 0 ? intent.terms : undefined,
                emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
            });
            await setAuthCookies(saved.access_token);

            href = `${ROUTES.DASHBOARD}?${ACCOUNT_SAVED_PARAM}=true&${ACCOUNT_SAVED_WITH_PARAM}=${provider}`;
            if (saved.user?.emailVerified === false) {
                href = withUnverifiedEmailNotice(href);
            }
            // The strip lives in the dashboard layout; re-read the (no longer anonymous) profile.
            revalidatePath('/', 'layout');
        } catch (error) {
            console.error(`Saving the anonymous account with ${provider} failed:`, error);
            href = saveAccountOAuthErrorHref(
                ROUTES.SAVE_ACCOUNT,
                saveAccountOAuthErrorFor(error),
                provider,
            );
        }
    }

    // Throws NEXT_REDIRECT, so outside the try.
    return redirect({ locale, href });
}
