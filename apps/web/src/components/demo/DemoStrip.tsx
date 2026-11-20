import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export interface DemoStripProps {
    signUpUrl: string;
    /** The sandbox's `anonymousExpiresAt`, ISO 8601. */
    expiresAt: string;
    /** Live AI is used up for today (the instance's daily quota). */
    aiQuotaExhausted: boolean;
    /** The sandbox's recorded Goal; null when it is gone, which leaves the quota line unlinked. */
    recordedGoalHref: string | null;
}

const HOUR_MS = 3_600_000;

/**
 * Platform demo mode — the strip above the dashboard header on a demo account: it says so,
 * points at the real sign-up, shows how long the workspace lives, and says when live AI is
 * used up. Not dismissible: it is the one place a demo visitor is told this is a demo.
 * Modelled on `JobRuntimeDegradedBanner` (`role="status"`).
 */
export function DemoStrip({
    signUpUrl,
    expiresAt,
    aiQuotaExhausted,
    recordedGoalHref,
}: DemoStripProps) {
    const t = useTranslations('demo.strip');
    // Rounded down; under an hour (or already past it) reads "less than 1 h", never 0 or negative.
    const hoursLeft = Math.floor((new Date(expiresAt).getTime() - Date.now()) / HOUR_MS);
    const linkClass = 'underline underline-offset-2 hover:no-underline';

    return (
        <div
            role="status"
            data-testid="demo-strip"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-sky-300/60 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-950/40 px-4 py-2 text-sm text-sky-900 dark:text-sky-200"
        >
            <p className="min-w-0 flex-1">
                {t('message')}{' '}
                <a
                    href={signUpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="demo-strip-sign-up"
                    className={`font-medium ${linkClass}`}
                >
                    {t('signUp')}
                </a>{' '}
                {t('afterSignUp')}
            </p>
            <p className="shrink-0 text-sky-800/90 dark:text-sky-200/80">
                {hoursLeft >= 1 ? t('expires', { hours: hoursLeft }) : t('expiresSoon')}
            </p>
            {aiQuotaExhausted && (
                <p className="basis-full" data-testid="demo-strip-quota">
                    {recordedGoalHref ? (
                        <Link href={recordedGoalHref} className={linkClass}>
                            {t('quotaExhausted')}
                        </Link>
                    ) : (
                        t('quotaExhausted')
                    )}
                </p>
            )}
        </div>
    );
}
