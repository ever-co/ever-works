import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PreferencesSettings } from '@/components/settings/PreferencesSettings';
import { getAuthFromRequest } from '@/lib/auth';
import { isAppLauncherEnabled } from '@/lib/feature-flags/app-launcher';

/**
 * Settings › Preferences (shared Ever shell, A9): Theme, App Launcher position
 * and Language. The launcher's position only shows where the launcher exists,
 * resolved here the same fail-closed way `settings/app-launcher/page.tsx` does.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.tabs');
    return { title: t('preferences') };
}

export default async function PreferencesPage() {
    const auth = await getAuthFromRequest();
    const appLauncherEnabled = await isAppLauncherEnabled(
        auth.isAuthenticated ? auth.user?.sub : undefined,
    );
    return <PreferencesSettings appLauncherEnabled={appLauncherEnabled} />;
}
