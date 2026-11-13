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
import {
    EverPlatformOrganizationLinks,
    type EverPlatformOrganizationLinkItem,
} from '@/components/settings/EverPlatformOrganizationLinks';
import { InstallRequestsPanel } from '@/components/settings/InstallRequestsPanel';
import { UsageStatisticsSettings } from '@/components/settings/UsageStatisticsSettings';
import { ApiResponseError } from '@/lib/api/server-api';
import { everConnectAPI } from '@/lib/api/ever-connect';
import { everConnectInstallsAPI } from '@/lib/api/ever-connect-installs';
import { instanceStatsAPI } from '@/lib/api/instance-stats';
import { teamsAPI } from '@/lib/api/teams';

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
 *   the person belongs to, its link and the form for a link code.
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

    let connection: EverPlatformConnectionStatusView | null = null;
    let connectionState: 'loaded' | 'unavailable' | 'absent' = 'loaded';
    try {
        connection = await everConnectAPI.statusIfAvailable();
        if (!connection) connectionState = 'absent';
    } catch {
        connectionState = 'unavailable';
    }

    // An Organization's link: read for each Organization of the person. The
    // first answer tells whether linking is switched on at all (404: no section).
    const links: EverPlatformOrganizationLinkItem[] = [];
    let linksAbsent = false;
    for (const organization of await teamsAPI.listOrganizations()) {
        if (linksAbsent) break;
        let view = null;
        try {
            view = await everConnectAPI.organizationLinkIfAvailable(organization.id);
            if (!view) {
                linksAbsent = true;
                break;
            }
        } catch {
            // Read failed for this Organization: its row says so.
        }
        links.push({
            organizationId: organization.id,
            displayName: organization.displayName,
            slug: organization.slug,
            view,
        });
    }
    const linksShown = !linksAbsent && links.length > 0;

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
            {linksShown && <EverPlatformOrganizationLinks organizations={links} />}
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
