import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import { demoErrorKey, demoErrorKeyFromText, demoErrorValues } from './demo-errors';

/**
 * Platform demo mode (R42 f) — the shared demo error mapper. A used-up AI quota is one of two
 * limits: the sandbox's own cap (`DEMO_AI_REQUESTS_PER_SANDBOX`, for its whole life) or the
 * instance's UTC day (`DEMO_AI_REQUESTS_PER_DAY`). The API says which (`quotaScope`), and only
 * the day is "for today". The sign-up host is the instance's configured `DEMO_SIGN_UP_URL`.
 */
describe('demo error mapper', () => {
    it('maps a used-up quota to the day or the sandbox message by its quotaScope', () => {
        expect(demoErrorKey('DEMO_AI_QUOTA', 'sandbox')).toBe('aiQuotaSandbox');
        expect(demoErrorKey('DEMO_AI_QUOTA', 'day')).toBe('aiQuota');
        // An API that does not say (an older one, or a worker's echo) keeps today's message.
        expect(demoErrorKey('DEMO_AI_QUOTA')).toBe('aiQuota');
        expect(demoErrorKey('DEMO_AI_QUOTA', 'something')).toBe('aiQuota');
        // The scope means nothing for any other code.
        expect(demoErrorKey('DEMO_AI_BUSY', 'sandbox')).toBe('aiBusy');
        expect(demoErrorKey('THROTTLED', 'sandbox')).toBeNull();
    });

    it('reads the quotaScope from a JSON error body', () => {
        expect(
            demoErrorKeyFromText(
                JSON.stringify({ statusCode: 429, code: 'DEMO_AI_QUOTA', quotaScope: 'sandbox' }),
            ),
        ).toBe('aiQuotaSandbox');
        expect(
            demoErrorKeyFromText(JSON.stringify({ code: 'DEMO_AI_QUOTA', quotaScope: 'day' })),
        ).toBe('aiQuota');
        expect(demoErrorKeyFromText(JSON.stringify({ error: { code: 'DEMO_AI_QUOTA' } }))).toBe(
            'aiQuota',
        );
    });

    it("gives the messages the configured sign-up URL's host, and the default one otherwise", () => {
        expect(demoErrorValues('https://join.example.test/register?ref=demo')).toEqual({
            signUpHost: 'join.example.test',
        });
        for (const unusable of [null, undefined, '', 'not a url']) {
            expect(demoErrorValues(unusable)).toEqual({ signUpHost: 'app.ever.works' });
        }
    });

    it('words the two quota limits apart, with the sign-up host as a placeholder', () => {
        const errors = en.demo.errors as Record<string, string>;
        expect(errors.aiQuota).toBe(
            'The free demo AI quota is used up for today — sign up on {signUpHost} to keep going',
        );
        expect(errors.aiQuotaSandbox).toBe(
            'This demo workspace has used all its free AI requests — sign up on {signUpHost} to keep going',
        );
        for (const message of Object.values(errors)) {
            expect(message).not.toContain('app.ever.works');
        }
    });
});
