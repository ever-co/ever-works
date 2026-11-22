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
import { createHash } from 'node:crypto';
import { OAuthStateService } from '../services/oauth-state.service';
import { SavedAccountSessionService } from '../services/saved-account-session.service';

/**
 * The session table as rows, so "the other session is gone" is the same lookup the session
 * guard makes (a bearer with no row is a 401), and the real `SavedAccountSessionService` runs.
 */
function sessionTable() {
    const rows: Array<{ id: string; userId: string; tokenHash: string | null }> = [];
    const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
    const repo = {
        find: jest.fn(async ({ where }: { where: { userId: string } }) =>
            rows.filter((row) => row.userId === where.userId),
        ),
        delete: jest.fn(async (ids: string[]) => {
            for (const id of ids) {
                const index = rows.findIndex((row) => row.id === id);
                if (index >= 0) rows.splice(index, 1);
            }
        }),
        update: jest.fn(async () => ({ affected: 0 })),
    };
    return {
        repo,
        dataSource: { getRepository: () => repo },
        add: (userId: string, token: string) =>
            rows.push({ id: `s${rows.length + 1}`, userId, tokenHash: hash(token) }),
        /** Whether this bearer still has a session row (else the guard answers 401). */
        authenticates: (token: string) => rows.some((row) => row.tokenHash === hash(token)),
    };
}

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
    let authProvider: { issueSession: jest.Mock };
    let sessions: ReturnType<typeof sessionTable>;
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
        sessions = sessionTable();
        authProvider = {
            issueSession: jest.fn(async (userId: string) => {
                sessions.add(userId, 'fresh');
                return { access_token: 'fresh' };
            }),
        };
        controller = new OAuthClaimController(
            socialAuth as never,
            socialClaim as never,
            oauthState,
            terms as never,
            activityLog as never,
            new SavedAccountSessionService(authProvider as never, sessions.dataSource as never),
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
                expectedUserId: 'anon-1',
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
        // Rotation: the fresh session first, then every other session of the account ends.
        expect(authProvider.issueSession.mock.invocationCallOrder[0]).toBeLessThan(
            sessions.repo.find.mock.invocationCallOrder[0],
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

        await controller.claim(
            'github',
            { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
            req,
            makeRes(),
        );

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
            controller.claim(
                'github',
                { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
                req,
                makeRes(),
            ),
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
            controller.claim(
                'github',
                { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
                req,
                makeRes(),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
        expect(socialClaim.claim).not.toHaveBeenCalled();
        expect(terms.record).not.toHaveBeenCalled();
    });

    it('refuses a save intent bound to another account before anything is recorded or spent', async () => {
        // A save cookie tossed from a sibling subdomain carries the attacker's user id, never
        // this session's: the API checks the binding again, server-side.
        const { state, req } = signedIn();

        await expect(
            controller.claim(
                'github',
                { code: 'c', state, expectedUserId: 'attacker-anon', terms: TERMS },
                req,
                makeRes(),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(terms.record).not.toHaveBeenCalled();
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
        expect(socialClaim.claim).not.toHaveBeenCalled();
    });

    it('saves only with GitHub or Google: another configured provider is a 400 first', async () => {
        const { state, req } = signedIn();

        await expect(
            controller.claim(
                'facebook',
                { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
                req,
                makeRes(),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(socialAuth.getProviderDisplayName).not.toHaveBeenCalled();
        expect(terms.record).not.toHaveBeenCalled();
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
    });

    it('refuses an unknown provider with 400 before anything is recorded or spent', async () => {
        socialAuth.getProviderDisplayName.mockImplementation(() => {
            throw new BadRequestException('Unsupported OAuth provider: discord');
        });
        const { state, req } = signedIn();

        await expect(
            controller.claim(
                'discord',
                { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
                req,
                makeRes(),
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(terms.record).not.toHaveBeenCalled();
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
    });

    it('refuses a state the browser does not hold, before anything else (C-03)', async () => {
        const { req } = signedIn();
        const res = makeRes();

        await expect(
            controller.claim(
                'github',
                { code: 'c', expectedUserId: 'anon-1', state: 'attacker-state' },
                req,
                res,
            ),
        ).rejects.toThrow(/OAuth state verification failed/);
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
        expect(socialClaim.claim).not.toHaveBeenCalled();
        expect(String(res._headers['set-cookie'])).toContain('Max-Age=0');
    });

    it('refuses a registered (not anonymous) session without exchanging the code', async () => {
        const { state, req } = signedIn({ userId: 'u-registered', isAnonymous: false });

        await expect(
            controller.claim(
                'github',
                { code: 'c', expectedUserId: 'anon-1', state },
                req,
                makeRes(),
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(socialAuth.fetchSocialUser).not.toHaveBeenCalled();
    });

    it('passes a 409 from the service through, issues no session and revokes nothing', async () => {
        socialClaim.claim.mockRejectedValue(
            new ConflictException({ code: 'PROVIDER_ACCOUNT_ALREADY_LINKED' }),
        );
        const { state, req } = signedIn();

        await expect(
            controller.claim(
                'github',
                { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
                req,
                makeRes(),
            ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(authProvider.issueSession).not.toHaveBeenCalled();
        expect(sessions.repo.delete).not.toHaveBeenCalled();
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

        await controller.claim(
            'github',
            { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
            spoofed,
            makeRes(),
        );

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
            { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
            req,
            makeRes(),
        );

        expect(result).not.toHaveProperty('access_token');
        expect(result.user).toMatchObject({ id: 'anon-1' });
        expect(sessions.repo.delete).not.toHaveBeenCalled();
    });

    it('ends every other session of the saved account: a second one gets 401 afterwards', async () => {
        // The anonymous bearer that asked, and a SECOND session of the same temporary account
        // (e.g. an attacker's, if the session cookie was planted from a sibling subdomain).
        sessions.add('anon-1', 'anon-token');
        sessions.add('anon-1', 'second-token');
        sessions.add('someone-else', 'other-user-token');
        const { state, req } = signedIn();

        const result = await controller.claim(
            'github',
            { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
            req,
            makeRes(),
        );

        expect(result).toMatchObject({ access_token: 'fresh' });
        expect(sessions.authenticates('fresh')).toBe(true);
        expect(sessions.authenticates('anon-token')).toBe(false);
        expect(sessions.authenticates('second-token')).toBe(false);
        expect(sessions.authenticates('other-user-token')).toBe(true);
        expect(sessions.repo.update).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'anon-1', isActive: true }),
            { isActive: false },
        );
    });

    it('still answers the fresh token when ending the other sessions fails', async () => {
        sessions.repo.delete.mockRejectedValue(new Error('revoke failed'));
        const { state, req } = signedIn();

        await expect(
            controller.claim(
                'github',
                { code: 'c', expectedUserId: 'anon-1', state, terms: TERMS },
                req,
                makeRes(),
            ),
        ).resolves.toMatchObject({ access_token: 'fresh' });
    });
});
