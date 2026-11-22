'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';

/**
 * EW-617 — shown above the sign-in form to a visitor who is signed in to a temporary
 * (anonymous) account. Signing in here replaces that session, and the temporary account's
 * Works stay behind on it until the cleanup deletes them; saving it first keeps them.
 */
export function TemporaryAccountLoginNotice() {
    const t = useTranslations('anonymousAccount.login');
    return (
        <div
            role="status"
            data-testid="temporary-account-login-notice"
            className="mb-4 space-y-3 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/25 dark:bg-amber-950/30 dark:text-amber-100"
        >
            <p>
                <span className="font-medium">{t('title')}</span>{' '}
                <span className="text-amber-900/80 dark:text-amber-100/75">{t('body')}</span>
            </p>
            <Button href={ROUTES.SAVE_ACCOUNT} size="sm">
                {t('action')}
            </Button>
        </div>
    );
}
