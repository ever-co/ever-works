import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { authAPI, type TermsAcceptanceDocument } from '@/lib/api';
import { workAPI } from '@/lib/api/work';
import { ROUTES } from '@/lib/constants';
import { buildSaveAccountStrip } from '@/lib/anonymous/save-account-strip';
import { getAuthProvidersConfig } from '@/lib/auth/providers';
import {
    SAVE_ACCOUNT_OAUTH_ERROR_PARAM,
    SAVE_ACCOUNT_OAUTH_PROVIDER_PARAM,
    SAVE_ACCOUNT_OAUTH_PROVIDERS,
    isSaveAccountOAuthProvider,
    readSaveAccountOAuthError,
} from '@/lib/anonymous/save-account-oauth';
import { SaveAccountForm } from '@/components/anonymous/SaveAccountForm';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('anonymousAccount.save');
    return { title: t('metaTitle') };
}

/** How many Work names the page lists; the rest are counted. */
const WORKS_SHOWN = 5;

/**
 * EW-617 G3 — `/save-account`: where a temporary (anonymous) account attaches an email and a
 * password and so keeps its Works. Inside the dashboard shell, behind its session check.
 *
 * Only an account the strip would show to gets the form (the same `buildSaveAccountStrip`
 * rules): a registered account has nothing to save, and a demo sandbox cannot be claimed, so
 * both go back to the dashboard. The terms are resolved here, in the visitor's locale, and
 * posted back verbatim, exactly as the sign-up page does.
 *
 * EW-617: GitHub and Google (whichever the API has configured) save the account too, through
 * the OAuth callback, which sends a refused save back here with `?oauthError=…&provider=…`.
 */
export default async function SaveAccountPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const locale = await getLocale();
    const profile = await authAPI.getFreshProfile().catch(() => null);
    const strip = await buildSaveAccountStrip(profile);
    if (!strip) {
        redirect({ href: ROUTES.DASHBOARD, locale });
        return null;
    }

    const query = await searchParams;
    const oauthError = readSaveAccountOAuthError(query[SAVE_ACCOUNT_OAUTH_ERROR_PARAM]);
    const oauthErrorProvider = query[SAVE_ACCOUNT_OAUTH_PROVIDER_PARAM];

    const [termsDocuments, works, providersConfig] = await Promise.all([
        authAPI.getRequiredTerms(locale).catch((error: unknown): TermsAcceptanceDocument[] => {
            console.error('Failed to load the required legal documents', error);
            return [];
        }),
        workAPI.getAll({ limit: WORKS_SHOWN }).catch(() => null),
        getAuthProvidersConfig(),
    ]);
    const socialProviders = SAVE_ACCOUNT_OAUTH_PROVIDERS.filter((provider) =>
        providersConfig.socialProviders.includes(provider),
    );

    return (
        <SaveAccountForm
            expiresAt={strip.expiresAt}
            termsDocuments={termsDocuments}
            workNames={(works?.works ?? []).map((work) => work.name).slice(0, WORKS_SHOWN)}
            totalWorks={works ? works.total : null}
            socialProviders={socialProviders}
            oauthError={
                oauthError
                    ? {
                          error: oauthError,
                          provider: isSaveAccountOAuthProvider(oauthErrorProvider)
                              ? oauthErrorProvider
                              : null,
                      }
                    : null
            }
        />
    );
}
