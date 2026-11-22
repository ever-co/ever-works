'use client';

import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { timeLeft } from '@/lib/anonymous/time-left';
import type { SaveAccountStripProps } from '@/lib/anonymous/types';

/**
 * EW-617 — the strip above the dashboard header while the account is a temporary (anonymous)
 * one, made from the home-page prompt. It says so, says when the account and its Works are
 * deleted, and links to the page that keeps them (`POST /auth/claim`, same user id).
 *
 * Not dismissible, by design: it is the one place a visitor learns their Works are not kept,
 * and it disappears on its own once the account is saved. Modelled on the demo strip and
 * `JobRuntimeDegradedBanner` (`role="status"`, amber for "act before this runs out").
 */
export function SaveAccountStrip({ expiresAt }: SaveAccountStripProps) {
    const t = useTranslations('anonymousAccount.strip');
    const pathname = usePathname();
    const onSavePage = pathname === ROUTES.SAVE_ACCOUNT;
    const left = timeLeft(expiresAt);

    return (
        <div
            role="status"
            data-testid="save-account-strip"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-300/60 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-950/30 px-4 py-2 text-sm text-amber-950 dark:text-amber-100"
        >
            <Clock
                className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300"
                aria-hidden="true"
            />
            <p className="min-w-0 flex-1">
                <span className="font-medium">{t('message')}</span>{' '}
                {left.kind !== 'unknown' && (
                    // Read from the clock: the server and the hydrating client can sit either
                    // side of an hour boundary, so this one text may differ for a render.
                    <span
                        className="tabular-nums text-amber-900/80 dark:text-amber-100/75"
                        data-testid="save-account-strip-time"
                        suppressHydrationWarning
                    >
                        {left.kind === 'days'
                            ? t('deletedInDays', { days: left.days, hours: left.hours })
                            : left.kind === 'hours'
                              ? t('deletedInHours', { hours: left.hours })
                              : t('deletedSoon')}
                    </span>
                )}
            </p>
            {!onSavePage && (
                <Button href={ROUTES.SAVE_ACCOUNT} size="sm" className="shrink-0">
                    {t('action')}
                </Button>
            )}
        </div>
    );
}
