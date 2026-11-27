'use client';

import { useId, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { LOCALES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

type Locale = (typeof LOCALES)[number];

/**
 * Each language's own name for itself, written out rather than taken from
 * `Intl.DisplayNames`: the server and the browser may carry different ICU data,
 * and the select is rendered on both, so the names must not depend on either.
 */
const ENDONYMS: Record<Locale, string> = {
    en: 'English',
    ar: 'العربية',
    bg: 'Български',
    de: 'Deutsch',
    es: 'Español',
    fr: 'Français',
    he: 'עברית',
    hi: 'हिन्दी',
    id: 'Bahasa Indonesia',
    it: 'Italiano',
    ja: '日本語',
    ko: '한국어',
    nl: 'Nederlands',
    pl: 'Polski',
    pt: 'Português',
    ru: 'Русский',
    th: 'ไทย',
    tr: 'Türkçe',
    uk: 'Українська',
    vi: 'Tiếng Việt',
    zh: '中文',
};

/** The current query string as the object next-intl's router takes; repeated keys stay arrays. */
function queryOf(params: URLSearchParams | null): Record<string, string | string[]> {
    const query: Record<string, string | string[]> = {};
    params?.forEach((value, key) => {
        const seen = query[key];
        if (seen === undefined) query[key] = value;
        else query[key] = Array.isArray(seen) ? [...seen, value] : [seen, value];
    });
    return query;
}

export function endonym(locale: Locale): string {
    return ENDONYMS[locale] ?? locale;
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
    const searchParams = useSearchParams();
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
                    // Changing the language must not drop the query string (filters, tabs).
                    const query = queryOf(searchParams);
                    const href = Object.keys(query).length > 0 ? { pathname, query } : pathname;
                    startTransition(() => router.replace(href, { locale: next }));
                }}
                className={cn(
                    'h-9 w-full max-w-xs rounded-lg border px-3 text-sm',
                    'border-border bg-white text-text dark:border-border-dark dark:bg-surface-dark dark:text-text-dark',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
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
