import type { Metadata } from 'next';
import { getAuthFromCookie } from '@/lib/auth';
import { pluginsAPI } from '@/lib/api/plugins';
import { onboardingAPI } from '@/lib/api/onboarding';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import type { OnboardingCatalogResponse, OnboardingStateResponse } from '@ever-works/contracts/api';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import type { UserPlugin } from '@/lib/api/plugins';
import { OnboardingPageClient } from './onboarding-page-client';
import { getDemoConfig } from '@/lib/feature-flags/demo';
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { ROUTES } from '@/lib/constants';
import { AnonymousOnboardingBootstrap } from './anonymous-bootstrap';
import { getSaveAccountStripForRequest } from '@/lib/anonymous/save-account-strip';

// EW-617 zero-friction landing target. PUBLIC route: fresh marketing-site
// visitors arrive at `/onboarding#prompt=…&corrId=…` with no session. For them
// we mint an anonymous session client-side (Turnstile → server action → cookie)
// then re-render down the authed branch. For logged-in users we mount the same
// wizard the dashboard mounts as a dialog — here forced open on a standalone
// page. Never statically rendered: depends on the auth cookie.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Get started',
    robots: { index: false, follow: false }, // never index the funnel URL
};

const FALLBACK_CATALOG: OnboardingCatalogResponse = {
    ai: [],
    storage: [],
    db: [],
    deploy: [],
    desktop: [],
    plugins: [],
};
const FALLBACK_STATE: OnboardingStateResponse = {
    completedAt: null,
    dismissedAt: null,
    state: ONBOARDING_DEFAULT_STATE,
};

export default async function OnboardingPage() {
    const user = await getAuthFromCookie();

    // No valid session → anonymous bootstrap (client-side mint → refresh).
    if (!user) {
        // Demo instance: `POST /auth/anonymous` answers 403 there, so never mint.
        // The one-click demo card on the sign-in page is the way in.
        if ((await getDemoConfig()).enabled) {
            return redirect({ locale: await getLocale(), href: ROUTES.AUTH_LOGIN });
        }
        return <AnonymousOnboardingBootstrap />;
    }

    // Authed (logged-in OR already-anonymous). Fetch wizard props exactly as
    // (dashboard)/layout.tsx does; every call degrades to a safe fallback, so an
    // empty/anon catalog still lands the user on the create-work step.
    const [pluginsResponse, onboardingState, onboardingCatalog, saveAccountStrip] =
        await Promise.all([
            pluginsAPI.list().catch(() => ({ plugins: [] as UserPlugin[], total: 0 })),
            onboardingAPI.getState().catch(() => FALLBACK_STATE),
            onboardingAPI.getCatalog().catch(() => FALLBACK_CATALOG),
            // EW-617: where a visitor waits for their first generation, so the strip that
            // says the account is temporary belongs here too (null for everyone else).
            getSaveAccountStripForRequest().catch(() => null),
        ]);

    const plugins = pluginsResponse.plugins
        .filter((p) => p.uiHints?.includeInOnboarding)
        .sort(
            (a, b) => (a.uiHints?.onboardingPriority ?? 99) - (b.uiHints?.onboardingPriority ?? 99),
        );

    const initialConnections = Object.fromEntries(
        plugins.map(
            (p) =>
                [p.pluginId, null] as [
                    string,
                    OAuthConnectionInfo | GitProviderConnectionInfo | null,
                ],
        ),
    );
    const initialDeviceAuthStatuses = Object.fromEntries(
        plugins.map((p) => [p.pluginId, null] as [string, PluginDeviceAuthStatus | null]),
    );

    return (
        <OnboardingPageClient
            initialState={onboardingState}
            catalog={onboardingCatalog}
            plugins={plugins}
            initialConnections={initialConnections}
            initialDeviceAuthStatuses={initialDeviceAuthStatuses}
            saveAccountStrip={saveAccountStrip}
        />
    );
}
