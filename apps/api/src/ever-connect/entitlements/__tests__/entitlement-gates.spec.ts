import { generateKeyPairSync, sign } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    EverConnectEntitlement,
    EverConnectIntegration,
    EverConnectLink,
} from '@ever-works/agent/entities';
import { EverConnectIntegrationService } from '../../ever-connect-integration.service';
import type { EverConnectService } from '../../ever-connect.service';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import {
    ENTITLEMENT_GATED_INTEGRATIONS,
    entitlementFeatureOf,
    grantsFeature,
} from '../entitlement-gates';
import {
    EverConnectEntitlementService,
    linkEntitlementSubject,
} from '../ever-connect-entitlement.service';

/**
 * The integrations a plan decides (`EVER_CONNECT_ENTITLEMENT_GATES_ENABLED`):
 * which feature each needs, when a stored document grants it, which links a
 * gate lets through on a real database, and what an integration's link states
 * become. Off, nothing changes: every link is let through without a read.
 */
const NOW = new Date('2026-11-26T10:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_S = 86_400;
const GRACE_S = 30 * DAY_S;

const LINK_IN_DATE = '01JZ8Q3M4N5P6R7S8T9V0W1XA1';
const LINK_WITHOUT_FEATURE = '01JZ8Q3M4N5P6R7S8T9V0W1XB2';
const LINK_IN_GRACE = '01JZ8Q3M4N5P6R7S8T9V0W1XC3';
const LINK_PAST_GRACE = '01JZ8Q3M4N5P6R7S8T9V0W1XD4';
const LINK_NEVER_READ = '01JZ8Q3M4N5P6R7S8T9V0W1XE5';
const LINK_NO_DOCUMENT = '01JZ8Q3M4N5P6R7S8T9V0W1XF6';

const FEATURES_OFF = {
    handle: true,
    discoverability: true,
    lookup: false,
    'profile.public': false,
    'profile.badges': false,
    listings: false,
    'marketplace.buy': true,
    'instances.multi': false,
    ever_id_login: true,
    app_sync: false,
    usage_reporting: false,
    provider_access: false,
};

const { privateKey } = generateKeyPairSync('ed25519');

/**
 * A compact JWS of a link's document, as the service stores one after the SDK
 * verified it (the service only decodes a stored document again).
 */
function document(linkId: string, exp: number, features: Record<string, boolean>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'EdDSA', typ: 'ever-entitlement+jwt', kid: 'test-key' })}.${encode({
        iss: 'https://api.ever.test',
        aud: 'ever-connect',
        sub: linkEntitlementSubject(linkId),
        iat: exp - 7 * DAY_S,
        nbf: exp - 7 * DAY_S,
        exp,
        ever: {
            schema: 'ever.entitlement.v1',
            seq: 1,
            tier: 'paid',
            plan: { code: 'selfhosted:works:small_business', source: 'staff' },
            features: { ...FEATURES_OFF, ...features },
            limits: {},
            grace_s: GRACE_S,
            refresh_after_s: 21_600,
        },
    })}`;
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

describe('entitlement gates — the mapping', () => {
    it('gates the apps mirror on `app_sync` and install requests on `listings`, nothing else', () => {
        expect(ENTITLEMENT_GATED_INTEGRATIONS).toEqual({
            app_sync: 'app_sync',
            marketplace_installs: 'listings',
        });
        expect(entitlementFeatureOf('app_sync')).toBe('app_sync');
        expect(entitlementFeatureOf('marketplace_installs')).toBe('listings');
        // Sign in with Ever ID is never gated, and neither is anything unknown.
        for (const key of ['ever_id_login', 'stats_link', 'webhooks', 'constructor', '']) {
            expect(entitlementFeatureOf(key)).toBeNull();
        }
    });

    it('a document grants a feature only in date or in its grace period, and only with `true`', () => {
        expect(grantsFeature({ status: 'valid', features: { app_sync: true } }, 'app_sync')).toBe(
            true,
        );
        expect(grantsFeature({ status: 'grace', features: { app_sync: true } }, 'app_sync')).toBe(
            true,
        );
        expect(grantsFeature({ status: 'paused', features: { app_sync: true } }, 'app_sync')).toBe(
            false,
        );
        expect(grantsFeature({ status: 'valid', features: { app_sync: false } }, 'app_sync')).toBe(
            false,
        );
        expect(grantsFeature({ status: 'valid', features: {} }, 'app_sync')).toBe(false);
        expect(grantsFeature(null, 'app_sync')).toBe(false);
    });
});

describe('EverConnectEntitlementService.linksGranting', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let entitlements: EverConnectEntitlementService;
    const ALL = [
        LINK_IN_DATE,
        LINK_WITHOUT_FEATURE,
        LINK_IN_GRACE,
        LINK_PAST_GRACE,
        LINK_NEVER_READ,
        LINK_NO_DOCUMENT,
    ];

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_ENTITLEMENTS_ENABLED = 'true';
        process.env.EVER_CONNECT_ENTITLEMENT_GATES_ENABLED = 'true';
        const documents = dataSource.getRepository(EverConnectEntitlement);
        await documents.clear();
        const stored = (linkId: string, values: Partial<EverConnectEntitlement>) => ({
            subject: linkEntitlementSubject(linkId),
            fetchedAt: NOW,
            ...values,
        });
        await documents.insert([
            stored(LINK_IN_DATE, {
                document: document(LINK_IN_DATE, NOW_S + DAY_S, { app_sync: true }),
            }),
            stored(LINK_WITHOUT_FEATURE, {
                document: document(LINK_WITHOUT_FEATURE, NOW_S + DAY_S, { app_sync: false }),
            }),
            stored(LINK_IN_GRACE, {
                document: document(LINK_IN_GRACE, NOW_S - 10 * DAY_S, { app_sync: true }),
            }),
            stored(LINK_PAST_GRACE, {
                document: document(LINK_PAST_GRACE, NOW_S - 31 * DAY_S, { app_sync: true }),
            }),
            // A read that never succeeded keeps only its reason.
            stored(LINK_NEVER_READ, { lastError: 'unavailable' }),
        ]);
        entitlements = new EverConnectEntitlementService(
            documents,
            dataSource.getRepository(EverConnectLink),
            {} as EverConnectService,
        );
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('lets through only the links whose document grants the feature, in date or in grace', async () => {
        const granted = await entitlements.linksGranting('app_sync', ALL, NOW);
        expect([...granted].sort()).toEqual([LINK_IN_DATE, LINK_IN_GRACE].sort());
    });

    it('a link that is not a tenant link id is never let through', async () => {
        const granted = await entitlements.linksGranting(
            'app_sync',
            ['not-a-link', `${LINK_IN_DATE}'`],
            NOW,
        );
        expect([...granted]).toEqual([]);
    });

    it.each([
        ['the gates are off', 'EVER_CONNECT_ENTITLEMENT_GATES_ENABLED'],
        ['the documents are not read', 'EVER_CONNECT_ENTITLEMENTS_ENABLED'],
        ['Ever Connect is off', 'EVER_CONNECT_ENABLED'],
    ])('while %s, every given link is let through without a read', async (_name, off) => {
        delete process.env[off];
        const find = jest.spyOn(dataSource.getRepository(EverConnectEntitlement), 'find');
        const given = [...ALL, 'not-a-link'];
        const granted = await entitlements.linksGranting('app_sync', given, NOW);
        expect([...granted]).toEqual(given);
        expect(find).not.toHaveBeenCalled();
        find.mockRestore();
    });
});

describe('EverConnectIntegrationService.linkStates — with the gates', () => {
    const rows = [
        { linkId: LINK_IN_DATE, state: 'enabled', enabled: true },
        { linkId: LINK_WITHOUT_FEATURE, state: 'enabled', enabled: true },
        { linkId: LINK_NEVER_READ, state: 'disabled', enabled: false },
    ] as EverConnectIntegration[];

    const service = (linksGranting: jest.Mock | undefined) =>
        new EverConnectIntegrationService(
            { find: async () => rows } as never,
            {} as EverConnectService,
            {} as never,
            undefined,
            undefined,
            linksGranting ? ({ linksGranting } as never) : undefined,
        );

    it('a link whose document does not grant the feature counts as not enabled; its state stays', async () => {
        const linksGranting = jest.fn(async () => new Set([LINK_IN_DATE]));
        const states = await service(linksGranting).linkStates('marketplace_installs');
        expect(states).toEqual([
            { linkId: LINK_IN_DATE, state: 'enabled', enabled: true },
            { linkId: LINK_WITHOUT_FEATURE, state: 'enabled', enabled: false },
            { linkId: LINK_NEVER_READ, state: 'disabled', enabled: false },
        ]);
        // Only the links that are enabled are asked about, for the feature the catalog names.
        expect(linksGranting).toHaveBeenCalledWith('listings', [
            LINK_IN_DATE,
            LINK_WITHOUT_FEATURE,
        ]);
    });

    it('an integration a plan does not decide is not asked about, and stays as reported', async () => {
        const linksGranting = jest.fn(async () => new Set<string>());
        const states = await service(linksGranting).linkStates('webhooks');
        expect(states.map((state) => state.enabled)).toEqual([true, true, false]);
        expect(linksGranting).not.toHaveBeenCalled();
    });

    it('without the entitlement service, the states are as reported', async () => {
        const states = await service(undefined).linkStates('marketplace_installs');
        expect(states.map((state) => state.enabled)).toEqual([true, true, false]);
    });

    describe('with the gates on and nothing to read the documents', () => {
        const savedEnv = { ...process.env };

        beforeEach(() => {
            process.env.EVER_CONNECT_ENABLED = 'true';
            process.env.EVER_CONNECT_ENTITLEMENTS_ENABLED = 'true';
            process.env.EVER_CONNECT_ENTITLEMENT_GATES_ENABLED = 'true';
        });

        afterEach(() => {
            process.env = { ...savedEnv };
        });

        it('a gated integration is closed for every link; any other stays as reported', async () => {
            const gated = await service(undefined).linkStates('marketplace_installs');
            expect(gated.map((state) => state.enabled)).toEqual([false, false, false]);
            expect(gated.map((state) => state.state)).toEqual(['enabled', 'enabled', 'disabled']);
            const other = await service(undefined).linkStates('webhooks');
            expect(other.map((state) => state.enabled)).toEqual([true, true, false]);
        });
    });
});
