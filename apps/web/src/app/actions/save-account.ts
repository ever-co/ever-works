'use server';

import { z } from 'zod';
import { ZOD3_ERROR_MESSAGES } from '@ever-works/plugin/helpers';
import { getLocale, getTranslations } from 'next-intl/server';
import { authAPI, type TermsAcceptanceClaim } from '@/lib/api';
import { ApiResponseError } from '@/lib/api/server-api';
import { redirect } from '@/i18n/navigation';
import { ROUTES, withAppUrl } from '@/lib/constants';
import { isEmailUnconfirmed, withUnverifiedEmailNotice } from '@/lib/auth/unverified-email';
import { ACCOUNT_SAVED_PARAM } from '@/lib/anonymous/account-saved';
import { PASSWORD_RULES } from './validation';

export type SaveAccountField = 'email' | 'password' | 'terms';

export interface SaveAccountFailure {
    success: false;
    error: string;
    /** The field the error belongs to, when it belongs to one. */
    field?: SaveAccountField;
}

/**
 * EW-617 G3 — save a temporary (anonymous) account: attach an email and a password to the
 * signed-in account through `POST /auth/claim`. The user id does not change, so every Work,
 * repository and setting it owns stays with it, and the session in the cookie stays valid.
 *
 * Validates exactly what `register` validates (same password rules, same terms rule) so the
 * two ways of getting an account cannot disagree. On success it redirects to the dashboard
 * with the "account saved" notice and, when the address still needs confirming, the same
 * unconfirmed-email notice registration shows. A failure returns a message, never the raw
 * upstream error.
 */
export async function saveAnonymousAccount(
    email: string,
    password: string,
    terms: TermsAcceptanceClaim[] = [],
): Promise<SaveAccountFailure> {
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
        terms: z
            .array(
                z.object({
                    documentId: z.string().min(1),
                    version: z.string().min(1),
                    sha256: z.string().regex(/^[0-9a-f]{64}$/),
                    locale: z.string().min(1),
                }),
            )
            .min(1, t('terms.required')),
    });

    const validation = schema.safeParse({ email, password, terms }, ZOD3_ERROR_MESSAGES);
    if (!validation.success) {
        const issue = validation.error.issues[0];
        const field = issue.path[0];
        return {
            success: false,
            error: issue.message,
            field:
                field === 'email' || field === 'password' || field === 'terms' ? field : undefined,
        };
    }

    let emailVerified: boolean | undefined;
    try {
        const claimed = await authAPI.claimAccount({
            email: validation.data.email,
            password: validation.data.password,
            terms: validation.data.terms,
            emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
        });
        emailVerified = claimed.emailVerified;
    } catch (error) {
        console.error('Saving the anonymous account failed', error);
        const status = error instanceof ApiResponseError ? error.statusCode : undefined;
        // Security: map known statuses to our own words; never forward the upstream message.
        if (status === 409) {
            return { success: false, error: tSave('emailTaken'), field: 'email' };
        }
        if (status === 403) {
            return { success: false, error: tSave('notTemporary') };
        }
        if (status === 429) {
            return { success: false, error: tSave('tooManyAttempts') };
        }
        if (status === 400) {
            return { success: false, error: tSave('rejected') };
        }
        return { success: false, error: tSave('generic') };
    }

    let href = `${ROUTES.DASHBOARD}?${ACCOUNT_SAVED_PARAM}=true`;
    if (isEmailUnconfirmed({ emailVerified })) {
        href = withUnverifiedEmailNotice(href);
    }

    // Throws NEXT_REDIRECT: the dashboard re-renders with the fresh profile, so the strip is gone.
    redirect({ locale: await getLocale(), href });
    return { success: false, error: tSave('generic') };
}
