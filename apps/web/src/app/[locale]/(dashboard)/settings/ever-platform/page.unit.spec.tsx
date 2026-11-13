import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Settings → Ever Platform, the page: which sections it shows for what the API
 * answers, and what it asks.
 *
 * The API clients run for real over a stand-in `serverFetch`, so the requests
 * counted here are the page's own. Pinned:
 *
 * - with every switch off the page answers 404 and neither lists the person's
 *   Organizations nor asks for a link;
 * - an Organization's link is asked only where linking can be switched on (a
 *   platform admin's status says so, or the person is not a platform admin on a
 *   deployment that has the module);
 * - a failure while loading the link section hides that section ONLY: the
 *   other sections of the page still render.
 */
const { ApiResponseError, serverFetch, listOrganizations, notFound } = vi.hoisted(() => {
    class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
        ) {
            super(message);
        }
    }
    return {
        ApiResponseError,
        serverFetch: vi.fn(),
        listOrganizations: vi.fn(),
        notFound: vi.fn(() => {
            throw new Error('NEXT_NOT_FOUND');
        }),
    };
});

vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/api/server-api', () => ({
    ApiResponseError,
    serverFetch: (...args: unknown[]) => serverFetch(...args),
    serverMutation: vi.fn(),
}));
vi.mock('@/lib/api/teams', () => ({
    teamsAPI: { listOrganizations: (...args: unknown[]) => listOrganizations(...args) },
}));
vi.mock('@/components/settings/EverPlatformConnectionPanel', () => ({
    EverPlatformConnectionPanel: ({ state }: { state: string }) => (
        <div data-testid="connection" data-state={state} />
    ),
}));
vi.mock('@/components/settings/EverPlatformOrganizationLinks', () => ({
    EverPlatformOrganizationLinks: ({
        organizations,
    }: {
        organizations: readonly { slug: string; view: unknown }[];
    }) => (
        <div data-testid="links">
            {organizations.map((o) => `${o.slug}:${o.view ? 'read' : 'unread'}`).join(',')}
        </div>
    ),
}));
vi.mock('@/components/settings/InstallRequestsPanel', () => ({
    InstallRequestsPanel: ({ state }: { state: string }) => (
        <div data-testid="installs" data-state={state} />
    ),
}));
vi.mock('@/components/settings/UsageStatisticsSettings', () => ({
    UsageStatisticsSettings: ({ state }: { state: string }) => (
        <div data-testid="stats" data-state={state} />
    ),
}));

import EverPlatformSettingsPage from './page';

const STATS = '/instance-stats/status';
const STATUS = '/ever-connect/status';
const INSTALLS = '/ever-connect/install-requests';
const linkOf = (id: string) => `/ever-connect/organizations/${id}/link`;
const ACME = { id: 'org-acme', displayName: 'Acme', slug: 'acme' };
const BETA = { id: 'org-beta', displayName: 'Beta', slug: 'beta' };
const FORBIDDEN = () => new ApiResponseError('Forbidden', 403);

const statusView = (linkCodes: boolean) => ({
    connection: { status: 'active' },
    features: { linkCodes, heartbeat: false, entitlements: false, appSync: false },
});
const LINK = { connected: true, link: null, entitlement: null, appSync: false, canManage: false };

/** What each address answers; an address that is not here answers 404. */
let answers: Record<string, unknown>;
const requested = () => serverFetch.mock.calls.map(([endpoint]) => endpoint as string);
const linkRequests = () => requested().filter((endpoint) => endpoint.endsWith('/link'));
const sections = () =>
    ['connection', 'links', 'stats', 'installs'].filter((id) => screen.queryByTestId(id) !== null);

beforeEach(() => {
    answers = {};
    notFound.mockClear();
    serverFetch.mockReset().mockImplementation(async (endpoint: string) => {
        if (!(endpoint in answers)) throw new ApiResponseError('Not Found', 404);
        const answer = answers[endpoint];
        if (answer instanceof Error) throw answer;
        return answer;
    });
    listOrganizations.mockReset().mockResolvedValue([ACME, BETA]);
});

describe('Settings → Ever Platform page', () => {
    it("every switch off: 404, without listing the person's Organizations or asking for a link", async () => {
        await expect(EverPlatformSettingsPage()).rejects.toThrow('NEXT_NOT_FOUND');
        expect(listOrganizations).not.toHaveBeenCalled();
        expect(linkRequests()).toEqual([]);
        expect(requested().sort()).toEqual([INSTALLS, STATUS, STATS].sort());
    });

    it('statistics only: the statistics section, and still nothing asked about links', async () => {
        answers[STATS] = { enabled: true };
        render(await EverPlatformSettingsPage());
        expect(sections()).toEqual(['stats']);
        expect(listOrganizations).not.toHaveBeenCalled();
        expect(linkRequests()).toEqual([]);
    });

    it('a platform admin with link codes switched off: the connection, and no link is asked', async () => {
        answers[STATUS] = statusView(false);
        answers[INSTALLS] = { requests: [] };
        render(await EverPlatformSettingsPage());
        expect(sections()).toEqual(['connection', 'installs']);
        expect(screen.getByTestId('connection').getAttribute('data-state')).toBe('loaded');
        expect(listOrganizations).not.toHaveBeenCalled();
        expect(linkRequests()).toEqual([]);
    });

    it("a platform admin with link codes switched on: every Organization's link", async () => {
        answers[STATUS] = statusView(true);
        answers[INSTALLS] = { requests: [] };
        answers[linkOf(ACME.id)] = LINK;
        answers[linkOf(BETA.id)] = LINK;
        render(await EverPlatformSettingsPage());
        expect(sections()).toEqual(['connection', 'links', 'installs']);
        expect(screen.getByTestId('links').textContent).toBe('acme:read,beta:read');
    });

    it('a member who is not a platform admin, linking switched on: the link section alone', async () => {
        answers[STATUS] = FORBIDDEN();
        answers[INSTALLS] = FORBIDDEN();
        answers[linkOf(ACME.id)] = LINK;
        answers[linkOf(BETA.id)] = new ApiResponseError('Internal Server Error', 500);
        render(await EverPlatformSettingsPage());
        expect(sections()).toEqual(['links']);
        // One link that could not be read keeps its row.
        expect(screen.getByTestId('links').textContent).toBe('acme:read,beta:unread');
    });

    it('a member who is not a platform admin, linking switched off: nothing to show, 404', async () => {
        answers[STATUS] = FORBIDDEN();
        answers[INSTALLS] = FORBIDDEN();
        await expect(EverPlatformSettingsPage()).rejects.toThrow('NEXT_NOT_FOUND');
        // The first Organization's 404 settled it.
        expect(linkRequests()).toEqual([linkOf(ACME.id)]);
    });

    it('a failure to list the Organizations hides the link section only', async () => {
        answers[STATS] = { enabled: true };
        answers[STATUS] = statusView(true);
        answers[INSTALLS] = { requests: [] };
        listOrganizations.mockRejectedValue(new Error('organizations down'));
        render(await EverPlatformSettingsPage());
        expect(sections()).toEqual(['connection', 'stats', 'installs']);
        expect(screen.getByTestId('connection').getAttribute('data-state')).toBe('loaded');
        expect(notFound).not.toHaveBeenCalled();
    });

    it('a connection that could not be read says so, and the rest of the page stays', async () => {
        answers[STATS] = { enabled: true };
        answers[STATUS] = new ApiResponseError('Bad Gateway', 502);
        answers[INSTALLS] = new ApiResponseError('Bad Gateway', 502);
        listOrganizations.mockRejectedValue(new Error('organizations down'));
        render(await EverPlatformSettingsPage());
        expect(sections()).toEqual(['connection', 'stats', 'installs']);
        expect(screen.getByTestId('connection').getAttribute('data-state')).toBe('unavailable');
        expect(screen.getByTestId('installs').getAttribute('data-state')).toBe('unavailable');
    });
});
