import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';

/**
 * Shared Ever shell, A2/A3 — the Ever mark at the top of the sidebar opens the
 * App Launcher when the person keeps it in the sidebar, and on phones when they
 * picked the left rail (phones draw no rail). Otherwise it is a plain mark: the
 * top bar or the rail carries the launcher instead.
 */

vi.mock('./AppLauncherButton', () => ({
    AppLauncherButton: ({
        variant,
        panelPosition,
    }: {
        variant?: string;
        panelPosition?: string;
    }) => (
        <div
            data-testid="app-launcher-control"
            data-variant={variant}
            data-panel-position={panelPosition}
        />
    ),
}));

import {
    SidebarAppLauncher,
    useShowsAppLauncherRail,
    useShowsHeaderAppLauncher,
} from './SidebarAppLauncher';

function setDesktop(isDesktop: boolean) {
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            matches: isDesktop && query === '(min-width: 1024px)',
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
}

function setPlacement(value: string | null) {
    if (value === null) window.localStorage.removeItem('app-switcher-placement');
    else window.localStorage.setItem('app-switcher-placement', JSON.stringify(value));
}

beforeEach(() => {
    window.localStorage.clear();
    setDesktop(true);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('SidebarAppLauncher', () => {
    it('is the launcher by default (sidebar), opening below-left', () => {
        render(<SidebarAppLauncher launcherEnabled />);
        const control = screen.getByTestId('app-launcher-control');
        expect(control).toHaveAttribute('data-variant', 'sidebar');
        expect(control).toHaveAttribute('data-panel-position', 'bottom-start');
    });

    it('opens to the right when the sidebar is collapsed to icons', () => {
        render(<SidebarAppLauncher launcherEnabled isCollapsed />);
        expect(screen.getByTestId('app-launcher-control')).toHaveAttribute(
            'data-panel-position',
            'right-start',
        );
    });

    it('is a plain mark when the launcher sits in the top bar', () => {
        setPlacement('header');
        render(<SidebarAppLauncher launcherEnabled />);
        expect(screen.queryByTestId('app-launcher-control')).toBeNull();
        expect(screen.getByTestId('sidebar-ever-mark')).toBeInTheDocument();
    });

    it('is a plain mark beside the rail on desktop, and the launcher on phones', () => {
        setPlacement('rail');
        const { unmount } = render(<SidebarAppLauncher launcherEnabled />);
        expect(screen.queryByTestId('app-launcher-control')).toBeNull();
        unmount();

        setDesktop(false);
        render(<SidebarAppLauncher launcherEnabled />);
        expect(screen.getByTestId('app-launcher-control')).toHaveAttribute(
            'data-variant',
            'sidebar',
        );
    });

    it('is a plain mark when the installation has no launcher', () => {
        render(<SidebarAppLauncher launcherEnabled={false} />);
        expect(screen.queryByTestId('app-launcher-control')).toBeNull();
        expect(screen.getByTestId('ever-mark')).toBeInTheDocument();
    });
});

describe('where the shell draws the launcher', () => {
    it('draws the rail only for the rail choice on a desktop-wide viewport', () => {
        setPlacement('rail');
        expect(renderHook(() => useShowsAppLauncherRail(true)).result.current).toBe(true);
        expect(renderHook(() => useShowsAppLauncherRail(false)).result.current).toBe(false);
        setDesktop(false);
        expect(renderHook(() => useShowsAppLauncherRail(true)).result.current).toBe(false);
    });

    it('draws the top bar control only for the top bar choice', () => {
        expect(renderHook(() => useShowsHeaderAppLauncher(true)).result.current).toBe(false);
        setPlacement('header');
        expect(renderHook(() => useShowsHeaderAppLauncher(true)).result.current).toBe(true);
        expect(renderHook(() => useShowsHeaderAppLauncher(false)).result.current).toBe(false);
    });
});
