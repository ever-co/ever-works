'use server';

import { authAPI } from '@/lib/api';
import { setAuthAccessCookie } from '@/lib/auth/cookies';
import { ApiResponseError } from '@/lib/api/server-api';

// Not exported: a `'use server'` module may only export async functions, so
// the result shape stays module-private (the client consumes it structurally).
type StartDemoResult =
    | { success: true }
    | {
          success: false;
          reason: 'throttled' | 'full' | 'captcha' | 'error';
          error: string;
      };

/**
 * Mint a private demo sandbox (`POST /auth/demo`) and persist its session as the
 * same encrypted httpOnly cookie the login flow sets.
 *
 *   429                          → throttled (the per-IP limiter)
 *   503 + `DEMO_FULL`            → full (too many live sandboxes)
 *   400                          → captcha (Turnstile verification failed)
 */
export async function startDemo(input: { captchaToken?: string }): Promise<StartDemoResult> {
    try {
        const res = await authAPI.startDemo({ captchaToken: input.captchaToken || undefined });
        await setAuthAccessCookie(res.access_token);
        return { success: true };
    } catch (error) {
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 429) {
                return {
                    success: false,
                    reason: 'throttled',
                    error: 'Too many attempts — please try again shortly.',
                };
            }
            if (error.statusCode === 503 && error.code === 'DEMO_FULL') {
                return {
                    success: false,
                    reason: 'full',
                    error: 'The demo is full right now — please try again in a few minutes.',
                };
            }
            if (error.statusCode === 400) {
                return {
                    success: false,
                    reason: 'captcha',
                    error: 'We could not verify your browser. Please try again.',
                };
            }
        }
        return {
            success: false,
            reason: 'error',
            error: 'Could not start the demo. Please try again.',
        };
    }
}
