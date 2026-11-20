'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { useTurnstile } from '@/components/onboarding/use-turnstile';
import { startDemo } from '@/app/actions/demo/start-demo';
import { ROUTES } from '@/lib/constants';

const SAMPLE_SITE_URL = 'https://dir.ever.works';

interface DemoLoginCardProps {
    ttlHours: number;
    /** The visitor's sandbox expired (or was swept) while they were using it. */
    expired?: boolean;
}

type FailureReason = 'throttled' | 'full' | 'captcha' | 'error';

const FAILURE_KEY = {
    throttled: 'errors.throttled',
    full: 'errors.full',
    captcha: 'errors.captcha',
    error: 'errors.generic',
} as const satisfies Record<FailureReason, string>;

/**
 * "Start the demo" — one click mints a private sandbox account and lands the
 * visitor on the dashboard.
 *
 * Re-entrancy: `disabled` alone is not enough (two clicks can land before React
 * re-renders), so an in-flight ref gates the call. A double click creates one
 * sandbox.
 */
export function DemoLoginCard({ ttlHours, expired = false }: DemoLoginCardProps) {
    const t = useTranslations('demo.login');
    const router = useRouter();
    const { getToken } = useTurnstile();
    const inFlightRef = useRef(false);
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<FailureReason | null>(null);

    const handleStart = async () => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setPending(true);
        setFailure(null);
        try {
            const captchaToken = await getToken(); // '' when Turnstile is unavailable
            const result = await startDemo({ captchaToken: captchaToken || undefined });
            if (result.success) {
                // Stay "pending" through the navigation so the button cannot fire again.
                router.push(ROUTES.DASHBOARD);
                return;
            }
            setFailure(result.reason);
        } catch {
            setFailure('error');
        }
        inFlightRef.current = false;
        setPending(false);
    };

    return (
        <section
            data-testid="demo-login-card"
            className="mb-6 rounded-xl border border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark p-5 space-y-3"
        >
            {expired && (
                <p
                    role="status"
                    data-testid="demo-expired-notice"
                    className="text-sm font-medium text-text dark:text-text-dark"
                >
                    {t('expired')}
                </p>
            )}
            <h2 className="text-base font-semibold text-text dark:text-text-dark">{t('title')}</h2>

            {failure && (
                <div
                    role="alert"
                    className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm"
                >
                    {t(FAILURE_KEY[failure])}
                </div>
            )}

            <Button
                type="button"
                onClick={handleStart}
                disabled={pending}
                loading={pending}
                fullWidth
                className="bg-primary hover:bg-primary-hover"
            >
                {pending ? t('starting') : t('start')}
            </Button>

            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                {t('note', { hours: ttlHours })}
            </p>
            <a
                href={SAMPLE_SITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:text-primary-hover font-medium transition-colors"
            >
                {t('sample')}
            </a>
        </section>
    );
}
