'use client';

import { useEffect, useState } from 'react';
import { HelpLink } from '@/components/help/HelpLink';
import { useTranslations } from 'next-intl';
import { AlertTriangle, X } from 'lucide-react';
import { EVER_WORKS_DOCS_URL, isEverHostedDeployment } from '@/lib/about-info';

const DISMISS_KEY = 'ew-job-runtime-banner-dismissed';

/**
 * Loud-degradation banner: shown when the API's health reports that NO
 * background job runtime is configured (`job_runtime.configured=false`),
 * which means Agent runs silently cannot execute — the worst failure
 * mode of a local install. Dismissible per browser via localStorage;
 * `configured === null` (health unreachable/unparseable) renders
 * nothing — this banner reports a KNOWN misconfiguration, it does not
 * speculate.
 *
 * Same hydration-gating pattern as the header onboarding badge: render
 * nothing until localStorage has been consulted so previously-dismissed
 * users never see a one-frame flash.
 *
 * The external docs.ever.works link renders only on Ever's own hosted app
 * (`*.ever.works`). A self-hosted install keeps the in-app help link, which
 * opens the same job-runtime article, and renders no link to an Ever host:
 * the egress audit's browser leg fails on a new one, and its DOM baseline
 * may only shrink (`tools/egress-audit/README.md`, "The DOM baseline").
 * The host is read after mount, like the dismissal, so the server and the
 * first client render agree.
 */
export function JobRuntimeDegradedBanner({ configured }: { configured: boolean | null }) {
    const t = useTranslations('dashboard.jobRuntimeBanner');
    const [dismissed, setDismissed] = useState(true);
    const [everHosted, setEverHosted] = useState(false);

    useEffect(() => {
        setEverHosted(isEverHostedDeployment(window.location.origin));
        try {
            setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1');
        } catch {
            // localStorage unavailable (private mode, quota) — show the
            // banner; a misconfigured install matters more than a flash.
            setDismissed(false);
        }
    }, []);

    if (configured !== false || dismissed) {
        return null;
    }

    const dismiss = () => {
        setDismissed(true);
        try {
            window.localStorage.setItem(DISMISS_KEY, '1');
        } catch {
            // Best-effort persistence; state above already hides it.
        }
    };

    return (
        <div
            role="status"
            data-testid="job-runtime-degraded-banner"
            className="flex items-start gap-3 border-b border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200"
        >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <span className="font-medium">{t('title')}</span>{' '}
                <span className="text-amber-800/90 dark:text-amber-200/80">{t('message')}</span>{' '}
                {everHosted && (
                    <>
                        <a
                            href={`${EVER_WORKS_DOCS_URL}/`}
                            target="_blank"
                            rel="noreferrer"
                            data-testid="job-runtime-banner-docs-link"
                            className="underline underline-offset-2 hover:no-underline"
                        >
                            {t('docsLink')}
                        </a>{' '}
                    </>
                )}
                <HelpLink
                    target="job-runtimes#settings--job-runtime"
                    variant="error"
                    surface="error_banner"
                    className="ml-2 text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100"
                />
            </div>
            <button
                type="button"
                onClick={dismiss}
                aria-label={t('dismiss')}
                data-testid="job-runtime-banner-dismiss"
                className="shrink-0 rounded p-1 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
                <X className="h-4 w-4" aria-hidden="true" />
            </button>
        </div>
    );
}
