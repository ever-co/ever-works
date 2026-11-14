// The Organization module pulls in the whole auth stack; this test needs only
// its name in the link module's imports.
jest.mock('../../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));

import { everConnectAppSyncModuleImports } from '../app-sync/app-sync.module';
import {
    everConnectFeatures,
    isAppSyncEnabled,
    isAppsWriteEnabled,
    isEntitlementsEnabled,
    isHeartbeatEnabled,
    isLinkCodesEnabled,
} from '../ever-connect.switches';
import { everConnectLinkModuleImports } from '../links/ever-connect-link.module';

/**
 * Every switched part is off by default, needs the exact value `true`, and
 * does nothing without `EVER_CONNECT_ENABLED=true`.
 */
describe('Ever Connect — switches', () => {
    const SWITCHES = [
        ['EVER_CONNECT_LINK_CODES_ENABLED', isLinkCodesEnabled, 'linkCodes'],
        ['EVER_CONNECT_HEARTBEAT_ENABLED', isHeartbeatEnabled, 'heartbeat'],
        ['EVER_CONNECT_ENTITLEMENTS_ENABLED', isEntitlementsEnabled, 'entitlements'],
        ['EVER_CONNECT_APP_SYNC_ENABLED', isAppSyncEnabled, 'appSync'],
        ['EVER_CONNECT_APPS_WRITE_ENABLED', isAppsWriteEnabled, 'appsWrite'],
    ] as const;

    it.each(SWITCHES)('%s is off by default and on only with `true`', (name, isOn, feature) => {
        expect(isOn({})).toBe(false);
        expect(isOn({ EVER_CONNECT_ENABLED: 'true' })).toBe(false);
        for (const value of ['1', 'yes', 'on', 'enabled', '', ' ']) {
            expect(isOn({ EVER_CONNECT_ENABLED: 'true', [name]: value })).toBe(false);
        }
        expect(isOn({ EVER_CONNECT_ENABLED: 'true', [name]: 'true' })).toBe(true);
        expect(isOn({ EVER_CONNECT_ENABLED: 'true', [name]: ' TRUE ' })).toBe(true);
        expect(everConnectFeatures({ EVER_CONNECT_ENABLED: 'true', [name]: 'true' })).toEqual({
            linkCodes: false,
            heartbeat: false,
            entitlements: false,
            appSync: false,
            appsWrite: false,
            [feature]: true,
        });
    });

    it.each(SWITCHES)('%s does nothing while Ever Connect itself is off', (name, isOn) => {
        expect(isOn({ [name]: 'true' })).toBe(false);
        expect(isOn({ EVER_CONNECT_ENABLED: 'false', [name]: 'true' })).toBe(false);
    });

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
        expect(everConnectFeatures({})).toEqual({
            linkCodes: false,
            heartbeat: false,
            entitlements: false,
            appSync: false,
            appsWrite: false,
        });
        expect(everConnectFeatures({ EVER_CONNECT_ENABLED: 'true' })).toEqual({
            linkCodes: false,
            heartbeat: false,
            entitlements: false,
            appSync: false,
            appsWrite: false,
        });
    });

    it('one part does not turn on another', () => {
        // Linking an Organization, or its mirror, does not let another app write for a person.
        expect(
            isAppsWriteEnabled({
                EVER_CONNECT_ENABLED: 'true',
                EVER_CONNECT_LINK_CODES_ENABLED: 'true',
                EVER_CONNECT_APP_SYNC_ENABLED: 'true',
                EVER_CONNECT_PROVISIONING_ENABLED: 'true',
            }),
        ).toBe(false);
        expect(
            isAppSyncEnabled({
                EVER_CONNECT_ENABLED: 'true',
                EVER_CONNECT_APPS_WRITE_ENABLED: 'true',
            }),
        ).toBe(false);
    });
});
