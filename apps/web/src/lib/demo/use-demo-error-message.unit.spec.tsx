import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});

import { DemoSignUpUrlContext } from './demo-sign-up-url';
import { useDemoErrorMessage } from './use-demo-error-message';

function messageFor(error: { message?: string } | null | undefined, signUpUrl?: string) {
    const wrapper =
        signUpUrl === undefined
            ? undefined
            : ({ children }: { children: ReactNode }) =>
                  createElement(DemoSignUpUrlContext, { value: signUpUrl }, children);
    return renderHook(() => useDemoErrorMessage(), { wrapper }).result.current(error);
}

describe('useDemoErrorMessage', () => {
    it('shows the friendly DEMO_AI_BUSY message', () => {
        const error = new Error(
            JSON.stringify({ statusCode: 429, code: 'DEMO_AI_BUSY', retryAfterMs: 4000 }),
        );

        expect(messageFor(error)).toBe('The demo AI is busy — try again in a few seconds');
    });

    it('shows the friendly DEMO_AI_QUOTA message', () => {
        const error = new Error(JSON.stringify({ statusCode: 429, code: 'DEMO_AI_QUOTA' }));

        expect(messageFor(error)).toBe(
            'The free demo AI quota is used up for today — sign up on app.ever.works to keep going',
        );
    });

    // R42 f: the sandbox's own cap is not "for today", and the host is the configured one.
    it("words the sandbox's own cap apart and names the configured sign-up host", () => {
        const sandbox = new Error(
            JSON.stringify({ statusCode: 429, code: 'DEMO_AI_QUOTA', quotaScope: 'sandbox' }),
        );
        const day = new Error(
            JSON.stringify({ statusCode: 429, code: 'DEMO_AI_QUOTA', quotaScope: 'day' }),
        );

        expect(messageFor(sandbox, 'https://join.example.test/register')).toBe(
            'This demo workspace has used all its free AI requests — sign up on join.example.test to keep going',
        );
        expect(messageFor(day, 'https://join.example.test/register')).toBe(
            'The free demo AI quota is used up for today — sign up on join.example.test to keep going',
        );
    });

    it('is null for any other error, so the raw text stays', () => {
        expect(messageFor(new Error('An error occurred.'))).toBeNull();
        expect(messageFor(new Error(JSON.stringify({ code: 'THROTTLED' })))).toBeNull();
        expect(messageFor(null)).toBeNull();
    });
});
