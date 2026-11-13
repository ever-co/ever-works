import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The web's client for `/api/ever-connect/*`: how many requests the settings
 * navigation and the settings page make to the Ever Connect module, and that a
 * failure to read an Organization's link never takes anything else down.
 *
 * Pinned, because the settings layout runs on EVERY Settings navigation:
 *
 * - where the module is off (the default) its status route's 404 is the ONLY
 *   request: the person's Organizations are not listed and no link is asked;
 * - a platform admin costs one request too (the status), and its
 *   `features.linkCodes` decides whether an Organization's link is asked at all;
 * - only a person who is not a platform admin, on a deployment that has the
 *   module loaded (403), is probed through the link route;
 * - a failure while reading the Organizations or their links hides the link
 *   section only (`null` / `false`), and never throws.
 */
const { ApiResponseError, serverFetch, listOrganizations } = vi.hoisted(() => {
    class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
        ) {
            super(message);
        }
    }
    return { ApiResponseError, serverFetch: vi.fn(), listOrganizations: vi.fn() };
});

vi.mock('./server-api', () => ({
    ApiResponseError,
    serverFetch: (...args: unknown[]) => serverFetch(...args),
    serverMutation: vi.fn(),
}));
vi.mock('./teams', () => ({
    teamsAPI: { listOrganizations: (...args: unknown[]) => listOrganizations(...args) },
}));

import { everConnectAPI, type EverConnectAccess } from './ever-connect';

const STATUS = '/ever-connect/status';
const linkOf = (id: string) => `/ever-connect/organizations/${id}/link`;
const ACME = { id: 'org-acme', displayName: 'Acme', slug: 'acme' };
const BETA = { id: 'org-beta', displayName: 'Beta', slug: 'beta' };

const statusView = (linkCodes: boolean) => ({
    connection: { status: 'active' },
    features: { linkCodes, heartbeat: false, entitlements: false, appSync: false },
});
const linkView = (canManage = false) => ({
    connected: true,
    link: null,
    entitlement: null,
    appSync: false,
    canManage,
});

/** What each address answers: a value, or an error to throw. */
let answers: Record<string, unknown>;
const requested = () => serverFetch.mock.calls.map(([endpoint]) => endpoint as string);

const ABSENT: EverConnectAccess = { kind: 'absent' };
const MEMBER: EverConnectAccess = { kind: 'member' };
const UNKNOWN: EverConnectAccess = { kind: 'unknown' };
const admin = (linkCodes: boolean): EverConnectAccess => ({
    kind: 'admin',
    status: statusView(linkCodes) as never,
});

beforeEach(() => {
    answers = {};
    serverFetch.mockReset().mockImplementation(async (endpoint: string) => {
        if (!(endpoint in answers)) throw new ApiResponseError('Not Found', 404);
        const answer = answers[endpoint];
        if (answer instanceof Error) throw answer;
        return answer;
    });
    listOrganizations.mockReset().mockResolvedValue([ACME, BETA]);
});

describe('everConnectAPI.access — one request tells how the module answers', () => {
    it('404: the module is absent', async () => {
        expect(await everConnectAPI.access()).toEqual({ kind: 'absent' });
        expect(requested()).toEqual([STATUS]);
    });

    it('403: the module is loaded and the person is not a platform admin', async () => {
        answers[STATUS] = new ApiResponseError('Forbidden', 403);
        expect(await everConnectAPI.access()).toEqual({ kind: 'member' });
        expect(requested()).toEqual([STATUS]);
    });

    it('200: a platform admin, with the status', async () => {
        answers[STATUS] = statusView(true);
        expect(await everConnectAPI.access()).toEqual({ kind: 'admin', status: statusView(true) });
    });

    it('anything else: unknown, and never a throw', async () => {
        answers[STATUS] = new ApiResponseError('Bad Gateway', 502);
        expect(await everConnectAPI.access()).toEqual({ kind: 'unknown' });
        answers[STATUS] = new TypeError('fetch failed');
        expect(await everConnectAPI.access()).toEqual({ kind: 'unknown' });
    });
});

describe('everConnectAPI.settingsTabAvailable — what every Settings navigation costs', () => {
    it('every switch off: the status 404 is the only request, and there is no tab', async () => {
        expect(await everConnectAPI.settingsTabAvailable()).toBe(false);
        expect(requested()).toEqual([STATUS]);
        expect(listOrganizations).not.toHaveBeenCalled();
    });

    it('a platform admin: the status is the only request, and there is a tab', async () => {
        for (const linkCodes of [false, true]) {
            serverFetch.mockClear();
            answers[STATUS] = statusView(linkCodes);
            expect(await everConnectAPI.settingsTabAvailable()).toBe(true);
            expect(requested()).toEqual([STATUS]);
        }
        expect(listOrganizations).not.toHaveBeenCalled();
    });

    it('not a platform admin, linking switched on: the link route says so', async () => {
        answers[STATUS] = new ApiResponseError('Forbidden', 403);
        answers[linkOf(ACME.id)] = linkView();
        expect(await everConnectAPI.settingsTabAvailable()).toBe(true);
        // The first Organization answers for all: the others are not asked.
        expect(requested()).toEqual([STATUS, linkOf(ACME.id)]);
        expect(listOrganizations).toHaveBeenCalledTimes(1);
    });

    it('not a platform admin, linking switched off (404) or no Organization: no tab', async () => {
        answers[STATUS] = new ApiResponseError('Forbidden', 403);
        expect(await everConnectAPI.settingsTabAvailable()).toBe(false);
        expect(requested()).toEqual([STATUS, linkOf(ACME.id)]);

        serverFetch.mockClear();
        listOrganizations.mockResolvedValue([]);
        expect(await everConnectAPI.settingsTabAvailable()).toBe(false);
        expect(requested()).toEqual([STATUS]);
    });

    it('a failure anywhere is "no tab", never a throw', async () => {
        answers[STATUS] = new ApiResponseError('Forbidden', 403);
        listOrganizations.mockRejectedValue(new Error('organizations down'));
        expect(await everConnectAPI.settingsTabAvailable()).toBe(false);

        listOrganizations.mockResolvedValue([ACME]);
        answers[linkOf(ACME.id)] = new ApiResponseError('Internal Server Error', 500);
        expect(await everConnectAPI.settingsTabAvailable()).toBe(false);

        answers[STATUS] = new TypeError('fetch failed');
        expect(await everConnectAPI.settingsTabAvailable()).toBe(false);
    });
});

describe('everConnectAPI.organizationLinks — the Organization link section of the page', () => {
    it('asks nothing where linking cannot be on: module absent, or the switch off in the status', async () => {
        expect(await everConnectAPI.organizationLinks(ABSENT)).toBeNull();
        expect(await everConnectAPI.organizationLinks(admin(false))).toBeNull();
        expect(listOrganizations).not.toHaveBeenCalled();
        expect(requested()).toEqual([]);
    });

    it("reads every Organization's link where linking is on", async () => {
        answers[linkOf(ACME.id)] = linkView(true);
        answers[linkOf(BETA.id)] = linkView(false);
        for (const access of [admin(true), MEMBER, UNKNOWN]) {
            serverFetch.mockClear();
            expect(await everConnectAPI.organizationLinks(access)).toEqual([
                {
                    organizationId: ACME.id,
                    displayName: 'Acme',
                    slug: 'acme',
                    view: linkView(true),
                },
                {
                    organizationId: BETA.id,
                    displayName: 'Beta',
                    slug: 'beta',
                    view: linkView(false),
                },
            ]);
            expect(requested()).toEqual([linkOf(ACME.id), linkOf(BETA.id)]);
        }
    });

    it('no section when the link route is not there (404), may not be read (403) or there is no Organization', async () => {
        expect(await everConnectAPI.organizationLinks(MEMBER)).toBeNull();
        // The first answer settles it.
        expect(requested()).toEqual([linkOf(ACME.id)]);

        answers[linkOf(ACME.id)] = new ApiResponseError('Forbidden', 403);
        expect(await everConnectAPI.organizationLinks(MEMBER)).toBeNull();

        listOrganizations.mockResolvedValue([]);
        expect(await everConnectAPI.organizationLinks(MEMBER)).toBeNull();
    });

    it('one link that cannot be read keeps its row, which says so; the others are read', async () => {
        answers[linkOf(ACME.id)] = new ApiResponseError('Internal Server Error', 500);
        answers[linkOf(BETA.id)] = linkView(true);
        expect(await everConnectAPI.organizationLinks(MEMBER)).toEqual([
            { organizationId: ACME.id, displayName: 'Acme', slug: 'acme', view: null },
            { organizationId: BETA.id, displayName: 'Beta', slug: 'beta', view: linkView(true) },
        ]);
    });

    it('a failure to list the Organizations hides the section and does not throw', async () => {
        listOrganizations.mockRejectedValue(new Error('organizations down'));
        await expect(everConnectAPI.organizationLinks(MEMBER)).resolves.toBeNull();
        await expect(everConnectAPI.organizationLinks(admin(true))).resolves.toBeNull();

        // A list that is not a list (an unexpected answer) is the same.
        listOrganizations.mockResolvedValue(null);
        await expect(everConnectAPI.organizationLinks(MEMBER)).resolves.toBeNull();
    });
});
