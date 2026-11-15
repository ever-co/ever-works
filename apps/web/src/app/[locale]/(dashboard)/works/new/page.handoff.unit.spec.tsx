import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * `/works/new`, the page, for a Blueprint hand-off from Ever Platform's
 * marketplace (`?kind=app&blueprint=…&ever_org=…&install=…`): which workspace
 * the form opens in, what the form is given, and that a visit without a
 * hand-off is as it was. What the address may carry is pinned by
 * `blueprint-handoff.shared.unit.spec.ts`; here it is the page's own decisions.
 */
const { redirect, workspace, signedIn, disabledKinds, resolve, workspaceOf, clientProps } =
    vi.hoisted(() => ({
        redirect: vi.fn((href: string) => {
            throw new Error(`NEXT_REDIRECT ${href}`);
        }),
        workspace: { current: 'personal' as string | null },
        signedIn: { current: true },
        disabledKinds: { current: [] as string[] },
        resolve: vi.fn(),
        workspaceOf: vi.fn(),
        clientProps: { current: null as Record<string, unknown> | null },
    }));

vi.mock('next/navigation', () => ({ redirect: (href: string) => redirect(href) }));
vi.mock('next/headers', () => ({
    headers: async () =>
        new Headers(workspace.current === null ? {} : { 'x-ever-workspace': workspace.current }),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/auth', () => ({
    getAuthFromCookie: async () => (signedIn.current ? { id: 'user-1', username: 'me' } : null),
}));
vi.mock('@/lib/api', () => ({
    gitProvidersAPI: {
        list: async () => ({ providers: [] }),
        checkConnection: async () => null,
    },
    deployAPI: { getProviders: async () => ({ providers: [] }) },
    workAPI: { getWebsiteTemplates: async () => ({ templates: [] }) },
}));
vi.mock('@/lib/api/work-templates.server', () => ({ fetchWorkTemplateCatalog: async () => [] }));
vi.mock('@/lib/api/work-proposals', () => ({ workProposalsAPI: { get: async () => null } }));
vi.mock('@/lib/feature-flags/work-kinds', () => ({
    getDisabledWorkKinds: async () => new Set(disabledKinds.current),
}));
vi.mock('@/lib/works/managed-storage', () => ({
    resolveManagedStorageStatus: async () => ({ managedGitActive: false }),
}));
vi.mock('@/lib/works/blueprint-handoff.server', () => ({
    resolveBlueprintHandoff: (...args: unknown[]) => resolve(...args),
    workspaceOfBlueprintHandoff: (...args: unknown[]) => workspaceOf(...args),
}));
vi.mock('./new-work-client', () => ({
    default: (props: Record<string, unknown>) => {
        clientProps.current = props;
        return <div data-testid="new-work" />;
    },
}));

import NewWorkPage from './page';

const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const EVER_ORG = '01JMQCK0RG000000000000000A';
const UPSTREAM = 'https://github.com/calcom/cal.diy';
const HANDOFF = { blueprint: 'cal-diy', install: INSTALL, everOrg: EVER_ORG };
const RESOLVED = {
    blueprintId: 'cal-diy',
    repositoryUrl: UPSTREAM,
    installId: INSTALL,
    everOrg: EVER_ORG,
};
/** The form is given the install: it is opened in the Organization the install belongs to. */
const WITH_INSTALL = { keepInstall: true };
/** The form is given the Blueprint only. */
const WITHOUT_INSTALL = { keepInstall: false };
const ACME = { kind: 'organization', slug: 'acme' };

type Params = Record<string, string | string[] | undefined>;

/** Render the page for a query; answers where it redirected to, or `null`. */
async function visit(params: Params): Promise<string | null> {
    try {
        render(await NewWorkPage({ searchParams: Promise.resolve(params) as never }));
        return null;
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!message.startsWith('NEXT_REDIRECT ')) throw error;
        return message.slice('NEXT_REDIRECT '.length);
    }
}

beforeEach(() => {
    cleanup();
    redirect.mockClear();
    resolve.mockReset();
    workspaceOf.mockReset();
    resolve.mockResolvedValue(RESOLVED);
    workspaceOf.mockResolvedValue(null);
    workspace.current = 'personal';
    signedIn.current = true;
    disabledKinds.current = [];
    clientProps.current = null;
    vi.stubEnv('EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED', 'true');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('/works/new — a Blueprint hand-off from the marketplace', () => {
    const query = {
        mode: 'manual',
        kind: 'app',
        blueprint: 'cal-diy',
        ever_org: EVER_ORG,
        install: INSTALL,
    };

    it('opens the App form with the Blueprint’s repository and the install, in the Organization linked to the Ever organization', async () => {
        workspace.current = 'org:acme';
        workspaceOf.mockResolvedValue(ACME);
        expect(await visit(query)).toBeNull();
        expect(screen.getByTestId('new-work')).toBeTruthy();
        expect(workspaceOf).toHaveBeenCalledWith(HANDOFF);
        expect(resolve).toHaveBeenCalledWith(HANDOFF, WITH_INSTALL);
        expect(clientProps.current).toMatchObject({
            initialKind: 'app',
            initialMode: 'manual',
            appBlueprintHandoff: RESOLVED,
        });
    });

    it('needs no `mode`: a hand-off opens the App form on its own', async () => {
        expect(await visit({ kind: 'app', blueprint: 'cal-diy' })).toBeNull();
        expect(clientProps.current).toMatchObject({ initialKind: 'app', initialMode: 'manual' });
        expect(resolve).toHaveBeenCalledWith(
            { blueprint: 'cal-diy', install: null, everOrg: null },
            WITHOUT_INSTALL,
        );
    });

    it('goes to the person’s Organization linked to the Ever organization, keeping the hand-off', async () => {
        workspaceOf.mockResolvedValue({ kind: 'organization', slug: 'acme' });
        expect(await visit(query)).toBe(
            `/org/acme/works/new?mode=manual&kind=app&blueprint=cal-diy&ever_org=${EVER_ORG}&install=${INSTALL}`,
        );
        expect(workspaceOf).toHaveBeenCalledWith(HANDOFF);
        // Nothing is read for a form that is not shown here.
        expect(resolve).not.toHaveBeenCalled();
    });

    describe('the install is a claim: the form is given it only in the Organization it belongs to', () => {
        it('in another Organization than the linked one: the form opens there, without the install', async () => {
            workspace.current = 'org:acme';
            workspaceOf.mockResolvedValue({ kind: 'organization', slug: 'globex' });
            // No redirect out of an Organization the visitor chose.
            expect(await visit(query)).toBeNull();
            expect(resolve).toHaveBeenCalledWith(HANDOFF, WITHOUT_INSTALL);
        });

        it('no Organization linked to it (or linking is off here): the form opens where the visitor is, without the install', async () => {
            expect(await visit(query)).toBeNull();
            expect(workspaceOf).toHaveBeenCalledTimes(1);
            expect(resolve).toHaveBeenCalledWith(HANDOFF, WITHOUT_INSTALL);

            workspace.current = 'org:acme';
            resolve.mockClear();
            expect(await visit(query)).toBeNull();
            expect(resolve).toHaveBeenCalledWith(HANDOFF, WITHOUT_INSTALL);
        });

        it('a hand-off that names no Ever organization asks for none, and its install binds nothing', async () => {
            workspace.current = 'org:acme';
            workspaceOf.mockResolvedValue(ACME);
            expect(await visit({ kind: 'app', blueprint: 'cal-diy', install: INSTALL })).toBeNull();
            expect(workspaceOf).not.toHaveBeenCalled();
            expect(resolve).toHaveBeenCalledWith(
                { blueprint: 'cal-diy', install: INSTALL, everOrg: null },
                WITHOUT_INSTALL,
            );
        });

        it('a hand-off without an install has none to keep, in the linked Organization too', async () => {
            workspace.current = 'org:acme';
            workspaceOf.mockResolvedValue(ACME);
            expect(
                await visit({ kind: 'app', blueprint: 'cal-diy', ever_org: EVER_ORG }),
            ).toBeNull();
            expect(resolve).toHaveBeenCalledWith(
                { blueprint: 'cal-diy', install: null, everOrg: EVER_ORG },
                WITHOUT_INSTALL,
            );
        });
    });

    it('a signed-out visitor is sent to sign in before anything is looked up', async () => {
        signedIn.current = false;
        expect(await visit(query)).toBe('/login');
        expect(workspaceOf).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
    });

    it.each([
        ['unset', undefined],
        ['`false`', 'false'],
        ['a value that is not `true`', 'yes'],
    ])(
        'with the switch %s the page is as it was: nothing is looked up, the form gets no hand-off',
        async (_name, value) => {
            vi.unstubAllEnvs();
            if (value !== undefined) vi.stubEnv('EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED', value);
            workspaceOf.mockResolvedValue({ kind: 'organization', slug: 'acme' });

            expect(await visit(query)).toBeNull();
            expect(workspaceOf).not.toHaveBeenCalled();
            expect(resolve).not.toHaveBeenCalled();
            expect(clientProps.current).toMatchObject({
                initialKind: 'app',
                initialMode: 'manual',
                appBlueprintHandoff: null,
            });
            // And without a `mode` the visitor is sent to /new, as before.
            expect(await visit({ kind: 'app', blueprint: 'cal-diy' })).toBe('/new');
        },
    );

    it('a disabled App kind gets no hand-off', async () => {
        disabledKinds.current = ['app'];
        expect(await visit(query)).toBeNull();
        expect(resolve).not.toHaveBeenCalled();
        expect(clientProps.current).toMatchObject({ initialKind: null, appBlueprintHandoff: null });
    });

    it.each([
        ['another kind', { mode: 'manual', kind: 'repo', blueprint: 'cal-diy', install: INSTALL }],
        ['no kind', { mode: 'manual', blueprint: 'cal-diy', install: INSTALL }],
        [
            'a Blueprint that is not one',
            { mode: 'manual', kind: 'app', blueprint: 'calcom/cal.diy' },
        ],
        ['no Blueprint', { mode: 'manual', kind: 'app', install: INSTALL, ever_org: EVER_ORG }],
    ])('is not a hand-off: %s (the page is as it was)', async (_name, params) => {
        expect(await visit(params)).toBeNull();
        expect(workspaceOf).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
        expect(clientProps.current).toMatchObject({ appBlueprintHandoff: null });
    });

    it('without a mode and without a hand-off the page still sends the visitor to /new', async () => {
        expect(await visit({ kind: 'app' })).toBe('/new');
        expect(await visit({ kind: 'app', blueprint: 'calcom/cal.diy' })).toBe('/new');
    });
});
