'use client';

import { useTranslations } from 'next-intl';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { DemoLoginCard } from './DemoLoginCard';

interface DemoRegisterPanelProps {
    signUpUrl: string;
    ttlHours: number;
}

/**
 * The register page on a demo instance: no form (the API answers 403 to
 * `POST /auth/register` there), just a link to where accounts are really
 * created and the same one-click demo button the sign-in page has.
 */
export function DemoRegisterPanel({ signUpUrl, ttlHours }: DemoRegisterPanelProps) {
    const t = useTranslations('demo.register');

    return (
        <AuthLayout title={t('title')} subtitle={t('body')}>
            <div className="space-y-6">
                <a
                    href={signUpUrl}
                    data-testid="demo-sign-up-link"
                    className="block w-full rounded-lg bg-primary hover:bg-primary-hover px-4 py-2.5 text-center text-sm font-medium text-white transition-colors"
                >
                    {t('signUp')}
                </a>
                <p className="text-center text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('orTry')}
                </p>
                <DemoLoginCard ttlHours={ttlHours} />
            </div>
        </AuthLayout>
    );
}
