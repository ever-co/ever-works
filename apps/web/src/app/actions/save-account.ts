'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';
import { ZOD3_ERROR_MESSAGES } from '@ever-works/plugin/helpers';
import { getLocale, getTranslations } from 'next-intl/server';
import { authAPI, type TermsAcceptanceClaim } from '@/lib/api';
import type { ClaimAccountResponse } from '@/lib/api/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { setAuthCookies } from '@/lib/auth';
import type { OAuthProvider } from '@/lib/api/enums';
import { setOAuthSaveAccountCookie, setOAuthStateCookie } from '@/lib/auth/cookies';
import { isSaveAccountOAuthProvider } from '@/lib/anonymous/save-account-oauth';
import { redirect } from '@/i18n/navigation';
import { ROUTES, withAppUrl } from '@/lib/constants';
import { isEmailUnconfirmed, withUnverifiedEmailNotice } from '@/lib/auth/unverified-email';
import { ACCOUNT_SAVED_PARAM } from '@/lib/anonymous/account-saved';
import { isUsableUsername, normalizeUsername, USERNAME_MIN_LENGTH } from '@/lib/anonymous/username';
import { PASSWORD_RULES } from './validation';

export type SaveAccountField = 'email' | 'password' | 'username' | 'terms';

export interface SaveAccountInput {
    email: string;
    password: string;
    /** Optional handle; empty = the API derives one from the email. */
    username?: string;
    terms: TermsAcceptanceClaim[];
}

export interface SaveAccountFailure {
    success: false;
    error: string;
    /** The field the error belongs to, when it belongs to one. */
    field?: SaveAccountField;
    /**
     * `session_ended`: the temporary session is gone (expired or swept), so there is nothing
     * left to save here; the form offers "start again" and "sign in" instead of "try again".
     */
    reason?: 'session_ended';
}

/** The legal documents as the form displayed them; the same shape `register` accepts. */
const termsClaimsSchema = z.array(
    z.object({
        documentId: z.string().min(1),
        version: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        locale: z.string().min(1),
    }),
);

/** The 409 code the API answers for a taken username (`USERNAME_TAKEN_CODE` in apps/api). */
const USERNAME_TAKEN_CODE = 'username_taken';

/**
 * EW-617 G3 — save a temporary (anonymous) account: attach an email, a password and a real
 * username to the signed-in account through `POST /auth/claim`. The user id does not change,
 * so every Work, repository and setting it owns stays with it.
 *
 * Validates exactly what `register` validates (same password rules, same terms rule) so the
 * two ways of getting an account cannot disagree. The API rotates the session (the anonymous
 * one would end with the anonymous TTL), so the fresh token replaces the cookie. On success it
 * redirects to the dashboard with the "account saved" notice and, when the address still needs
 * confirming, the same unconfirmed-email notice registration shows. A failure returns our own
 * message, never the raw upstream error.
 */
export async function saveAnonymousAccount(input: SaveAccountInput): Promise<SaveAccountFailure> {
    const t = await getTranslations('validation.auth');
    const tSave = await getTranslations('anonymousAccount.save.errors');

    const schema = z.object({
        email: z.string().trim().email(t('email.invalid')),
        password: z
            .string()
            .min(PASSWORD_RULES.MIN_LENGTH, t('password.minLength', { length: 8 }))
            .regex(PASSWORD_RULES.LOWERCASE, t('password.lowercase'))
            .regex(PASSWORD_RULES.NUMBER_OR_SPECIAL, t('password.numberOrSpecial'))
            .regex(PASSWORD_RULES.NOT_STARTING_WITH_DOT_OR_NEWLINE, t('password.cannotStartWith')),
        // The API's own rule (normalized, >= 3, an ASCII letter or digit), so "!!!" is
        // refused here instead of silently becoming a random handle.
        username: z
            .string()
            .trim()
            .refine(isUsableUsername, tSave('usernameTooShort', { length: USERNAME_MIN_LENGTH })),
        terms: termsClaimsSchema.min(1, t('terms.required')),
    });

    const validation = schema.safeParse(
        { ...input, username: input.username ?? '' },
        ZOD3_ERROR_MESSAGES,
    );
    if (!validation.success) {
        const issue = validation.error.issues[0];
        const field = issue.path[0];
        return {
            success: false,
            error: issue.message,
            field:
                field === 'email' ||
                field === 'password' ||
                field === 'username' ||
                field === 'terms'
                    ? field
                    : undefined,
        };
    }

    let claimed: ClaimAccountResponse;
    try {
        claimed = await authAPI.claimAccount({
            email: validation.data.email,
            password: validation.data.password,
            ...(validation.data.username
                ? { username: normalizeUsername(validation.data.username) }
                : {}),
            terms: validation.data.terms,
            emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
        });
    } catch (error) {
        console.error('Saving the anonymous account failed', error);
        const status = error instanceof ApiResponseError ? error.statusCode : undefined;
        // Security: map known statuses to our own words; never forward the upstream message.
        if (status === 401) {
            return { success: false, error: tSave('sessionEnded'), reason: 'session_ended' };
        }
        if (status === 409) {
            if (error instanceof ApiResponseError && error.code === USERNAME_TAKEN_CODE) {
                const suggestion = error.details?.suggestion;
                return {
                    success: false,
                    error:
                        typeof suggestion === 'string' && suggestion
                            ? tSave('usernameTakenWithSuggestion', { suggestion })
                            : tSave('usernameTaken'),
                    field: 'username',
                };
            }
            return { success: false, error: tSave('emailTaken'), field: 'email' };
        }
        if (status === 403) {
            return { success: false, error: tSave('notTemporary') };
        }
        if (status === 429) {
            return { success: false, error: tSave('tooManyAttempts') };
        }
        if (status === 400) {
            // Matched, never forwarded: the API's username refusals name the field.
            if (error instanceof ApiResponseError && /username/i.test(error.message)) {
                return {
                    success: false,
                    error: tSave('usernameTooShort', { length: USERNAME_MIN_LENGTH }),
                    field: 'username',
                };
            }
            return { success: false, error: tSave('rejected') };
        }
        return { success: false, error: tSave('generic') };
    }

    // From here on the account IS saved: nothing below may report a failure. The API rotated
    // the session (the anonymous one is revoked); store the new one. If that cannot be
    // stored, the visitor is signed out but saved, so they are told so and sent to sign in,
    // never to "try again" (a retry would only find the revoked session).
    const locale = await getLocale();
    if (claimed.access_token) {
        try {
            await setAuthCookies(claimed.access_token);
        } catch (error) {
            console.error('Account saved, but the new session cookie could not be set', error);
            redirect({ locale, href: `${ROUTES.AUTH_LOGIN}?${ACCOUNT_SAVED_PARAM}=true` });
            return { success: false, error: tSave('generic') };
        }
    }

    let href = `${ROUTES.DASHBOARD}?${ACCOUNT_SAVED_PARAM}=true`;
    if (isEmailUnconfirmed({ emailVerified: claimed.emailVerified })) {
        href = withUnverifiedEmailNotice(href);
    }

    // The strip lives in the dashboard LAYOUT, which a redirect to another page under the same
    // layout reuses from this visitor's router cache (seen on the local stack: the strip stayed
    // until a reload). `refresh()` re-renders this visitor's view only, unlike
    // `revalidatePath('/', 'layout')`, which would drop every route's cache for everyone.
    refresh();

    // Throws NEXT_REDIRECT.
    redirect({ locale, href });
    return { success: false, error: tSave('generic') };
}

/**
 * EW-617 — the start of saving a temporary account with GitHub or Google.
 *
 * The same round trip as "Continue with GitHub" on the sign-in page (`connectProvider`): the
 * API mints the OAuth `state`, it is mirrored into the `oauth_state` cookie, and the browser
 * goes to the provider. One more HttpOnly cookie, bound to that `state`, marks the trip as a
 * save and carries the terms the visitor accepted, so the callback route attaches the identity
 * to THIS account (`POST /oauth/:p/claim`) instead of signing in to another one. Bound to the
 * state, a save that was abandoned never turns a later sign-in into a save.
 */
export async function startSavingWithProvider(
    provider: OAuthProvider,
    terms: TermsAcceptanceClaim[],
): Promise<{ success: true; url: string } | SaveAccountFailure> {
    const t = await getTranslations('validation.auth');
    const tSave = await getTranslations('anonymousAccount.save.errors');

    if (!isSaveAccountOAuthProvider(provider)) {
        return { success: false, error: tSave('providerFailed') };
    }
    const claims = termsClaimsSchema
        .min(1, t('terms.required'))
        .safeParse(terms, ZOD3_ERROR_MESSAGES);
    if (!claims.success) {
        return { success: false, error: claims.error.issues[0].message, field: 'terms' };
    }

    try {
        const { url, state } = await authAPI.getOAuthAuthUrl(provider);
        await setOAuthStateCookie(state);
        await setOAuthSaveAccountCookie({ state, terms: claims.data });
        return { success: true, url };
    } catch (error) {
        console.error(`Starting to save the anonymous account with ${provider} failed`, error);
        // Security: our own words, never the upstream message.
        return { success: false, error: tSave('providerFailed') };
    }
}
