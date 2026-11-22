jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { USER_LOGIN: 'USER_LOGIN' },
    ActivityStatus: { COMPLETED: 'COMPLETED' },
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
// The real service reaches the legal corpus; the controller only needs its two calls.
jest.mock('../../terms/terms-acceptance.service', () => ({
    TermsAcceptanceService: class TermsAcceptanceService {},
}));

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { OAuthClaimController } from './oauth-claim.controller';
import { OAuthStateService } from '../services/oauth-state.service';

describe('OAuthClaimController (POST /api/oauth/:providerId/claim)', () => {
    const TERMS = [
        {
            documentId: 'tos:ever-works',
            version: '1.0.0',
            sha256: 'a'.repeat(64),
            locale: 'en',
        },
    ];

    let oauthState: OAuthStateService;
    let socialAuth: {
        fetchSocialUser: jest.Mock;
        getProviderDisplayName: jest.Mock;
    };
    let socialClaim: { claim: jest.Mock };
    let terms: { assertClaimsArePublished: jest.Mock; record: jest.Mock };
    let activityLog: { log: jest.Mock };
    let authProvider: { issueSession: jest.Mock; signOut: jest.Mock };
    let controller: OAuthClaimController;

    const socialUser = { provider: 'github', providerUserId: '4242', email: 'v@example.com' };

    beforeEach(() => {
        oauthState = new OAuthStateService();
        socialAuth = {
            fetchSocialUser: jest.fn().mockResolvedValue(socialUser),
            getProviderDisplayName: jest.fn().mockReturnValue('GitHub'),
        };
        socialClaim = {
            claim: jest.fn().mockResolvedValue({
                id: 'anon-1',
                email: 'v@example.com',
                username: 'anon-deadbeef',
                emailVerified: true,
                provider: 'github',
            }),
        };
        terms = {
            assertClaimsArePublished: jest.fn(),
            record: jest.fn().mockResolvedValue([]),
        };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };
        authProvider = {
            issueSession: jest.fn().mockResolvedValue({ access_token: 'fresh' }),
            signOut: jest.fn().mockResolvedValue(undefined),
        };
        controller = new OAuthClaimController(
            socialAuth as never,
            socialClaim as never,
            oauthState,
            terms as never,
            activityLog as never,
            authProvider as never,
        );
    });

    function makeRes() {
        const headers: Record<string, string | string[]> = {};
        return {
            setHeader: (name: string, value: string | string[]) => {
                headers[name.toLowerCase()] = value;
            },
            _headers: headers,
        };
    }

    /** A request from the web callback route: anonymous bearer user + the mirrored state cookie. */
    function signedIn(
        user: { userId?: string; isAnonymous?: boolean } | null = {
            userId: 'anon-1',
            isAnonymous: true,
        },
    ) {
        const { state, setCookie } = oauthState.mint({ secure: false });
        return {
            state,
            req: {
                ip: '203.0.113.5',
                headers: {
                    'user-agent': 'UA',
                    cookie: setCookie.split(';')[0],
                    authorization: 'Bearer anon-token',
                },
                user,
            },
        };
    }

    it('saves the signed-in anonymous user with the provider identity and rotates the session', async () => {
        const { state, req } = signedIn();
        const res = makeRes();

        const result = await controller.claim(
            'github',
            {
                code: 'code-1',
                state,
                terms: TERMS,
                emailVerificationCallbackUrl: 'https://ever.works/api/auth/verify-email',
            },
            req,
            res,
        );

        expect(socialAuth.fetchSocialUser).toHaveBeenCalledWith('github', 'code-1');
        // The session decides which account is saved, never the body.
        expect(socialClaim.claim).toHaveBeenCalledWith('anon-1', socialUser, {
            emailVerificationCallbackUrl: 'https://ever.works/api/auth/verify-email',
        });
        expect(terms.record).toHaveBeenCalledWith('anon-1', TERMS, {
            method: 'signup-checkbox',
            ip: '203.0.113.5',
            userAgent: 'UA',
        });
        expect(authProvider.issueSession).toHaveBeenCalledWith('anon-1', {
            ipAddress: '203.0.113.5',
            userAgent: 'UA',
        });
        // Rotation: the fresh session first, then the anonymous bearer the web forwarded is revoked.
        expect(authProvider.signOut).toHaveBeenCalledTimes(1);
        const revoked = authProvider.signOut.mock.calls[0][0] as Headers;
        expect(revoked.get('authorization')).toBe('Bearer anon-token');
        expect(authProvider.issueSession.mock.invocationCallOrder[0]).toBeLessThan(
            authProvider.signOut.mock.invocationCallOrder[0],
        );
        expect(result).toEqual({
            access_token: 'fresh',
            user: {
                id: 'anon-1',
                email: 'v@example.com',
                username: 'anon-deadbeef',
                emailVerified: true,
            },
        });
        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'anon-1',
                action: 'user.account_claimed',
                metadata: { provider: 'github' },
            }),
        );
        // C-03 single use.
        expect(String(res._headers['set-cookie'])).toContain('Max-Age=0');
    });

    it('records the terms BEFORE the code is spent or the account changes', async () => {
        const { state, req } = signedIn();

        await controller.claim('github', { code: 'c', state, terms: TERMS }, req, makeRes());

        expect(terms.record.mock.invocationCallOrder[0]).toBeLessThan(
            socialAuth.fetchSocialUser.mock.invocationCallOrder[0],
        );
        expect(terms.record.mock.invocationCallOrder[0]).toBeLessThan(
            socialClaim.claim.mock.invocationCallOrder[0],
        );
    });

    it('refuses with 503, account untouched and code unspent, when the terms cannot be recorded', async () => {
        terms.record.mockRejectedValue(new Error('db blip'));
        const { state, req } = signedIn();

        await expect(
            controller.claim('github', { code: 'c', state, terms: TERMS }, req, makeRes()),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
        expect(socialClaim.claim).not.toHaveBeenCalled();
        expect(authProvider.issueSession).not.toHaveBeenCalled();
    });

    it('refuses unpublished terms before the code is spent or the account changes', async () => {
        terms.assertClaimsArePublished.mockImplementation(() => {
            throw new BadRequestException('unpublished');
        });
        const { state, req } = signedIn();

        await expect(
            controller.claim('github', { code: 'c', state, terms: TERMS }, req, makeRes()),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
        expect(socialClaim.claim).not.toHaveBeenCalled();
        expect(terms.record).not.toHaveBeenCalled();
    });

    it('refuses a state the browser does not hold, before anything else (C-03)', async () => {
        const { req } = signedIn();
        const res = makeRes();

        await expect(
            controller.claim('github', { code: 'c', state: 'attacker-state' }, req, res),
        ).rejects.toThrow(/OAuth state verification failed/);
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
        expect(socialClaim.claim).not.toHaveBeenCalled();
        expect(String(res._headers['set-cookie'])).toContain('Max-Age=0');
    });

    it('refuses a registered (not anonymous) session without exchanging the code', async () => {
        const { state, req } = signedIn({ userId: 'u-registered', isAnonymous: false });

        await expect(
            controller.claim('github', { code: 'c', state }, req, makeRes()),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
    });

    it('passes a 409 from the service through, issues no session and revokes nothing', async () => {
        socialClaim.claim.mockRejectedValue(
            new ConflictException({ code: 'PROVIDER_ACCOUNT_ALREADY_LINKED' }),
        );
        const { state, req } = signedIn();

        await expect(
            controller.claim('github', { code: 'c', state, terms: TERMS }, req, makeRes()),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(authProvider.issueSession).not.toHaveBeenCalled();
        expect(authProvider.signOut).not.toHaveBeenCalled();
        expect(activityLog.log).not.toHaveBeenCalled();
    });

    it('never records a client-written X-Forwarded-For address (trust proxy decides req.ip)', async () => {
        const { state, req } = signedIn();
        const spoofed = {
            ...req,
            ip: undefined,
            socket: { remoteAddress: '10.0.0.7' },
            headers: { ...req.headers, 'x-forwarded-for': '6.6.6.6' },
        };

        await controller.claim('github', { code: 'c', state, terms: TERMS }, spoofed, makeRes());

        expect(authProvider.issueSession).toHaveBeenCalledWith('anon-1', {
            ipAddress: '10.0.0.7',
            userAgent: 'UA',
        });
        expect(terms.record).toHaveBeenCalledWith(
            'anon-1',
            TERMS,
            expect.objectContaining({ ip: '10.0.0.7' }),
        );
        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ ipAddress: '10.0.0.7' }),
        );
    });

    it('keeps the anonymous session (no token, nothing revoked) when no fresh one can be issued', async () => {
        authProvider.issueSession.mockRejectedValue(new Error('session store down'));
        const { state, req } = signedIn();

        const result = await controller.claim(
            'github',
            { code: 'c', state, terms: TERMS },
            req,
            makeRes(),
        );

        expect(result).not.toHaveProperty('access_token');
        expect(result.user).toMatchObject({ id: 'anon-1' });
        expect(authProvider.signOut).not.toHaveBeenCalled();
    });

    it('still answers the fresh token when revoking the anonymous one fails', async () => {
        authProvider.signOut.mockRejectedValue(new Error('revoke failed'));
        const { state, req } = signedIn();

        await expect(
            controller.claim('github', { code: 'c', state, terms: TERMS }, req, makeRes()),
        ).resolves.toMatchObject({ access_token: 'fresh' });
    });
});
