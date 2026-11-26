'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, Check, ChevronsUpDown, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useOrganizations } from '@/lib/hooks/use-organizations';
import { useActiveScope } from '@/lib/hooks/use-active-scope';
import { CreateOrganizationModal } from '../organizations/CreateOrganizationModal';
import type { WorkConfig } from '@/lib/api';
import type { OrganizationResponse } from '@ever-works/contracts/api';
import { browserApiFetch } from '@/lib/api/browser-api';
import { navigateToWorkspaceDashboard } from '@/lib/workspace-navigation';

interface WorkspaceSwitcherProps {
    /**
     * Site config. Kept for callers: the trigger no longer draws the favicon or
     * the wordmark — the Ever mark beside it is the sidebar's one logo (A2).
     */
    config?: WorkConfig | null;
    /** Kept for callers; the wordmark it styled is gone (see `config`). */
    logoClassName?: string;
    /**
     * Collapsed sidebar variant — renders only the icon trigger (no
     * label, no chevron). The popover behaviour is identical.
     */
    isCollapsed?: boolean;
}

function pickInitial(org: OrganizationResponse): string {
    const source = org.displayName ?? org.slug ?? '';
    return source.charAt(0).toUpperCase() || '?';
}

function pickLabel(org: OrganizationResponse): string {
    return org.displayName ?? org.slug;
}

/**
 * Avatar circle for an Organization. Mimics shadcn `sidebar-07`
 * TeamSwitcher's visual: a colored square with the first initial.
 * `Building2` is used as a fallback when the initial would be empty.
 */
function OrgAvatar({ org, size = 'sm' }: { org: OrganizationResponse; size?: 'sm' | 'xs' | 'md' }) {
    const initial = pickInitial(org);
    const sizeClass =
        size === 'md'
            ? 'w-6 h-6 text-[11px]'
            : size === 'sm'
              ? 'w-7 h-7 text-xs'
              : 'w-5 h-5 text-[10px]';
    return (
        <div
            className={cn(
                'shrink-0 inline-flex items-center justify-center rounded-md',
                'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                'text-text dark:text-text-dark',
                'font-semibold',
                sizeClass,
            )}
            aria-hidden="true"
        >
            {initial || <Building2 className="w-3.5 h-3.5" strokeWidth={1.5} />}
        </div>
    );
}

/**
 * EW-660 (Tenants & Organizations Phase 8) — top-of-sidebar component
 * showing the spinning favicon + the active Organization (or the
 * Ever Works wordmark when the user has zero Orgs) with a popover to
 * switch between Orgs or create a new one.
 *
 * The whole row is a single dropdown trigger:
 *
 *   [favicon OR org avatar] [label] [chevron]
 *
 * The trigger renders in every state (including zero-org), so the user
 * can always reach "+ Create Organization" — pre-fix, the zero-org
 * branch fell back to a bare logo with no popover and clicking it did
 * nothing useful.
 *
 * When `isCollapsed`, the trigger renders just the leading icon — the
 * label + chevron are hidden and the dropdown still opens on click.
 * That replaces the pre-fix collapsed-sidebar `<FaviconEverWork>`,
 * which wrapped the favicon in a `<Link>` pointing at the configured
 * site URL (localhost:3000 in dev) and silently swallowed clicks
 * instead of opening the org switcher.
 */
export function WorkspaceSwitcher({ isCollapsed = false }: WorkspaceSwitcherProps) {
    const t = useTranslations('organizations.switcher');
    const { organizations, isLoading } = useOrganizations();
    const { activeOrganization } = useActiveScope();
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [pendingOrganizationSlug, setPendingOrganizationSlug] = useState<string | null>(null);

    const hasOrgs = organizations.length > 0;
    // Pick the trigger label org — use the active one (from URL slug) if
    // resolved, otherwise fall back to the first org so the chip never
    // shows up empty when orgs exist.
    const triggerOrg: OrganizationResponse | null = hasOrgs
        ? (activeOrganization ?? organizations[0])
        : null;

    const handleSelectOrg = async (org: OrganizationResponse) => {
        if (pendingOrganizationSlug !== null) return;

        setPendingOrganizationSlug(org.slug);
        try {
            const response = await browserApiFetch('/api/users/me/scope', {
                method: 'POST',
                credentials: 'include',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationSlug: org.slug }),
            });
            if (!response.ok) {
                throw new Error(`Failed to persist active Organization (${response.status})`);
            }
            const persisted = (await response.json()) as { organizationSlug?: string | null };
            if (persisted.organizationSlug !== org.slug) {
                throw new Error('The persisted active Organization did not match the selection');
            }
            navigateToWorkspaceDashboard({ kind: 'organization', slug: org.slug });
        } catch {
            toast.error(t('switchFailed'));
        } finally {
            setPendingOrganizationSlug(null);
        }
    };

    const handleCreateOrg = () => {
        setIsCreateOpen(true);
    };

    // Shared Ever shell, A2: with no Organization yet the trigger IS the way
    // to make one — it reads "Create organization" and opens the create dialog
    // directly, instead of a menu holding a single entry. (The Ever mark beside
    // the switcher is the sidebar's logo, so the trigger no longer draws one.)
    if (!hasOrgs && !isLoading) {
        return (
            <>
                <button
                    type="button"
                    onClick={handleCreateOrg}
                    aria-label={isCollapsed ? t('createNew') : undefined}
                    data-testid="workspace-switcher-create"
                    className={cn(
                        'flex items-center gap-1.5 rounded-md transition-colors cursor-pointer',
                        'text-sm font-medium text-text dark:text-text-dark',
                        'hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                        isCollapsed ? 'justify-center p-1' : 'w-full px-1.5 py-1',
                    )}
                >
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border-secondary dark:border-border-secondary-dark">
                        <Plus
                            className="size-4 text-text-muted dark:text-text-muted-dark"
                            strokeWidth={1.5}
                            aria-hidden="true"
                        />
                    </span>
                    {!isCollapsed && (
                        <span className="min-w-0 flex-1 truncate text-left">{t('createNew')}</span>
                    )}
                </button>
                <CreateOrganizationModal open={isCreateOpen} onOpenChange={setIsCreateOpen} />
            </>
        );
    }

    // Leading icon: the active Organization's tile. While the list loads, a
    // quiet placeholder of the same 24 px, so the row does not shift.
    const leadingIcon = triggerOrg ? (
        <OrgAvatar org={triggerOrg} size="md" />
    ) : (
        <span
            aria-hidden="true"
            className="size-6 shrink-0 rounded-md bg-surface-tertiary dark:bg-surface-tertiary-dark"
        />
    );

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger
                    className={cn(
                        'rounded-md transition-colors cursor-pointer',
                        'focus:outline-none focus-visible:outline-none',
                        'hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark',
                        // Collapsed: fill the column and center the icon so it
                        // sits in the same x position as the "+ New" button
                        // beneath it. Expanded keeps the chip layout.
                        isCollapsed ? 'flex justify-center p-1' : 'w-full px-1.5 py-1',
                    )}
                    aria-label={t('heading')}
                >
                    <div
                        className={cn(
                            'flex items-center min-w-0',
                            isCollapsed ? 'justify-center' : 'gap-1.5 w-full',
                        )}
                    >
                        {leadingIcon}
                        {!isCollapsed && (
                            <span className="flex-1 min-w-0 text-left text-sm font-medium text-text dark:text-text-dark truncate">
                                {triggerOrg ? pickLabel(triggerOrg) : t('loading')}
                            </span>
                        )}
                        {!isCollapsed && (
                            <ChevronsUpDown
                                className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                strokeWidth={1.5}
                                aria-hidden="true"
                            />
                        )}
                    </div>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" className="w-60">
                    <DropdownMenuLabel>{t('heading')}</DropdownMenuLabel>
                    {hasOrgs &&
                        organizations.map((org) => {
                            const isActive = activeOrganization?.id === org.id;
                            return (
                                <DropdownMenuItem
                                    key={org.id}
                                    onClick={() => handleSelectOrg(org)}
                                    className="cursor-pointer"
                                    disabled={pendingOrganizationSlug !== null}
                                >
                                    <div className="flex items-center gap-2 w-full">
                                        <OrgAvatar org={org} size="xs" />
                                        <span className="flex-1 min-w-0 truncate text-text dark:text-text-dark">
                                            {pickLabel(org)}
                                        </span>
                                        {isActive && (
                                            <Check
                                                className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                                strokeWidth={1.5}
                                                aria-label={t('active')}
                                            />
                                        )}
                                    </div>
                                </DropdownMenuItem>
                            );
                        })}
                    {hasOrgs && <DropdownMenuSeparator />}
                    {isLoading && !hasOrgs && (
                        <DropdownMenuItem disabled className="text-text-muted">
                            {t('loading')}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={handleCreateOrg} className="cursor-pointer">
                        <div className="flex items-center gap-2 w-full">
                            <span className="w-5 h-5 inline-flex items-center justify-center shrink-0">
                                <Plus
                                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                    strokeWidth={1.5}
                                />
                            </span>
                            <span className="flex-1 min-w-0 truncate text-text dark:text-text-dark">
                                {t('createNew')}
                            </span>
                        </div>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <CreateOrganizationModal open={isCreateOpen} onOpenChange={setIsCreateOpen} />
        </>
    );
}
