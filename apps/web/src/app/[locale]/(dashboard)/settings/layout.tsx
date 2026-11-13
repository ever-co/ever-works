import { getAuthFromRequest } from '@/lib/auth';
import { everConnectAPI } from '@/lib/api/ever-connect';
import { instanceStatsAPI } from '@/lib/api/instance-stats';
import { pluginsAPI, type SettingsMenuResponse } from '@/lib/api/plugins';
import { isAppLauncherEnabled } from '@/lib/feature-flags/app-launcher';
import { isFleetEnabled } from '@/lib/fleet-flags';
import { SettingsLayoutClient } from './settings-layout-client';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
    // The Ever Platform tab exists only where the API has something to show
    // there: the statistics module (unless `EVER_STATS_ENABLED=true`, off by
    // default, its status route answers 404), or, for a platform admin, the
    // connection and the install requests of the Ever Connect module (unless
    // `EVER_CONNECT_ENABLED=true`, off by default, its routes answer 404), or,
    // for a member of an Organization, its link to an Ever organization
    // (unless `EVER_CONNECT_LINK_CODES_ENABLED=true` as well, off by default,
    // its routes answer 404).
    // Otherwise: no tab, and the page itself answers 404.
    //
    // This runs on every Settings navigation, so the Ever Connect module is
    // asked ONE question (its status route): where the module is off, which is
    // the default, that 404 is the only request, and for a platform admin the
    // 200 is. An Organization's link is probed only for a person who is not a
    // platform admin on a deployment that has the module loaded.
    const [settingsMenu, statsAvailable, everConnectAvailable] = await Promise.all([
        pluginsAPI.listForSettingsMenu().catch((error: unknown): SettingsMenuResponse | null => {
            // If the API fails, we'll just show static tabs without plugin categories
            console.error('Failed to fetch settings menu:', error);
            return null;
        }),
        instanceStatsAPI.isAvailable(),
        everConnectAPI.settingsTabAvailable(),
    ]);
    const everPlatformEnabled = statsAvailable || everConnectAvailable;

    // APW-11 T16 — the App Launcher flag is resolved HERE, in the nested server
    // layout that renders the nav, and passed down as a prop.
    //
    // Neither of the two obvious alternatives works (APW11-G13):
    //
    //   - the **client** nav cannot read the flag itself: `isAppLauncherEnabled`
    //     reads a non-public env var through the API and PostHog, and in the
    //     browser that answer is `undefined` — the tab would be missing on the
    //     server pass and reappear after hydration, for every deployment;
    //   - the **parent** layout cannot pass it in: an App Router layout does not
    //     receive props from the layout above it, so the dashboard shell's own
    //     `appLauncherEnabled` (which it resolves for the header control) is not
    //     visible here.
    //
    // The id is the session's `sub`, the same id the dashboard shell evaluates
    // the PostHog half with (FR-54), and it is read from the JWT-backed request
    // helper rather than a profile fetch: this is a flag, not page data, and it
    // must not add a round trip to every settings render.
    const auth = await getAuthFromRequest();
    const appLauncherEnabled = await isAppLauncherEnabled(
        auth.isAuthenticated ? auth.user?.sub : undefined,
    );

    // `FLEET_ENABLED` is read here, on the server, and passed down: the
    // nav is a client component and must not read a non-public env var
    // itself (it would be `undefined` in the browser and the tab would
    // reappear). Same switch the API and the Fleet page enforce, so a
    // disabled deployment has no entry point AND no route.
    //
    // `appLauncherEnabled` is the same shape with the opposite default: the
    // launcher is off unless the flag says otherwise, and the client nav
    // defaults the prop to `false`.
    return (
        <SettingsLayoutClient
            settingsMenu={settingsMenu}
            fleetEnabled={isFleetEnabled()}
            appLauncherEnabled={appLauncherEnabled}
            everPlatformEnabled={everPlatformEnabled}
        >
            {children}
        </SettingsLayoutClient>
    );
}
