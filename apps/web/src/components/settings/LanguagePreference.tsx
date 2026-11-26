'use client';

import { useId, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { LOCALES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

type Locale = (typeof LOCALES)[number];

/**
 * A language's own name for itself ("Deutsch", "日本語"), from the browser's
 * Intl data, so the list needs no translation of its own; the code is the
 * fallback where Intl has no name.
 */
export function endonym(locale: Locale): string {
    try {
        const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale);
        if (!name) return locale;
        return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
    } catch {
        return locale;
    }
}

/**
 * Language (shared Ever shell, A5): a plain select in Preferences, so a
 * signed-in person changes it where the other preferences live. Ever Works
 * keeps no language on the account, so — like the footer select, which stays —
 * the choice lives in this browser (next-intl's `NEXT_LOCALE` cookie).
 */
export function LanguagePreference({ className }: { className?: string }) {
    const t = useTranslations('dashboard.settings.preferences');
    const locale = useLocale() as Locale;
    const router = useRouter();
    const pathname = usePathname();
    const [isPending, startTransition] = useTransition();
    const id = useId();

    return (
        <div className={cn('flex flex-col gap-2', className)}>
            <label htmlFor={id} className="sr-only">
                {t('languageTitle')}
            </label>
            <select
                id={id}
                value={locale}
                disabled={isPending}
                data-testid="language-preference"
                onChange={(event) => {
                    const next = event.target.value as Locale;
                    startTransition(() => router.replace(pathname, { locale: next }));
                }}
                className={cn(
                    'h-9 w-full max-w-xs rounded-lg border px-3 text-sm',
                    'border-border bg-white text-text dark:border-border-dark dark:bg-surface-dark dark:text-text-dark',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
                    'disabled:opacity-60',
                )}
            >
                {LOCALES.map((option) => (
                    <option key={option} value={option} lang={option}>
                        {endonym(option)}
                    </option>
                ))}
            </select>
        </div>
    );
}
