import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import RegisterForm from './register-form';
import { prefillFromSearchParams, type RegisterSearchParams } from './register-prefill';
import { getAuthProvidersConfig } from '@/lib/auth/providers';
import { authAPI, type TermsAcceptanceDocument } from '@/lib/api';
import { getDemoConfig } from '@/lib/feature-flags/demo';
import { DemoRegisterPanel } from '@/components/demo/DemoRegisterPanel';
import { EVER_ID_ANONYMOUS_DISTINCT_ID, isEverIdOffered } from '@/lib/feature-flags/ever-id';
import { hasSavableAnonymousSession } from '@/lib/anonymous/save-account-strip';
import { redirect } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('createAccount') };
}

export default async function RegisterPage({
    searchParams,
}: {
    searchParams: Promise<RegisterSearchParams>;
}) {
    // One read of `/auth/providers` gives both the social providers (exactly what
    // `getConfiguredAuthProviders` returns, offline fallback included) and the
    // additive Ever ID availability (APW-12). Asked for at once with the demo
    // config, an independent read of the API.
    const [demo, { socialProviders: availableSocialProviders, everId }] = await Promise.all([
        getDemoConfig(),
        getAuthProvidersConfig(),
    ]);

    // Demo instance: registration is closed (403 from the API). Show where accounts
    // are really created plus the one-click demo, and skip the form entirely.
    if (demo.enabled) {
        return <DemoRegisterPanel signUpUrl={demo.signUpUrl} ttlHours={demo.sandboxTtlHours} />;
    }
    // EW-617: signed in on a temporary account? Signing up here would make a second account
    // and leave the Works behind on this one, so save this one instead (same user id).
    if (await hasSavableAnonymousSession()) {
        redirect({ href: ROUTES.SAVE_ACCOUNT, locale: await getLocale() });
        return null;
    }
    // APW-12 — the flag is evaluated only when an administrator enabled Ever ID.
    const everIdEnabled = await isEverIdOffered(everId, EVER_ID_ANONYMOUS_DISTINCT_ID);
    // Identity carried over from Stripe Checkout — see `register-prefill.ts`.
    const prefill = prefillFromSearchParams(await searchParams);

    // Resolve the documents this signup must accept on the server, in the user's
    // locale, and hand them to the form. The form posts them straight back on
    // submit, so the identity of the text shown next to the checkbox and the
    // identity of the text recorded as accepted are the same object.
    //
    // A failure here yields an empty list, which the form treats as "cannot
    // register": submitting with nothing to pin the acceptance to is exactly the
    // defect being fixed, so failing visibly beats failing silently.
    let termsDocuments: TermsAcceptanceDocument[] = [];

    try {
        termsDocuments = await authAPI.getRequiredTerms(await getLocale());
    } catch (error) {
        console.error('Failed to load the required legal documents', error);
    }

    return (
        <RegisterForm
            availableSocialProviders={availableSocialProviders}
            termsDocuments={termsDocuments}
            prefill={prefill}
            everIdEnabled={everIdEnabled}
        />
    );
}
