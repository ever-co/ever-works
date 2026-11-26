'use client';

import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import type { AppLauncherItem } from '@ever-works/contracts';
import { captureAppLauncherEvent } from '@/lib/app-launcher/app-launcher-telemetry';
import { addAppUrlFrom } from '@/lib/app-launcher/ever-app-lines';
import { useAppLauncherList } from '@/lib/app-launcher/use-app-launcher-list';
import { useWorkspaceScope } from '@/lib/hooks/use-workspace-scope';
import { serializeWorkspaceScope } from '@/lib/workspace-scope';
import { cn } from '@/lib/utils/cn';
import { Tooltip } from '@/components/ui/tooltip';
import { AppLauncherButton } from './AppLauncherButton';

/**
 * The App Launcher as a **left rail** (shared Ever shell, A3): a 3rem column
 * left of the sidebar, desktop only, one 32 px icon per app with a tooltip. The
 * current app carries a 4 px bar on its left edge and is not a link; every other
 * app opens in the same tab (owner, 2026-11-26), as a plain link, so
 * Ctrl/Cmd/middle-click still opens a new one; an app that is announced but has
 * no address yet ("Soon") is shown, dimmed, and opens nothing. Ever apps sit on
 * a white tile, as in the panel, and the group ends with a "+" that leads to
 * Ever Platform's page for adding your own apps (S7), when there is one.
 *
 * It shows the same list as the panel, in the same order — Pinned, Ever apps,
 * Your apps, each as the person arranged it in Manage apps (Show / Pin /
 * order) — because it reads the same registry through the same cache. The
 * launcher's own control sits at the foot of the rail, so the full panel (with
 * Manage apps) and the command palette's "Open App Launcher" keep working in
 * this position too.
 *
 * Mounted by the dashboard shell only when the person picked the rail AND the
 * viewport is desktop-wide: on phones the rail falls back to the sidebar mark.
 */

const SECTIONS = ['pinned', 'platforms', 'works'] as const;

const LOCAL_HTTP_HOSTNAMES = ['localhost', '127.0.0.1'];

/**
 * The panel's address rule (FR-32, `packages/app-launcher/src/safe-url.ts`),
 * restated here so the rail does not pull the Lit element into the first chunk:
 * `https` only, no credentials; plain `http` to localhost in development only.
 */
export function safeRailUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.username !== '' || url.password !== '') return null;
    if (url.protocol === 'https:') return value;
    if (url.protocol !== 'http:' || process.env.NODE_ENV !== 'development') return null;
    return LOCAL_HTTP_HOSTNAMES.includes(url.hostname) ? value : null;
}

function initialsOf(name: string): string {
    return name
        .split(/\s+/)
        .filter((part) => part.length > 0)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join('');
}

/** `platform:cal-diy` → `cal-diy`; anything else has no catalog entry. */
function catalogIdFromKey(key: string): string | undefined {
    return key.startsWith('platform:') ? key.slice('platform:'.length) : undefined;
}

/**
 * The white tile an Ever app's logo sits on, in both themes (S3): the Ever
 * Platform and Ever Demand marks are dark and would vanish on a dark rail.
 */
const LOGO_TILE = 'size-8 shrink-0 rounded-lg bg-white p-1 ring-1 ring-inset ring-black/10';

function AppIcon({ item }: { item: AppLauncherItem }) {
    if (item.iconDataUri) {
        return (
            // A data: URI drawn at 24 px on a 32 px tile; next/image adds nothing here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={item.iconDataUri}
                alt=""
                width={32}
                height={32}
                draggable={false}
                className={cn(
                    'size-8 shrink-0 rounded-lg object-contain',
                    item.kind === 'platform' && LOGO_TILE,
                )}
            />
        );
    }
    return (
        <span
            aria-hidden="true"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-xs font-medium text-text dark:bg-surface-secondary-dark dark:text-text-dark"
        >
            {initialsOf(item.name)}
        </span>
    );
}

const SLOT = 'relative flex size-10 items-center justify-center rounded-lg';

function RailItem({ item, position }: { item: AppLauncherItem; position: number }) {
    const t = useTranslations('dashboard.appLauncher');
    const pinned = item.pinned === true || item.section === 'pinned';

    if (item.current === true) {
        return (
            <Tooltip content={item.name} position="right">
                <span aria-current="page" className={SLOT} data-testid="app-launcher-rail-current">
                    <span
                        aria-hidden="true"
                        className="absolute -start-1 top-1/2 h-5 w-1 -translate-y-1/2 rounded-e-full bg-text dark:bg-text-dark"
                        data-testid="app-launcher-rail-current-bar"
                    />
                    <AppIcon item={item} />
                    <span className="sr-only">{t('railCurrentApp', { app: item.name })}</span>
                </span>
            </Tooltip>
        );
    }

    const url = item.status === 'soon' ? null : safeRailUrl(item.url);
    if (url === null) {
        const label = item.status === 'soon' ? t('railSoonApp', { app: item.name }) : item.name;
        return (
            <Tooltip content={label} position="right">
                <span
                    aria-disabled="true"
                    className={cn(SLOT, 'cursor-not-allowed opacity-50')}
                    data-testid="app-launcher-rail-inert"
                >
                    <AppIcon item={item} />
                    <span className="sr-only">{label}</span>
                </span>
            </Tooltip>
        );
    }

    const catalogId = item.kind === 'platform' ? catalogIdFromKey(item.key) : undefined;
    return (
        <Tooltip content={item.name} position="right">
            <a
                href={url}
                referrerPolicy="no-referrer"
                aria-label={item.name}
                className={cn(
                    SLOT,
                    'outline-none transition-colors hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-text/30',
                    'dark:hover:bg-surface-secondary-dark dark:focus-visible:ring-text-dark/30',
                )}
                onClick={() =>
                    captureAppLauncherEvent({
                        name: 'app_launcher_item_opened',
                        properties: {
                            item_kind: item.kind,
                            ...(catalogId === undefined ? {} : { catalog_id: catalogId }),
                            position,
                            pinned,
                        },
                    })
                }
            >
                <AppIcon item={item} />
            </a>
        </Tooltip>
    );
}

/** S7's "+": the last slot of the Ever apps group, a same-tab link to Ever Platform's Apps page. */
function AddAppItem({ href }: { href: string }) {
    const t = useTranslations('dashboard.appLauncher');
    const label = t('addAppLabel');
    return (
        <Tooltip content={label} position="right">
            <a
                href={href}
                referrerPolicy="no-referrer"
                aria-label={label}
                data-testid="app-launcher-rail-add"
                className={cn(
                    SLOT,
                    'outline-none transition-colors hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-text/30',
                    'dark:hover:bg-surface-secondary-dark dark:focus-visible:ring-text-dark/30',
                )}
            >
                <span
                    aria-hidden="true"
                    className={cn(
                        LOGO_TILE,
                        'inline-flex items-center justify-center text-zinc-600',
                    )}
                >
                    <Plus className="size-4" strokeWidth={1.5} />
                </span>
            </a>
        </Tooltip>
    );
}

export function AppLauncherRail() {
    const t = useTranslations('dashboard.appLauncher');
    const scope = useWorkspaceScope();
    const scopeKey = scope === null ? null : serializeWorkspaceScope(scope);
    const { data, loading } = useAppLauncherList(scopeKey);
    const addAppUrl = addAppUrlFrom(data);

    const groups = SECTIONS.map((section) =>
        (data?.items ?? []).filter((item) => item.visible !== false && item.section === section),
    ).filter((items) => items.length > 0);
    // Positions count across the groups, the way the panel's grid counts its tiles.
    const offsets = groups.map((_, index) =>
        groups.slice(0, index).reduce((sum, items) => sum + items.length, 0),
    );

    return (
        <nav
            aria-label={t('railLabel')}
            data-testid="app-launcher-rail"
            className="flex h-full w-12 shrink-0 flex-col items-center border-e border-border bg-white py-3 dark:border-border-dark dark:bg-surface-dark"
        >
            <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
                {data === null && loading
                    ? Array.from({ length: 4 }, (_, index) => (
                          <span
                              key={index}
                              aria-hidden="true"
                              className="m-1 size-8 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark"
                          />
                      ))
                    : groups.map((items, groupIndex) => (
                          // The list spans the column, so the current app's bar sits at
                          // the column's edge instead of being clipped by the scroller.
                          <Fragment key={items[0].section}>
                              {groupIndex > 0 && (
                                  <span
                                      aria-hidden="true"
                                      className="h-px w-6 shrink-0 bg-border dark:bg-border-dark"
                                  />
                              )}
                              <ul className="flex w-full flex-col items-center gap-1">
                                  {items.map((item, index) => (
                                      <li key={item.key} className="flex w-full justify-center">
                                          <RailItem
                                              item={item}
                                              position={offsets[groupIndex] + index}
                                          />
                                      </li>
                                  ))}
                                  {items[0].section === 'platforms' && addAppUrl !== null && (
                                      <li className="flex w-full justify-center">
                                          <AddAppItem href={addAppUrl} />
                                      </li>
                                  )}
                              </ul>
                          </Fragment>
                      ))}
            </div>
            <div className="pt-2">
                <AppLauncherButton variant="rail" />
            </div>
        </nav>
    );
}
