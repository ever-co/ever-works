// The Organization module pulls in the whole auth stack; this test needs only
// its name in the link module's imports.
jest.mock('../../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));

import { everConnectAppSyncModuleImports } from '../app-sync/app-sync.module';
import {
    everConnectFeatures,
    hasTrustedWriteClients,
    isAppSyncEnabled,
    isAppsWriteEnabled,
    isAppsWriteSwitchedOn,
    isBlueprintHandoffEnabled,
    isEntitlementsEnabled,
    isHeartbeatEnabled,
    isLinkCodesEnabled,
} from '../ever-connect.switches';
import { everConnectLinkModuleImports } from '../links/ever-connect-link.module';

const ALL_OFF = {
    linkCodes: false,
    heartbeat: false,
    entitlements: false,
    appSync: false,
    appsWrite: false,
    blueprintHandoff: false,
};

/** What writing for a person needs besides its switch: the apps that may. */
const TRUSTED = { EVER_ID_TRUSTED_CLIENT_IDS: 'app-ever-co' };

/**
 * Every switched part is off by default, needs the exact value `true`, and
 * does nothing without `EVER_CONNECT_ENABLED=true`.
 */
describe('Ever Connect — switches', () => {
    const SWITCHES = [
        ['EVER_CONNECT_LINK_CODES_ENABLED', isLinkCodesEnabled, 'linkCodes', {}],
        ['EVER_CONNECT_HEARTBEAT_ENABLED', isHeartbeatEnabled, 'heartbeat', {}],
        ['EVER_CONNECT_ENTITLEMENTS_ENABLED', isEntitlementsEnabled, 'entitlements', {}],
        ['EVER_CONNECT_APP_SYNC_ENABLED', isAppSyncEnabled, 'appSync', {}],
        // With the list it needs; without it, see the tests of its own below.
        ['EVER_CONNECT_APPS_WRITE_ENABLED', isAppsWriteEnabled, 'appsWrite', TRUSTED],
        [
            'EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED',
            isBlueprintHandoffEnabled,
            'blueprintHandoff',
            {},
        ],
    ] as const;

    it.each(SWITCHES)(
        '%s is off by default and on only with `true`',
        (name, isOn, feature, also) => {
            const connect = { EVER_CONNECT_ENABLED: 'true', ...also };
            expect(isOn({})).toBe(false);
            expect(isOn(also)).toBe(false);
            expect(isOn(connect)).toBe(false);
            for (const value of ['1', 'yes', 'on', 'enabled', '', ' ']) {
                expect(isOn({ ...connect, [name]: value })).toBe(false);
            }
            expect(isOn({ ...connect, [name]: 'true' })).toBe(true);
            expect(isOn({ ...connect, [name]: ' TRUE ' })).toBe(true);
            expect(everConnectFeatures({ ...connect, [name]: 'true' })).toEqual({
                ...ALL_OFF,
                [feature]: true,
            });
        },
    );

    it.each(SWITCHES)(
        '%s does nothing while Ever Connect itself is off',
        (name, isOn, _feature, also) => {
            expect(isOn({ ...also, [name]: 'true' })).toBe(false);
            expect(isOn({ ...also, EVER_CONNECT_ENABLED: 'false', [name]: 'true' })).toBe(false);
        },
    );

    it('the link and mirror modules are in the graph only with their switch', () => {
        expect(everConnectLinkModuleImports({})).toEqual([]);
        expect(everConnectLinkModuleImports({ EVER_CONNECT_ENABLED: 'true' })).toEqual([]);
        expect(everConnectLinkModuleImports({ EVER_CONNECT_LINK_CODES_ENABLED: 'true' })).toEqual(
            [],
        );
        expect(
            everConnectLinkModuleImports({
                EVER_CONNECT_ENABLED: 'true',
                EVER_CONNECT_LINK_CODES_ENABLED: 'true',
            }),
        ).toHaveLength(1);

        expect(everConnectAppSyncModuleImports({})).toEqual([]);
        expect(everConnectAppSyncModuleImports({ EVER_CONNECT_ENABLED: 'true' })).toEqual([]);
        expect(everConnectAppSyncModuleImports({ EVER_CONNECT_APP_SYNC_ENABLED: 'true' })).toEqual(
            [],
        );
        expect(
            everConnectAppSyncModuleImports({
                EVER_CONNECT_ENABLED: 'true',
                EVER_CONNECT_APP_SYNC_ENABLED: 'true',
            }),
        ).toHaveLength(1);
    });

    it('nothing is on by default: every part is off on an installation that sets nothing', () => {
        expect(everConnectFeatures({})).toEqual(ALL_OFF);
        expect(everConnectFeatures({ EVER_CONNECT_ENABLED: 'true' })).toEqual(ALL_OFF);
        // A list of trusted apps is not a switch: on its own it turns nothing on.
        expect(everConnectFeatures({ EVER_CONNECT_ENABLED: 'true', ...TRUSTED })).toEqual(ALL_OFF);
    });

    it('one part does not turn on another', () => {
        // Linking an Organization, or its mirror, does not let another app write for a person.
        expect(
            isAppsWriteEnabled({
                EVER_CONNECT_ENABLED: 'true',
                EVER_CONNECT_LINK_CODES_ENABLED: 'true',
                EVER_CONNECT_APP_SYNC_ENABLED: 'true',
                EVER_CONNECT_PROVISIONING_ENABLED: 'true',
                EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED: 'true',
                ...TRUSTED,
            }),
        ).toBe(false);
        expect(
            isAppSyncEnabled({
                EVER_CONNECT_ENABLED: 'true',
                EVER_CONNECT_APPS_WRITE_ENABLED: 'true',
                ...TRUSTED,
            }),
        ).toBe(false);
        // Writing for a person does not let an address carry an install, nor the reverse.
        expect(
            isBlueprintHandoffEnabled({
                EVER_CONNECT_ENABLED: 'true',
                EVER_CONNECT_APPS_WRITE_ENABLED: 'true',
                ...TRUSTED,
            }),
        ).toBe(false);
    });

    describe('writing for a person needs a list of the apps that may', () => {
        const SWITCHED_ON = {
            EVER_CONNECT_ENABLED: 'true',
            EVER_CONNECT_APPS_WRITE_ENABLED: 'true',
        };

        it.each([
            ['unset', {}],
            ['empty', { EVER_ID_TRUSTED_CLIENT_IDS: '' }],
            ['only spaces', { EVER_ID_TRUSTED_CLIENT_IDS: '   ' }],
            ['only separators', { EVER_ID_TRUSTED_CLIENT_IDS: ' , ,, ' }],
            ['nothing that is a client id', { EVER_ID_TRUSTED_CLIENT_IDS: 'not a client id' }],
        ])('the switch alone leaves it off: the list is %s', (_name, list) => {
            const env = { ...SWITCHED_ON, ...list };
            expect(isAppsWriteSwitchedOn(env)).toBe(true);
            expect(hasTrustedWriteClients(env)).toBe(false);
            expect(isAppsWriteEnabled(env)).toBe(false);
            // The operator's status reports what runs, not what was asked for.
            expect(everConnectFeatures(env).appsWrite).toBe(false);
        });

        it.each([
            ['one app', 'app-ever-co'],
            ['several apps', 'app-ever-co, another-app'],
            ['a list with an entry that is not a client id', 'not a client id, app-ever-co'],
        ])('with the switch and %s it is on', (_name, list) => {
            const env = { ...SWITCHED_ON, EVER_ID_TRUSTED_CLIENT_IDS: list };
            expect(hasTrustedWriteClients(env)).toBe(true);
            expect(isAppsWriteEnabled(env)).toBe(true);
            expect(everConnectFeatures(env).appsWrite).toBe(true);
        });

        it('the list alone is not the switch', () => {
            expect(isAppsWriteSwitchedOn({ EVER_CONNECT_ENABLED: 'true', ...TRUSTED })).toBe(false);
            expect(isAppsWriteEnabled({ EVER_CONNECT_ENABLED: 'true', ...TRUSTED })).toBe(false);
        });
    });
});
