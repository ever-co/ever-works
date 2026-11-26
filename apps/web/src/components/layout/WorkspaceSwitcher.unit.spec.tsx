import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { OrganizationResponse } from '@ever-works/contracts/api';

// next-intl — return the key path verbatim so assertions can match
// against the namespaced keys (we don't care about translated copy
// here, only structure).
vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

// next/navigation — `useParams()` returns the URL slug. We mock it
// per-test via `paramsMock`.
const pathnameMock = vi.fn<() => string>();
pathnameMock.mockReturnValue('/dashboard');
vi.mock('next/navigation', () => ({
    usePathname: () => pathnameMock(),
}));

// i18n navigation — `useRouter().push()` for the switch-on-click flow.
const routerPushMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, ...rest }: { children: React.ReactNode; href: string }) => (
        <a {...rest}>{children}</a>
    ),
    useRouter: () => ({ push: routerPushMock }),
}));

const { navigateToWorkspaceDashboardMock } = vi.hoisted(() => ({
    navigateToWorkspaceDashboardMock: vi.fn(),
}));
vi.mock('@/lib/workspace-navigation', () => ({
    navigateToWorkspaceDashboard: navigateToWorkspaceDashboardMock,
}));

// Mock the image-only logo variants to simple sentinels — we don't want
// to render real Next.js Image components in jsdom, and we want stable
// test selectors for the empty-state assertion.
vi.mock('../logos', () => ({
    LogoEverWorkImage: () => <span data-testid="logo-everwork-image">LogoEverWork</span>,
    FaviconEverWorkImage: () => <span data-testid="favicon-everwork-image">FaviconEverWork</span>,
}));

// `CreateOrganizationModal` pulls in next/image and the full org create
// flow — stub it to a noop so the trigger renders without exploding.
vi.mock('../organizations/CreateOrganizationModal', () => ({
    CreateOrganizationModal: ({ open }: { open: boolean }) =>
        open ? <div data-testid="create-organization-modal" /> : null,
}));

import { plateColor, plateHue, WorkspaceSwitcher } from './WorkspaceSwitcher';

/** `hsl(h s% l%)` → [r, g, b] in 0..255. */
function hslToRgb(css: string): [number, number, number] {
    const [h, sPct, lPct] = css.match(/[\d.]+/g)!.map(Number);
    const sat = sPct / 100;
    const light = lPct / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
}

function hslToCss(hue: number): string {
    const [r, g, b] = hslToRgb(plateColor(hue));
    return `rgb(${r}, ${g}, ${b})`;
}

/** WCAG contrast of white text on the colour. */
function contrastWithWhite(css: string): number {
    const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = hslToRgb(css);
    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return 1.05 / (luminance + 0.05);
}
import {
    __resetOrganizationsStoreForTests,
    __seedOrganizationsStoreForTests,
} from '@/lib/hooks/use-organizations';

function makeOrg(overrides: Partial<OrganizationResponse> = {}): OrganizationResponse {
    return {
        id: `o-${Math.random().toString(36).slice(2, 8)}`,
        tenantId: 't-1',
        slug: 'acme',
        legalName: null,
        displayName: 'Acme Inc',
        countryCode: null,
        registrationProvider: null,
        registrationStatus: null,
        linkedWorkId: null,
        vision: null,
        visionUpdatedAt: null,
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        ...overrides,
    };
}

describe('WorkspaceSwitcher — EW-660 Phase 8', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        routerPushMock.mockReset();
        navigateToWorkspaceDashboardMock.mockReset();
        pathnameMock.mockReset().mockReturnValue('/dashboard');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    tenantId: 't-1',
                    organizationId: null,
                    organizationSlug: null,
                }),
            }),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    /**
     * Empty state (shared Ever shell, A2): with zero orgs the trigger reads
     * "Create organization" and opens the create dialog directly — no menu
     * holding a single row. The Ever mark beside the switcher is the sidebar's
     * logo, so the trigger draws neither the favicon nor the wordmark.
     */
    it('reads "Create organization" and opens the create dialog when the user has zero organizations', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });

        render(<WorkspaceSwitcher />);

        expect(screen.queryByTestId('favicon-everwork-image')).toBeNull();
        expect(screen.queryByTestId('logo-everwork-image')).toBeNull();
        const trigger = screen.getByTestId('workspace-switcher-create');
        expect(trigger).toHaveTextContent('organizations.switcher.createNew');
        expect(screen.queryByTestId('create-organization-modal')).toBeNull();
        fireEvent.click(trigger);
        expect(screen.getByTestId('create-organization-modal')).toBeInTheDocument();
    });

    /**
     * A failed read is not "no Organization": the person keeps the menu (with
     * the create row), instead of a lone "Create organization" that would hide
     * the Organizations they have.
     */
    it('keeps the menu when the Organizations read failed', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: new Error('503') });

        render(<WorkspaceSwitcher />);

        expect(screen.queryByTestId('workspace-switcher-create')).toBeNull();
        const trigger = screen.getAllByRole('button')[0];
        expect(trigger).toHaveTextContent('organizations.switcher.heading');
        fireEvent.click(trigger);
        expect(screen.getByText('organizations.switcher.addNew')).toBeInTheDocument();
    });

    /**
     * Empty state popover: opening the trigger surfaces the
     * "Create Organization" row even when no orgs exist.
     */
    it('shows "Create Organization" in the popover when zero orgs', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });

        render(<WorkspaceSwitcher />);
        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);

        expect(screen.getByText('organizations.switcher.createNew')).toBeInTheDocument();
    });

    /**
     * Active state with 1 org: the trigger swaps the EverWorks favicon
     * for the org's initial-letter avatar and shows the org's display
     * name (no wordmark) + chevron. The favicon stays in the empty
     * state only.
     */
    it('renders org avatar + org name + trigger when the user has 1 organization', () => {
        const org = makeOrg({ displayName: 'Acme Inc', slug: 'acme' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        // Brand favicon is replaced by the org avatar in the trigger.
        expect(screen.queryByTestId('favicon-everwork-image')).toBeNull();
        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        // Wordmark is replaced by the active-org label.
        expect(screen.queryByTestId('logo-everwork-image')).toBeNull();
    });

    /**
     * 3 orgs — when the popover opens, all three list rows are
     * present plus the "Create Organization" footer row.
     */
    it('renders all 3 orgs in the popover list when the user has 3 organizations', () => {
        const orgs = [
            makeOrg({ id: 'o-1', slug: 'acme', displayName: 'Acme Inc' }),
            makeOrg({ id: 'o-2', slug: 'globex', displayName: 'Globex LLC' }),
            makeOrg({ id: 'o-3', slug: 'initech', displayName: 'Initech' }),
        ];
        __seedOrganizationsStoreForTests({
            data: orgs,
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);
        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);

        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Globex LLC').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Initech').length).toBeGreaterThanOrEqual(1);

        expect(screen.getByText('organizations.switcher.addNew')).toBeInTheDocument();
    });

    /**
     * Falls back to the org's slug when `displayName` is null — slug is
     * NOT NULL on the DB row, so this is the right fallback shape.
     */
    it('in the only Organization: name, address line, tile, "No other organization" and "Add organization" (A2)', () => {
        pathnameMock.mockReturnValue('/org/acme-robotics/dashboard');
        __seedOrganizationsStoreForTests({
            data: [makeOrg({ id: 'o-1', slug: 'acme-robotics', displayName: 'Acme Robotics' })],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        expect(screen.getByText('Acme Robotics')).toBeInTheDocument();
        expect(screen.getByTestId('workspace-switcher-address')).toHaveTextContent('acme-robotics');
        expect(screen.getAllByTestId('org-avatar')[0].style.backgroundColor).toBe(
            // jsdom serialises hsl() as rgb()
            hslToCss(plateHue('Acme Robotics')),
        );
        fireEvent.click(screen.getAllByRole('button')[0]);
        expect(screen.getByText('organizations.switcher.label')).toBeInTheDocument();
        expect(screen.getByText('organizations.switcher.noOther')).toBeInTheDocument();
        expect(screen.getByText('organizations.switcher.addNew')).toBeInTheDocument();
    });

    it('on a personal page, offers the Organization to switch to and claims no address or "No other"', () => {
        pathnameMock.mockReturnValue('/dashboard');
        __seedOrganizationsStoreForTests({
            data: [makeOrg({ id: 'o-1', slug: 'acme-robotics', displayName: 'Acme Robotics' })],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        expect(screen.queryByTestId('workspace-switcher-address')).toBeNull();
        fireEvent.click(screen.getAllByRole('button')[0]);
        expect(screen.queryByText('organizations.switcher.noOther')).toBeNull();
    });

    it('derives the same tile colour from the same name, readable for every hue (white text, 4.5:1)', () => {
        expect(plateHue('Acme Robotics')).toBe(plateHue('Acme Robotics'));
        expect(plateHue('Acme Robotics')).not.toBe(plateHue('Northwind Labs'));
        for (let hue = 0; hue < 360; hue += 1) {
            expect(contrastWithWhite(plateColor(hue)), `hue ${hue}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('uses the org slug as the trigger label when displayName is null', () => {
        const org = makeOrg({ displayName: null, slug: 'fallback-org' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        expect(screen.getAllByText('fallback-org').length).toBeGreaterThanOrEqual(1);
    });

    /**
     * Collapsed variant — empty state: an icon-only "+" button whose
     * accessible name is "Create organization", opening the create dialog.
     */
    it('renders an icon-only create button with an accessible name when isCollapsed (empty state)', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });

        render(<WorkspaceSwitcher isCollapsed />);

        expect(screen.queryByTestId('favicon-everwork-image')).toBeNull();
        const trigger = screen.getByRole('button', { name: 'organizations.switcher.createNew' });
        expect(trigger).not.toHaveTextContent('organizations.switcher.createNew');
        fireEvent.click(trigger);
        expect(screen.getByTestId('create-organization-modal')).toBeInTheDocument();
    });

    /**
     * Collapsed variant — active org: the favicon is swapped for the
     * org-initial avatar; the wordmark and the inline org-name label
     * are both suppressed (collapsed = icon-only). Clicking still
     * opens the popover listing the org and the create row.
     */
    it('renders the org-initial avatar and no label/wordmark when isCollapsed + active org', () => {
        const org = makeOrg({ displayName: 'Acme Inc', slug: 'acme' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher isCollapsed />);

        // Active-org icon = OrgAvatar — favicon and wordmark both absent.
        expect(screen.queryByTestId('favicon-everwork-image')).toBeNull();
        expect(screen.queryByTestId('logo-everwork-image')).toBeNull();
        // The closed trigger has no inline label either.
        expect(screen.queryByText('Acme Inc')).toBeNull();

        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);
        // After opening, the org list row + create row both show.
        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText('organizations.switcher.addNew')).toBeInTheDocument();
    });

    it('persists from the current tab scope before navigating to the canonical dashboard', async () => {
        const yo = makeOrg({ id: 'o-yo', slug: 'yo-inc', displayName: 'Yo Incorporated' });
        const ever = makeOrg({ id: 'o-ever', slug: 'ever', displayName: 'Ever' });
        __seedOrganizationsStoreForTests({
            data: [yo, ever],
            isLoading: false,
            error: null,
        });

        let resolveSwitch!: (response: unknown) => void;
        const switchResponse = new Promise((resolve) => {
            resolveSwitch = resolve;
        });
        const fetchMock = vi.mocked(fetch);
        window.history.replaceState({}, '', '/org/yo-inc/dashboard');
        fetchMock.mockImplementation((_input, init) => {
            if (init?.method === 'POST') {
                return switchResponse as Promise<Response>;
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({
                    tenantId: 't-1',
                    organizationId: 'o-yo',
                    organizationSlug: 'yo-inc',
                }),
            } as Response);
        });

        render(<WorkspaceSwitcher />);
        fireEvent.click(screen.getAllByRole('button')[0]);
        fireEvent.click(screen.getByText('Ever'));

        expect(fetchMock).toHaveBeenCalledWith(
            '/api/users/me/scope',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ organizationSlug: 'ever' }),
            }),
        );
        const switchHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
        expect(switchHeaders.get('x-ever-workspace')).toBe('org:yo-inc');
        expect(navigateToWorkspaceDashboardMock).not.toHaveBeenCalled();

        resolveSwitch({
            ok: true,
            status: 200,
            json: async () => ({
                tenantId: 't-1',
                organizationId: 'o-ever',
                organizationSlug: 'ever',
            }),
        });

        await waitFor(() =>
            expect(navigateToWorkspaceDashboardMock).toHaveBeenCalledWith({
                kind: 'organization',
                slug: 'ever',
            }),
        );
        expect(routerPushMock).not.toHaveBeenCalled();
    });
});
