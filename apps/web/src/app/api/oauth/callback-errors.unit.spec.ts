import { describe, expect, it, vi } from 'vitest';

// The `@/lib/api` barrel pulls in every API client; the mapper needs only the error class.
vi.mock('@/lib/api', async () => {
    const { ApiResponseError } = await import('@/lib/api/server-api');
    return { ApiResponseError };
});

import { ApiResponseError } from '@/lib/api/server-api';
import messages from '../../../../messages/en.json';
import { getOAuthRouteErrorCode } from './callback-errors';

/**
 * Which `/auth/error?error=` name a failed social sign-in lands on. The API answers a refusal to
 * link into an account whose own email was never verified (the pre-hijacking guard) with a 409
 * like an identity conflict, so it must be told apart by its code, not its status.
 */
describe('getOAuthRouteErrorCode', () => {
    it.each([
        [
            new ApiResponseError('unverified', 409, 'EXISTING_ACCOUNT_EMAIL_UNVERIFIED'),
            'oauth_existing_account_unverified',
        ],
        [
            new ApiResponseError('linked', 409, 'PROVIDER_ACCOUNT_ALREADY_LINKED'),
            'oauth_provider_conflict',
        ],
        // Any other 409 (a dangling link, a record conflict) stays a provider conflict.
        [new ApiResponseError('conflict', 409), 'oauth_provider_conflict'],
        [
            new ApiResponseError('record', 409, 'PROVIDER_ACCOUNT_RECORD_CONFLICT'),
            'oauth_provider_conflict',
        ],
        [new ApiResponseError('Account is suspended', 401), 'account_locked'],
        [
            new ApiResponseError(
                'Unable to link this social account because the provider email is not verified',
                401,
            ),
            'oauth_callback',
        ],
        [new ApiResponseError('boom', 500), 'oauth_callback'],
        [new TypeError('fetch failed'), 'oauth_callback'],
    ])('maps %s to %s', (error, expected) => {
        expect(getOAuthRouteErrorCode(error, 'oauth_callback')).toBe(expected);
    });

    it('maps the code the same way whatever fallback the route uses', () => {
        const error = new ApiResponseError('unverified', 409, 'EXISTING_ACCOUNT_EMAIL_UNVERIFIED');

        expect(getOAuthRouteErrorCode(error, 'oauth_connect_failed')).toBe(
            'oauth_existing_account_unverified',
        );
    });

    it('only trusts the code on an API error, not text that merely mentions it', () => {
        expect(
            getOAuthRouteErrorCode(
                new Error('EXISTING_ACCOUNT_EMAIL_UNVERIFIED'),
                'oauth_callback',
            ),
        ).toBe('oauth_callback');
    });

    // Verifying evicts nobody: the person who opened the account keeps their session, password
    // and links. So the page never tells the reader, who may be the address's real owner, to
    // verify an account they may not have created.
    it('the page message never asks the reader to verify that account', () => {
        const text = messages.auth.error.oauth.existingAccountUnverified;

        expect(text).toContain('contact support');
        expect(text).not.toMatch(/verify (it|its|the|this|that|your)/i);
    });
});
