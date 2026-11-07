import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
    EverInstallRequestsView,
    InstanceStatsReportView,
    InstanceStatsStatus,
} from '@ever-works/contracts';
import { isInstanceStatsOperatorStatus } from '@ever-works/contracts';
import { InstallRequestsPanel } from '@/components/settings/InstallRequestsPanel';
import { UsageStatisticsSettings } from '@/components/settings/UsageStatisticsSettings';
import { ApiResponseError } from '@/lib/api/server-api';
import { everConnectInstallsAPI } from '@/lib/api/ever-connect-installs';
import { instanceStatsAPI } from '@/lib/api/instance-stats';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.everPlatform');
    return { title: t('title') };
}

/**
 * Settings → Ever Platform. Two sections, each shown only where the API has
 * its module:
 *
 * - Anonymous usage statistics (off unless `EVER_STATS_ENABLED=true`). The
 *   platform admin gets the full section (state, what is sent, the last
 *   payload, Send now, the switch, Reset identity); anyone else gets whether
 *   statistics are on and who manages them.
 * - Install requests from apps.ever.co (the Ever Connect module, off unless
 *   `EVER_CONNECT_ENABLED=true`): platform admins only. A user who is not a
 *   platform admin gets 403 from the API and no section.
 *
 * When neither answers (404, and 404 or 403), there is no feature to show, so
 * the page answers 404 too (and the settings nav has no tab for it).
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

    if (statsState === 'absent' && installsState === 'absent') notFound();

    let last: InstanceStatsReportView | null = null;
    if (status && isInstanceStatsOperatorStatus(status)) {
        last = await instanceStatsAPI
            .last()
            .then((result) => result.report)
            .catch(() => null);
    }

    return (
        <div className="space-y-10">
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
