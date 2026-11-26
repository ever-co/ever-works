import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppLauncherItem, AppLauncherListResponse } from '@ever-works/contracts';

/**
 * Shared Ever shell, A3 — the left rail: one icon per app, in the panel's
 * order (Pinned, Ever apps, Your apps, as arranged in Manage apps), the current
 * app marked and not a link, a "Soon" app shown and inert, the others opening
 * in a new tab with no opener and no referrer. The launcher's own control sits
 * at its foot.
 */

const captureMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        values && 'app' in values
            ? `${namespace}.${key}:${String(values.app)}`
            : `${namespace}.${key}`,
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/org/acme/dashboard' }));

vi.mock('@/lib/app-launcher/app-launcher-telemetry', () => ({
    captureAppLauncherEvent: captureMock,
}));

// The control at the foot of the rail has its own spec.
vi.mock('./AppLauncherButton', () => ({
    AppLauncherButton: ({ variant }: { variant?: string }) => (
        <div data-testid="app-launcher-control" data-variant={variant} />
    ),
}));

import { AppLauncherRail } from './AppLauncherRail';
import { resetAppLauncherCache } from '@/lib/app-launcher/app-launcher-cache';

function item(partial: Partial<AppLauncherItem> & { key: string; name: string }): AppLauncherItem {
    return {
        kind: 'platform',
        section: 'platforms',
        url: `https://${partial.key.replace(/[^a-z]/g, '')}.example.com`,
        host: 'example.com',
        status: 'available',
        visible: true,
        pinned: false,
        pinOrder: null,
        order: 0,
        manageState: 'listed',
        ...partial,
    };
}

const LIST: AppLauncherListResponse = {
    items: [
        item({
            key: 'work:cal',
            name: 'Cal',
            kind: 'work',
            section: 'pinned',
            pinned: true,
            pinOrder: 0,
        }),
        item({ key: 'platform:app-ever-co', name: 'Ever Platform' }),
        item({ key: 'platform:ever-works', name: 'Ever Works', current: true }),
        item({ key: 'platform:ever-teams', name: 'Ever Teams', status: 'beta' }),
        item({ key: 'platform:ever-demand', name: 'Ever Demand', status: 'soon' }),
        item({ key: 'platform:hidden', name: 'Hidden', visible: false }),
        item({ key: 'work:docs', name: 'Docs', kind: 'work', section: 'works' }),
    ],
    meta: {
        environment: 'production',
        catalogVersion: '0.2.0',
        catalogAvailable: true,
        scopeKey: 'org:acme',
        worksTotal: 2,
        total: 7,
        truncated: false,
        pinLimit: 6,
        appWorksAvailable: true,
    },
};

beforeEach(() => {
    resetAppLauncherCache();
    captureMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => LIST });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/org/acme/dashboard');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('AppLauncherRail', () => {
    it('reads the list once and draws every visible app in the panel order', async () => {
        render(<AppLauncherRail />);
        const rail = screen.getByTestId('app-launcher-rail');
        expect(rail).toHaveAttribute('aria-label', 'dashboard.appLauncher.railLabel');

        await waitFor(() => expect(within(rail).getAllByRole('list')).toHaveLength(3));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const names = within(rail)
            .getAllByRole('listitem')
            .map((row) => row.textContent || row.querySelector('a')?.getAttribute('aria-label'));
        // Six apps, and the Ever apps group's "+" (S7).
        expect(names).toHaveLength(7);
        expect(screen.queryByText('Hidden')).toBeNull();
        // The launcher's own control sits at the foot.
        expect(screen.getByTestId('app-launcher-control')).toHaveAttribute('data-variant', 'rail');
    });

    it('marks the current app, which is not a link', async () => {
        render(<AppLauncherRail />);
        const current = await screen.findByTestId('app-launcher-rail-current');
        expect(current).toHaveAttribute('aria-current', 'page');
        // The 4 px bar on the current app's left edge (A3).
        expect(within(current).getByTestId('app-launcher-rail-current-bar')).toBeInTheDocument();
        expect(current.closest('a')).toBeNull();
        expect(current).toHaveTextContent('dashboard.appLauncher.railCurrentApp:Ever Works');
    });

    it('shows a Soon app dimmed and inert', async () => {
        render(<AppLauncherRail />);
        await screen.findByTestId('app-launcher-rail-current');
        const inert = screen.getAllByTestId('app-launcher-rail-inert');
        expect(inert).toHaveLength(1);
        expect(inert[0]).toHaveAttribute('aria-disabled', 'true');
        expect(inert[0]).toHaveTextContent('dashboard.appLauncher.railSoonApp:Ever Demand');
        expect(inert[0].closest('a')).toBeNull();
    });

    it('opens the others in the same tab with no referrer, and reports no address', async () => {
        render(<AppLauncherRail />);
        const link = await screen.findByRole('link', { name: 'Ever Platform' });
        // Same tab (owner, 2026-11-26): a plain link, so Ctrl/Cmd/middle-click still opens a new one.
        expect(link).not.toHaveAttribute('target');
        expect(link).not.toHaveAttribute('rel');
        expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
        for (const anchor of screen.getAllByRole('link')) {
            expect(anchor).not.toHaveAttribute('target');
        }

        fireEvent.click(link);
        expect(captureMock).toHaveBeenCalledWith({
            name: 'app_launcher_item_opened',
            properties: {
                item_kind: 'platform',
                catalog_id: 'app-ever-co',
                position: 1,
                pinned: false,
            },
        });
        expect(JSON.stringify(captureMock.mock.calls)).not.toContain('example.com');
    });

    it('ends the Ever apps group with "+", a same-tab link to Ever Platform’s Apps page (S7)', async () => {
        render(<AppLauncherRail />);
        const add = await screen.findByTestId('app-launcher-rail-add');
        expect(add).toHaveAttribute('href', 'https://platformappeverco.example.com/apps?add=app');
        expect(add).toHaveAttribute('aria-label', 'dashboard.appLauncher.addAppLabel');
        expect(add).not.toHaveAttribute('target');
        // The last slot of the Ever apps list, before Your apps.
        const lists = screen.getAllByRole('list');
        expect(lists[1].lastElementChild).toContainElement(add);
    });

    it('draws no "+" when the list has no Ever Platform address', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                ...LIST,
                items: LIST.items.filter((entry) => entry.key !== 'platform:app-ever-co'),
            }),
        });
        render(<AppLauncherRail />);
        await screen.findByTestId('app-launcher-rail-current');
        expect(screen.queryByTestId('app-launcher-rail-add')).toBeNull();
    });

    it('never links an address the panel would refuse', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                ...LIST,
                items: [item({ key: 'platform:bad', name: 'Bad', url: 'javascript:alert(1)' })],
            }),
        });
        render(<AppLauncherRail />);
        const inert = await screen.findByTestId('app-launcher-rail-inert');
        expect(inert.closest('a')).toBeNull();
        expect(screen.queryByRole('link')).toBeNull();
    });
});
