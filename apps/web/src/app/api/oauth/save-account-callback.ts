import { redirect } from '@/i18n/navigation';
import { authAPI } from '@/lib/api';
import type { OAuthClaimResponse } from '@/lib/api/auth';
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
/** The account is already connected to a different account of this provider. */
const OTHER_IDENTITY_CODE = 'OTHER_PROVIDER_ACCOUNT_CONNECTED';
/** Two saves racing for one derived handle, twice (`USERNAME_TAKEN_CODE` in apps/api). */
const USERNAME_TAKEN_CODE = 'username_taken';

/** Our own name for a failed save; the upstream message never reaches the page. */
export function saveAccountOAuthErrorFor(error: unknown): SaveAccountOAuthError {
    if (!(error instanceof ApiResponseError)) {
        return 'failed';
    }
    if (error.code === EMAIL_TAKEN_CODE) {
        return 'email_taken';
    }
    if (error.code === OTHER_IDENTITY_CODE) {
        return 'other_identity';
    }
    // Nothing the visitor chose: trying again allocates another handle.
    if (error.code === USERNAME_TAKEN_CODE) {
        return 'failed';
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
 * to THAT account, so the Works stay. The API rotates the session like the password claim: the
 * fresh token it answers replaces the cookie (the anonymous bearer is revoked), and the visitor
 * lands on the dashboard with the "account saved" notice. If the identity or its email already
 * belongs to another account the API refuses (nothing is merged) and the visitor goes back to
 * `/save-account`, which says why. A temporary session that ended meanwhile (401) has nothing
 * left to save, so it goes to sign-in.
 *
 * No cache to drop: this is a top-level navigation (the provider redirected the browser here),
 * so the dashboard it lands on renders fresh, strip included.
 */
export async function saveAccountWithOAuth(
    provider: OAuthProvider,
    code: string,
    state: string,
    intent: OAuthSaveAccountIntent,
    locale: string,
) {
    if (!isSaveAccountOAuthProvider(provider)) {
        return redirect({
            locale,
            href: saveAccountOAuthErrorHref(ROUTES.SAVE_ACCOUNT, 'failed', provider),
        });
    }

    let saved: OAuthClaimResponse;
    try {
        saved = await authAPI.claimAccountWithOAuth(provider, {
            code,
            state,
            // The account the sealed intent was minted for; the API refuses it unless it is the
            // session's own user, before the code is spent.
            expectedUserId: intent.userId,
            terms: intent.terms.length > 0 ? intent.terms : undefined,
            emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
        });
    } catch (error) {
        console.error(`Saving the anonymous account with ${provider} failed:`, error);
        const href =
            error instanceof ApiResponseError && error.statusCode === 401
                ? ROUTES.AUTH_LOGIN
                : saveAccountOAuthErrorHref(
                      ROUTES.SAVE_ACCOUNT,
                      saveAccountOAuthErrorFor(error),
                      provider,
                  );
        return redirect({ locale, href });
    }

    // From here on the account IS saved. Store the session the API rotated to; without a token
    // the API kept the anonymous one, which is still in the cookie. If the cookie cannot be set,
    // the visitor is saved but signed out: send them to sign in, never to "try again".
    if (saved.access_token) {
        try {
            await setAuthCookies(saved.access_token);
        } catch (error) {
            console.error('Account saved, but the new session cookie could not be set', error);
            return redirect({
                locale,
                // Which way it now signs in, so the page does not say "email and password".
                href: `${ROUTES.AUTH_LOGIN}?${ACCOUNT_SAVED_PARAM}=true&${ACCOUNT_SAVED_WITH_PARAM}=${provider}`,
            });
        }
    }

    let href = `${ROUTES.DASHBOARD}?${ACCOUNT_SAVED_PARAM}=true&${ACCOUNT_SAVED_WITH_PARAM}=${provider}`;
    if (saved.user?.emailVerified === false) {
        href = withUnverifiedEmailNotice(href);
    }
    return redirect({ locale, href });
}
