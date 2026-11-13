import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
    EverInstallRequestsView,
    EverPlatformConnectionStatusView,
    InstanceStatsReportView,
    InstanceStatsStatus,
} from '@ever-works/contracts';
import { isInstanceStatsOperatorStatus } from '@ever-works/contracts';
import { EverPlatformConnectionPanel } from '@/components/settings/EverPlatformConnectionPanel';
import { EverPlatformOrganizationLinks } from '@/components/settings/EverPlatformOrganizationLinks';
import { InstallRequestsPanel } from '@/components/settings/InstallRequestsPanel';
import { UsageStatisticsSettings } from '@/components/settings/UsageStatisticsSettings';
import { ApiResponseError } from '@/lib/api/server-api';
import { everConnectAPI } from '@/lib/api/ever-connect';
import { everConnectInstallsAPI } from '@/lib/api/ever-connect-installs';
import { instanceStatsAPI } from '@/lib/api/instance-stats';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.everPlatform');
    return { title: t('title') };
}

/**
 * Settings → Ever Platform. Four sections, each shown only where the API has
 * its module:
 *
 * - The connection to Ever Platform (the Ever Connect module, off unless
 *   `EVER_CONNECT_ENABLED=true`): platform admins only. Where the connection
 *   stands, the form for a connect code, Disconnect, and what the parts that
 *   are switched on separately report.
 * - An Organization's link to its Ever organization (off unless
 *   `EVER_CONNECT_LINK_CODES_ENABLED=true` as well): for each Organization
 *   the person belongs to, its link and, for its administrators, the form for
 *   a link code. Nothing is asked for it where the connection's own answer
 *   already says linking is off, and a failure to read it hides this section
 *   only.
 * - Anonymous usage statistics (off unless `EVER_STATS_ENABLED=true`). The
 *   platform admin gets the full section (state, what is sent, the last
 *   payload, Send now, the switch, Reset identity); anyone else gets whether
 *   statistics are on and who manages them.
 * - Install requests from apps.ever.co (the Ever Connect module, off unless
 *   `EVER_CONNECT_ENABLED=true`): platform admins only. A user who is not a
 *   platform admin gets 403 from the API and no section.
 *
 * When none answers (404, or 403 for the platform admins' sections), there is
 * no feature to show, so the page answers 404 too (and the settings nav has no
 * tab for it).
 */
export default async function EverPlatformSettingsPage() {
    let status: InstanceStatsStatus | null = null;
    let statsState: 'loaded' | 'unavailable' | 'absent' = 'loaded';
    try {
        status = await instanceStatsAPI.status();
    } catch (error) {
        statsState =
            error instanceof ApiResponseError && error.statusCode === 404
                ? 'absent'
                : 'unavailable';
    }

    let installs: EverInstallRequestsView | null = null;
    let installsState: 'loaded' | 'unavailable' | 'absent' = 'loaded';
    try {
        installs = await everConnectInstallsAPI.listIfAvailable();
        if (!installs) installsState = 'absent';
    } catch {
        installsState = 'unavailable';
    }

    // One request tells how the Ever Connect module answers this person: not
    // at all (404), as a platform admin (the status), or as someone else (403).
    const access = await everConnectAPI.access();
    const connection: EverPlatformConnectionStatusView | null =
        access.kind === 'admin' ? access.status : null;
    const connectionState: 'loaded' | 'unavailable' | 'absent' =
        access.kind === 'admin' ? 'loaded' : access.kind === 'unknown' ? 'unavailable' : 'absent';

    // An Organization's link: asked only where linking can be switched on, and
    // never fatal to the page (`null`: no section).
    const links = await everConnectAPI.organizationLinks(access).catch(() => null);
    const linksShown = links !== null;

    if (
        statsState === 'absent' &&
        installsState === 'absent' &&
        connectionState === 'absent' &&
        !linksShown
    ) {
        notFound();
    }

    let last: InstanceStatsReportView | null = null;
    if (status && isInstanceStatsOperatorStatus(status)) {
        last = await instanceStatsAPI
            .last()
            .then((result) => result.report)
            .catch(() => null);
    }

    return (
        <div className="space-y-10">
            {connectionState !== 'absent' && (
                <EverPlatformConnectionPanel state={connectionState} initial={connection} />
            )}
            {links !== null && <EverPlatformOrganizationLinks organizations={links} />}
            {statsState !== 'absent' && (
                <UsageStatisticsSettings
                    state={statsState}
                    initialStatus={status}
                    initialLast={last}
                />
            )}
            {installsState !== 'absent' && (
                <InstallRequestsPanel state={installsState} initial={installs} />
            )}
        </div>
    );
}
