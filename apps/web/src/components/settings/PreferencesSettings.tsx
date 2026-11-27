'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AppLauncherPlacementTiles } from './AppLauncherPlacementTiles';
import { LanguagePreference } from './LanguagePreference';
import { ThemePreferenceTiles } from './ThemePreferenceTiles';

function Section({
    id,
    title,
    description,
    children,
}: {
    id: string;
    title: string;
    description: string;
    children: ReactNode;
}) {
    return (
        <section aria-labelledby={id} className="space-y-3" data-testid={`preferences-${id}`}>
            <div className="space-y-1">
                <h2 id={id} className="text-sm font-medium text-text dark:text-text-dark">
                    {title}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{description}</p>
            </div>
            {children}
        </section>
    );
}

/**
 * Settings › Preferences (shared Ever shell, A9): Theme (A4), App Launcher
 * position (A3, only where the launcher exists) and Language (A5), in that
 * order. Each is saved as it is picked, in this browser.
 */
export function PreferencesSettings({ appLauncherEnabled }: { appLauncherEnabled: boolean }) {
    const t = useTranslations('dashboard.settings.preferences');
    return (
        <div className="space-y-8" data-testid="preferences-settings">
            <Section id="theme" title={t('themeTitle')} description={t('themeDescription')}>
                <ThemePreferenceTiles />
            </Section>
            {appLauncherEnabled && (
                <div className="border-t border-border pt-8 dark:border-border-dark">
                    <AppLauncherPlacementTiles />
                </div>
            )}
            <div className="border-t border-border pt-8 dark:border-border-dark">
                <Section
                    id="language"
                    title={t('languageTitle')}
                    description={t('languageDescription')}
                >
                    <LanguagePreference />
                </Section>
            </div>
        </div>
    );
}
