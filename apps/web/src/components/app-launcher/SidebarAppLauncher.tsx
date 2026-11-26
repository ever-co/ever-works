'use client';

import { useAppLauncherPlacement } from '@/lib/app-launcher/placement';
import { useIsDesktop } from '@/lib/hooks/use-media-query';
import { AppLauncherButton } from './AppLauncherButton';
import { EverMark } from './EverMark';

/**
 * The Ever mark at the top of the sidebar, left of the organization switcher
 * (shared Ever shell, A2). It always turns slowly; it is the App Launcher's
 * button when the launcher sits in the sidebar — and on phones when the person
 * picked the left rail, which phones do not draw. In the other positions it is
 * a plain mark, and it never navigates home (Home is the first sidebar item).
 */
export function SidebarAppLauncher({
    launcherEnabled,
    isCollapsed = false,
}: {
    launcherEnabled: boolean;
    isCollapsed?: boolean;
}) {
    const placement = useAppLauncherPlacement();
    const isDesktop = useIsDesktop();
    const opensLauncher =
        launcherEnabled && (placement === 'sidebar' || (placement === 'rail' && !isDesktop));

    if (opensLauncher) {
        return (
            <AppLauncherButton
                variant="sidebar"
                panelPosition={isCollapsed ? 'right-start' : 'bottom-start'}
            />
        );
    }
    return (
        <span
            className="inline-flex size-8 shrink-0 items-center justify-center"
            data-testid="sidebar-ever-mark"
        >
            <EverMark className="size-5" />
        </span>
    );
}

/** Whether the shell draws the left rail: the person picked it, and the viewport is desktop-wide. */
export function useShowsAppLauncherRail(launcherEnabled: boolean): boolean {
    const placement = useAppLauncherPlacement();
    const isDesktop = useIsDesktop();
    return launcherEnabled && placement === 'rail' && isDesktop;
}

/** Whether the top bar draws the launcher's control. */
export function useShowsHeaderAppLauncher(launcherEnabled: boolean): boolean {
    const placement = useAppLauncherPlacement();
    return launcherEnabled && placement === 'header';
}
