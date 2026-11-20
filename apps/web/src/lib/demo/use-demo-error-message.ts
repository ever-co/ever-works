'use client';

import { useTranslations } from 'next-intl';
import { demoErrorKeyFromText, demoErrorValues } from './demo-errors';
import { useDemoSignUpUrl } from './demo-sign-up-url';

/**
 * The friendly demo message for an error whose text is the API's JSON error body (a chat
 * stream error, see `chatStreamErrorText`), or null for any other error.
 */
export function useDemoErrorMessage(): (
    error: { message?: string } | null | undefined,
) => string | null {
    const t = useTranslations('demo.errors');
    const signUpUrl = useDemoSignUpUrl();
    return (error) => {
        const key = demoErrorKeyFromText(error?.message);
        return key ? t(key, demoErrorValues(signUpUrl)) : null;
    };
}
