jest.mock('@ever-works/agent/database', () => ({
    ExternalIdentityRepository: class ExternalIdentityRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    IdentityProviderFacadeService: class IdentityProviderFacadeService {},
}));
jest.mock('./ever-id-activity.service', () => ({
    EverIdActivityService: class EverIdActivityService {},
}));
jest.mock('./ever-id-telemetry.service', () => ({
    EverIdTelemetryService: class EverIdTelemetryService {},
    EVER_ID_TELEMETRY_EVENTS: { DELEGATED_READ: 'ever_id.delegated_read' },
}));

import { IdentityTokenRejectedError } from '@ever-works/plugin';
import { EVER_ID_TRUSTED_CLIENT_IDS_ENV } from '../ever-id-trusted-clients';
import { EverIdDelegationService } from './ever-id-delegation.service';

/**
 * The delegated read's token rules as the delegation service hands them to the identity
 * provider (APW-12 FR-45, FR-46), and the one rule it adds on request:
 * `EVER_ID_TRUSTED_CLIENT_IDS` becomes the plugin's `allowedAuthorizedParties`. The plugin's
 * own enforcement of that list (`badAuthorizedParty`) is pinned by its access-token spec, and
 * the end-to-end refusal by `launcher-delegated-read.integration.spec.ts`.
 */

const TOKEN = 'aaaa.bbbb.cccc';

function build(trusted: string | undefined, nodeEnv = 'test') {
    const previous = {
        trusted: process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV],
        nodeEnv: process.env.NODE_ENV,
    };
    if (trusted === undefined) delete process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
    else process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = trusted;
    process.env.NODE_ENV = nodeEnv;

    const facade = {
        isEnabled: jest.fn().mockResolvedValue(true),
        verifyAccessToken: jest.fn().mockResolvedValue({
            issuer: 'https://id.example.test',
            subject: 'subject-1',
            audience: ['ever-works'],
            scopes: ['apps:read'],
            authorizedParty: 'app-ever-co',
            issuedAt: 1,
            expiresAt: 2,
            jti: null,
        }),
        getConfigurationStatus: jest.fn().mockResolvedValue({ delegatedClientNames: [] }),
    };
    const identities = {
        findByIssuerSubject: jest.fn().mockResolvedValue({ id: 'identity-1', userId: 'user-1' }),
        recordDelegatedClient: jest.fn().mockResolvedValue({ firstInWindow: false }),
    };
    const users = {
        findById: jest.fn().mockResolvedValue({
            id: 'user-1',
            email: 'a@example.com',
            username: 'a',
            registrationProvider: 'local',
            emailVerified: true,
            isActive: true,
            avatar: null,
        }),
    };
    const activity = { delegatedRead: jest.fn() };
    const telemetry = { emit: jest.fn() };

    try {
        const service = new EverIdDelegationService(
            facade as never,
            identities as never,
            users as never,
            activity as never,
            telemetry as never,
        );
        return { service, facade, identities, users, activity };
    } finally {
        if (previous.trusted === undefined) delete process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
        else process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = previous.trusted;
        process.env.NODE_ENV = previous.nodeEnv;
    }
}

const CTX = { ipAddress: null, userAgent: null };

describe('EverIdDelegationService — the token rules it asks the provider to apply', () => {
    it('without trusted clients, passes no authorised-party rule: FR-45 exactly as written', async () => {
        const { service, facade } = build(undefined);

        await expect(service.authenticate(TOKEN, 'apps:read', CTX)).resolves.not.toBeNull();
        const rules = facade.verifyAccessToken.mock.calls[0][1];
        expect(rules).toEqual({ requiredScopes: ['apps:read'], maxLifetimeSeconds: 3_600 });
        expect(rules).not.toHaveProperty('allowedAuthorizedParties');
    });

    it('an empty value (an unset variable rendered by a manifest) is the same as unset', async () => {
        const { service, facade } = build('');

        await service.authenticate(TOKEN, 'apps:read', CTX);
        expect(facade.verifyAccessToken.mock.calls[0][1]).not.toHaveProperty(
            'allowedAuthorizedParties',
        );
    });

    it('with trusted clients, requires the token to be minted for one of them', async () => {
        const { service, facade } = build('app-ever-co, launcher-two');

        await service.authenticate(TOKEN, 'apps:read', CTX);
        expect(facade.verifyAccessToken).toHaveBeenCalledWith(TOKEN, {
            requiredScopes: ['apps:read'],
            maxLifetimeSeconds: 3_600,
            allowedAuthorizedParties: ['app-ever-co', 'launcher-two'],
        });
    });

    it('answers a token refused for its authorised party with null — the guard’s plain 401', async () => {
        const { service, facade } = build('app-ever-co');
        facade.verifyAccessToken.mockRejectedValueOnce(
            Object.assign(new Error('badAuthorizedParty'), {
                name: 'IdentityTokenRejectedError',
                code: 'badAuthorizedParty',
            }),
        );

        await expect(service.authenticate(TOKEN, 'apps:read', CTX)).resolves.toBeNull();
    });

    it('reads the list once, at construction: a later change needs a restart', async () => {
        const { service, facade } = build('app-ever-co');
        process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = 'someone-else';
        try {
            await service.authenticate(TOKEN, 'apps:read', CTX);
        } finally {
            delete process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
        }
        expect(facade.verifyAccessToken.mock.calls[0][1].allowedAuthorizedParties).toEqual([
            'app-ever-co',
        ]);
    });

    it('a misconfigured value stops a production boot', () => {
        expect(() => build('not a client id', 'production')).toThrow(/EVER_ID_TRUSTED_CLIENT_IDS/);
    });
});

/**
 * The delegated write (`@DelegatedWrite('apps:write')`): the same token rules
 * with the write scope, and the one answer that differs from a read.
 */
describe('EverIdDelegationService — a delegated write', () => {
    const WRITE = { access: 'write' } as const;
    /** The provider's refusal of a token that does not carry a scope it was asked for. */
    const missingScope = () => new IdentityTokenRejectedError('missingScope');

    it('asks the provider for the write scope, with every other rule of a read', async () => {
        const { service, facade } = build('app-ever-co');
        facade.verifyAccessToken.mockResolvedValueOnce({
            issuer: 'https://id.example.test',
            subject: 'subject-1',
            audience: ['ever-works'],
            scopes: ['apps:read', 'apps:write'],
            authorizedParty: 'app-ever-co',
            issuedAt: 1,
            expiresAt: 2,
            jti: null,
        });

        const principal = await service.authenticate(TOKEN, 'apps:write', CTX, WRITE);

        expect(facade.verifyAccessToken).toHaveBeenCalledWith(TOKEN, {
            requiredScopes: ['apps:write'],
            maxLifetimeSeconds: 3_600,
            allowedAuthorizedParties: ['app-ever-co'],
        });
        expect(principal).toMatchObject({
            // Never a session: every control that needs a person's own session refuses it.
            user: { userId: 'user-1', authMethod: 'ever-id-delegated' },
            binding: {
                identityId: 'identity-1',
                clientId: 'app-ever-co',
                scopes: ['apps:read', 'apps:write'],
            },
        });
    });

    it('refuses a token that may only read with 403 insufficient_scope', async () => {
        const { service, facade, identities } = build(undefined);
        facade.verifyAccessToken.mockRejectedValueOnce(missingScope());

        const refusal = service.authenticate(TOKEN, 'apps:write', CTX, WRITE);
        await expect(refusal).rejects.toMatchObject({
            status: 403,
            response: { status: 'error', code: 'insufficient_scope' },
        });
        // Refused on the token alone: nobody is looked up.
        expect(identities.findByIssuerSubject).not.toHaveBeenCalled();
    });

    it('says so when a valid token names a person with no connected identity here', async () => {
        const { service, identities, users, activity } = build(undefined);
        identities.findByIssuerSubject.mockResolvedValueOnce(null);

        const refusal = service.authenticate(TOKEN, 'apps:write', CTX, WRITE);
        await expect(refusal).rejects.toMatchObject({
            status: 403,
            response: { status: 'error', code: 'no_linked_identity' },
        });
        // Nothing of the person is in the answer, and nothing is recorded for nobody.
        await refusal.catch((error: { response: { message: string } }) => {
            expect(error.response.message).not.toMatch(/subject-1|id\.example\.test|@/);
        });
        expect(users.findById).not.toHaveBeenCalled();
        expect(identities.recordDelegatedClient).not.toHaveBeenCalled();
        expect(activity.delegatedRead).not.toHaveBeenCalled();
    });

    it('a read of the same token keeps the plain 401 (null): only a write explains', async () => {
        const { service, identities } = build(undefined);
        identities.findByIssuerSubject.mockResolvedValue(null);

        await expect(service.authenticate(TOKEN, 'apps:read', CTX)).resolves.toBeNull();
        await expect(
            service.authenticate(TOKEN, 'apps:read', CTX, { access: 'read' }),
        ).resolves.toBeNull();
    });

    it.each([
        ['a token that does not verify', 'badSignature'],
        ['an expired token', 'expired'],
        ['a token minted for another client', 'badAuthorizedParty'],
        ['a token for another audience', 'badAudience'],
    ])('answers %s with null — the plain 401, never a reason', async (_name, code) => {
        const { service, facade, identities } = build('app-ever-co');
        facade.verifyAccessToken.mockRejectedValueOnce(
            new IdentityTokenRejectedError(code as never),
        );

        await expect(service.authenticate(TOKEN, 'apps:write', CTX, WRITE)).resolves.toBeNull();
        expect(identities.findByIssuerSubject).not.toHaveBeenCalled();
    });

    it('answers a disabled or missing account with null, as a read does', async () => {
        const { service, users } = build(undefined);
        users.findById.mockResolvedValueOnce({ id: 'user-1', isActive: false });
        await expect(service.authenticate(TOKEN, 'apps:write', CTX, WRITE)).resolves.toBeNull();
        users.findById.mockResolvedValueOnce(null);
        await expect(service.authenticate(TOKEN, 'apps:write', CTX, WRITE)).resolves.toBeNull();
    });

    it('does nothing while Ever ID is turned off', async () => {
        const { service, facade } = build(undefined);
        facade.isEnabled.mockResolvedValueOnce(false);

        await expect(service.authenticate(TOKEN, 'apps:write', CTX, WRITE)).resolves.toBeNull();
        expect(facade.verifyAccessToken).not.toHaveBeenCalled();
    });
});
