'use client';

import { usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import {
    User,
    SlidersHorizontal,
    Lock,
    Key,
    AlertTriangle,
    HardDrive,
    Github,
    FolderGit2,
    Bot,
    Boxes,
    Cpu,
    Plug,
    Package,
    Building2,
    CreditCard,
    BarChart3,
    Server,
    Newspaper,
    Bell,
    MessagesSquare,
    Mail,
    LayoutGrid,
    Globe,
    Webhook,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
import type { SettingsMenuResponse, SettingsMenuCategory } from '@/lib/api/plugins';
import { ROUTES } from '@/lib/constants';
import { getCategoryIcon } from '@/lib/utils/plugin-category-icons';

interface SettingsLayoutClientProps {
    children: React.ReactNode;
    settingsMenu: SettingsMenuResponse | null;
    /**
     * `FLEET_ENABLED`, resolved on the server. Defaults to true so a
     * caller that has not been updated still shows the tab — the flag
     * exists to let an operator turn Fleet OFF, never to make the
     * shipped default depend on someone remembering to pass a prop.
     */
    fleetEnabled?: boolean;
    /**
     * Whether this deployment shows the App Launcher (APW-11 T16, FR-54/FR-65,
     * ACC-11-28), resolved on the server by `isAppLauncherEnabled` and passed
     * through `settings/layout.tsx`.
     *
     * The default is the **opposite** of `fleetEnabled` on purpose: the launcher
     * is off by default per installation and fails closed, so a caller that
     * forgets the prop — or a deployment whose flag service cannot be reached —
     * must get no tab, exactly as the API answers `404` for the routes behind
     * it. A tab to a route that 404s is worse than no tab.
     */
    appLauncherEnabled?: boolean;
    /**
     * Whether the API has the anonymous usage statistics module, resolved on
     * the server (`instanceStatsAPI.isAvailable`): `false` when its status
     * route answers 404 (not switched on by `EVER_STATS_ENABLED`), so a switched-off
     * installation shows no tab for a feature that does not run. Defaults to
     * true: only a definite 404 hides it.
     */
    everPlatformEnabled?: boolean;
}

interface StaticTab {
    id: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    href: string;
}

/**
 * Shared Ever shell, A9 — the settings pages in groups: **Account** first
 * (Profile, Preferences, Notifications, then the person's other settings), then
 * the **Organization**, then the product's own groups. Grouping only orders and
 * labels the tabs declared below (and their gates); it never drops one: a tab no
 * group names is shown at the end of the product group.
 */
type SettingsGroupId = 'account' | 'organization' | 'product' | 'integrations';

export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; tabs: readonly string[] }> = [
    {
        id: 'account',
        // App Launcher stays directly after Notifications (APW-11 plan §7).
        tabs: [
            'profile',
            'preferences',
            'notifications',
            'app-launcher',
            'security',
            'api-keys',
            'data',
        ],
    },
    { id: 'organization', tabs: ['organization', 'billing', 'usage'] },
    {
        id: 'product',
        tabs: [
            'work-agent',
            'repositories',
            'github-app',
            'fleet',
            'job-runtime',
            'environments',
            'connections',
            'agent-plugins',
            'digest',
            'ever-platform',
        ],
    },
    { id: 'integrations', tabs: ['channels', 'emails', 'webhooks', 'ever-gauzy'] },
];

/** The visible tabs, in groups and in each group's order; unnamed tabs join the product group. */
export function groupSettingsTabs<T extends { id: string }>(
    tabs: readonly T[],
): Array<{ id: SettingsGroupId; tabs: T[] }> {
    const named = new Set(SETTINGS_GROUPS.flatMap((group) => group.tabs));
    return SETTINGS_GROUPS.map((group) => {
        const inGroup = group.tabs
            .map((id) => tabs.find((tab) => tab.id === id))
            .filter((tab): tab is T => tab !== undefined);
        if (group.id === 'product') inGroup.push(...tabs.filter((tab) => !named.has(tab.id)));
        return { id: group.id, tabs: inGroup };
    }).filter((group) => group.tabs.length > 0);
}

export function SettingsLayoutClient({
    children,
    settingsMenu,
    // Default true per the prop's contract above: the flag exists to turn
    // Fleet OFF, never to require callers to opt in. (This prop was declared
    // and passed by the server layout but never destructured, so FLEET_ENABLED
    // had no effect on the nav — the tab rendered unconditionally.)
    fleetEnabled = true,
    // Default FALSE — the launcher fails closed (see the prop's contract).
    appLauncherEnabled = false,
    // Default true: the tab is hidden only when the API answered 404.
    everPlatformEnabled = true,
}: SettingsLayoutClientProps) {
    const pathname = usePathname();
    const t = useTranslations('dashboard.settings');

    const baseSettingsPath = '/settings';

    // Static tabs — always visible except `fleet`, which honours FLEET_ENABLED
    // (filtered at the end of this memo).
    const staticTabs: StaticTab[] = useMemo(
        () =>
            [
                { id: 'profile', label: t('tabs.profile'), icon: User, href: baseSettingsPath },
                // Shared Ever shell, A9: Preferences right after Profile — theme,
                // App Launcher position and language, in that order.
                {
                    id: 'preferences',
                    label: t('tabs.preferences'),
                    icon: SlidersHorizontal,
                    href: ROUTES.DASHBOARD_SETTINGS_PREFERENCES,
                },
                {
                    id: 'organization',
                    label: t('tabs.organization'),
                    icon: Building2,
                    href: `${baseSettingsPath}/organization`,
                },
                {
                    id: 'security',
                    label: t('tabs.security'),
                    icon: Lock,
                    href: `${baseSettingsPath}/security`,
                },
                {
                    id: 'api-keys',
                    label: t('tabs.apiKeys'),
                    icon: Key,
                    href: `${baseSettingsPath}/api-keys`,
                },
                {
                    id: 'data',
                    label: t('tabs.data'),
                    icon: HardDrive,
                    href: `${baseSettingsPath}/data`,
                },
                {
                    id: 'github-app',
                    label: t('tabs.githubApp'),
                    icon: Github,
                    href: `${baseSettingsPath}/github-app`,
                },
                // Repository registry (Feature G) — account-level repos agents
                // can be granted; sits beside GitHub App, its import source.
                {
                    id: 'repositories',
                    label: t('tabs.repositories'),
                    icon: FolderGit2,
                    href: `${baseSettingsPath}/repositories`,
                },
                {
                    id: 'work-agent',
                    label: t('tabs.workAgent'),
                    icon: Bot,
                    href: `${baseSettingsPath}/work-agent`,
                },
                // Fleet sits directly ABOVE Job Runtime by design: Fleet is
                // WHERE work can run; Job Runtime stays HOW work is dispatched.
                {
                    id: 'fleet',
                    label: t('tabs.fleet'),
                    icon: Server,
                    href: `${baseSettingsPath}/fleet`,
                },
                {
                    id: 'job-runtime',
                    label: t('tabs.jobRuntime'),
                    icon: Cpu,
                    href: `${baseSettingsPath}/job-runtime`,
                },
                // Environments sit beside Job Runtime: both describe the
                // sandbox an Agent's work runs in — packages and networking
                // here, dispatch mechanics there.
                {
                    id: 'environments',
                    label: t('tabs.environments'),
                    icon: Boxes,
                    href: `${baseSettingsPath}/environments`,
                },
                // MCP Connections — external MCP servers agents can consume
                // (agent-plugins spec 2.3; manual connections in v1).
                {
                    id: 'connections',
                    label: t('tabs.connections'),
                    icon: Plug,
                    href: `${baseSettingsPath}/connections`,
                },
                // Agent Plugins sits directly after Connections: a connection
                // is one MCP server added by hand, a package can bring several
                // plus the skills that use them.
                {
                    id: 'agent-plugins',
                    label: t('tabs.agentPlugins'),
                    icon: Package,
                    href: `${baseSettingsPath}/agent-plugins`,
                },
                // Digest briefings — the personal cadence AND the org-scoped
                // one live on one page, since they are two records of the
                // same thing rather than two features.
                {
                    id: 'digest',
                    label: t('tabs.digest'),
                    icon: Newspaper,
                    href: `${baseSettingsPath}/digest`,
                },
                // EW-058 — these three pages shipped (notification preferences +
                // Novu inbox, channel CRUD, tenant email addresses) with ZERO
                // inbound links anywhere in the product: reachable only by
                // typing the URL. The entries below are their first entry
                // points. NOTE deliberately NO bare /settings/integrations tab —
                // that path has no index page and would soft-404.
                {
                    id: 'notifications',
                    label: t('tabs.notifications'),
                    icon: Bell,
                    href: `${baseSettingsPath}/notifications`,
                },
                // APW-11 T16 — Manage apps, directly AFTER Notifications (plan
                // §7): it is the App Launcher's own preference page, and it is
                // declared here unconditionally so the ordering comment above it
                // stays true, then filtered below when the server said the
                // launcher is off for this deployment.
                {
                    id: 'app-launcher',
                    label: t('tabs.appLauncher'),
                    icon: LayoutGrid,
                    href: ROUTES.DASHBOARD_SETTINGS_APP_LAUNCHER,
                },
                {
                    id: 'channels',
                    label: t('tabs.channels'),
                    icon: MessagesSquare,
                    href: `${baseSettingsPath}/integrations/channels`,
                },
                {
                    id: 'emails',
                    label: t('tabs.emails'),
                    icon: Mail,
                    href: `${baseSettingsPath}/integrations/emails`,
                },
                // EW-P1-5 — outbound webhooks (v1 work/deploy + v2 domain events).
                {
                    id: 'webhooks',
                    label: t('tabs.webhooks'),
                    icon: Webhook,
                    href: `${baseSettingsPath}/integrations/webhooks`,
                },
                // EW-P1-7 — the Ever Gauzy integration card (manual connection
                // with an `ew_int_` integration key).
                {
                    id: 'ever-gauzy',
                    label: t('tabs.everGauzy'),
                    icon: Plug,
                    href: `${baseSettingsPath}/integrations/ever-gauzy`,
                },
                // Wave 13 — Billing + Usage & Credits (billing/usage PRD §2):
                // also reachable from the settings shell like api-keys/security.
                {
                    id: 'billing',
                    label: t('tabs.billing'),
                    icon: CreditCard,
                    href: `${baseSettingsPath}/billing`,
                },
                {
                    id: 'usage',
                    label: t('tabs.usageCredits'),
                    icon: BarChart3,
                    href: `${baseSettingsPath}/usage`,
                },
                // Ever Platform — anonymous usage statistics of this installation
                // (what is sent, the last payload, the switch). Everyone sees the
                // tab while the API has the module; only the platform admin sees
                // the controls on the page. Filtered below when it is absent.
                {
                    id: 'ever-platform',
                    label: t('tabs.everPlatform'),
                    icon: Globe,
                    href: `${baseSettingsPath}/ever-platform`,
                },
                // The fleet tab is declared unconditionally above (keeping the
                // "Fleet sits directly ABOVE Job Runtime" ordering comment true)
                // and filtered here when the operator has turned Fleet off — the
                // same FLEET_ENABLED switch the API and the Fleet page enforce, so
                // a disabled deployment has no entry point and no route.
                //
                // The App Launcher tab is filtered the same way, from the
                // opposite default: `appLauncherEnabled` is false unless the
                // server layout resolved the launcher ON (FR-54/FR-65).
            ].filter(
                (tab) =>
                    (tab.id !== 'fleet' || fleetEnabled) &&
                    (tab.id !== 'app-launcher' || appLauncherEnabled) &&
                    (tab.id !== 'ever-platform' || everPlatformEnabled),
            ),
        [t, fleetEnabled, appLauncherEnabled, everPlatformEnabled],
    );

    // Danger zone tab (always at bottom)
    const dangerTab: StaticTab = useMemo(
        () => ({
            id: 'danger',
            label: t('tabs.dangerZone'),
            icon: AlertTriangle,
            href: `${baseSettingsPath}/danger`,
        }),
        [t],
    );

    const isActive = (href: string) => {
        if (href === baseSettingsPath) {
            return pathname === baseSettingsPath;
        }
        return pathname === href || pathname.startsWith(href + '/');
    };

    const isCategoryActive = (category: SettingsMenuCategory) => {
        const categoryPath = `${baseSettingsPath}/plugins/${category.category}`;
        return pathname.startsWith(categoryPath);
    };

    const renderStaticTab = (tab: StaticTab) => {
        const Icon = tab.icon;
        return (
            <Link
                key={tab.id}
                href={tab.href}
                className={cn(
                    'w-full flex items-center gap-3 px-4 text-sm py-2 rounded-lg text-left transition-colors',
                    isActive(tab.href)
                        ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                        : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                )}
            >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
            </Link>
        );
    };

    const renderCategoryNav = (category: SettingsMenuCategory) => {
        const Icon = getCategoryIcon(category.category);
        const categoryHref = `${baseSettingsPath}/plugins/${category.category}`;
        const hasUnconfigured = category.plugins.some((p) => p.hasRequiredSettings);

        return (
            <Link
                key={category.category}
                href={categoryHref}
                className={cn(
                    'w-full flex items-center gap-3 px-4 text-sm py-2 rounded-lg text-left transition-colors',
                    isCategoryActive(category)
                        ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
                        : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
                )}
            >
                <Icon className="w-4 h-4" />
                <span className="flex-1">{category.label}</span>
                {hasUnconfigured && (
                    <span
                        className="w-2 h-2 rounded-full bg-warning"
                        title={t('plugins.requiredSettingsMissing')}
                    />
                )}
            </Link>
        );
    };

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
                <p className="text-text-muted dark:text-text-muted-dark mt-2">{t('subtitle')}</p>
            </div>

            <div className="flex flex-col @3xl/main:flex-row gap-8">
                {/* Sidebar Navigation */}
                <div className="@3xl/main:w-64 flex-shrink-0">
                    <nav className="space-y-1">
                        {/* Static tabs, in the groups of A9 */}
                        {groupSettingsTabs(staticTabs).map((group, index) => (
                            <div
                                key={group.id}
                                role="group"
                                aria-labelledby={`settings-group-${group.id}`}
                                data-testid={`settings-group-${group.id}`}
                                className={cn('space-y-1', index > 0 && 'pt-5')}
                            >
                                <p
                                    id={`settings-group-${group.id}`}
                                    className="px-4 pb-1 text-xs font-medium text-text-muted dark:text-text-muted-dark"
                                >
                                    {t(`groups.${group.id}`)}
                                </p>
                                {group.tabs.map(renderStaticTab)}
                            </div>
                        ))}

                        {/* Dynamic plugin category tabs */}
                        {settingsMenu?.categories && settingsMenu.categories.length > 0 && (
                            <div
                                role="group"
                                aria-labelledby="settings-group-plugins"
                                data-testid="settings-group-plugins"
                                className="space-y-1 pt-5"
                            >
                                <p
                                    id="settings-group-plugins"
                                    className="px-4 pb-1 text-xs font-medium text-text-muted dark:text-text-muted-dark"
                                >
                                    {t('groups.plugins')}
                                </p>
                                {settingsMenu.categories.map(renderCategoryNav)}
                            </div>
                        )}

                        {/* Danger zone at bottom */}
                        <div className="pt-4">{renderStaticTab(dangerTab)}</div>
                    </nav>
                </div>

                {/* Content Area */}
                <div className="flex-1 rounded-lg border border-border dark:border-border-dark">
                    <div className="p-6">{children}</div>
                </div>
            </div>
        </div>
    );
}
