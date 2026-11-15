import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * `/new`, the page: what it does with the address a marketplace install sends a
 * person to (`/new?type=app&blueprint=…&ever_org=…&install=…`), and that every
 * other visit is as it was.
 */
const { redirect, workspace, disabledKinds, listMissions } = vi.hoisted(() => ({
    redirect: vi.fn((href: string) => {
        throw new Error(`NEXT_REDIRECT ${href}`);
    }),
    workspace: { current: 'personal' as string | null },
    disabledKinds: { current: [] as string[] },
    listMissions: vi.fn(async () => [] as unknown[]),
}));

vi.mock('next/navigation', () => ({ redirect: (href: string) => redirect(href) }));
vi.mock('next/headers', () => ({
    headers: async () =>
        new Headers(workspace.current === null ? {} : { 'x-ever-workspace': workspace.current }),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/components/new', () => ({
    NewPageClient: (props: { initialType: string; disabledKinds: string[] }) => (
        <div data-testid="new-page" data-type={props.initialType} />
    ),
}));
vi.mock('@/lib/api/templates', () => ({
    templatesAPI: { list: vi.fn(async () => ({ templates: [] })) },
}));
vi.mock('@/lib/api/missions', () => ({
    missionsAPI: { list: () => listMissions(), templateManifest: vi.fn(async () => null) },
}));
vi.mock('@/lib/feature-flags/work-kinds', () => ({
    getDisabledWorkKinds: async () => new Set(disabledKinds.current),
}));

import NewPage from './page';

const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const EVER_ORG = '01JMQCK0RG000000000000000A';

type Params = Record<string, string | string[] | undefined>;

/** Render the page for a query; answers where it redirected to, or `null`. */
async function visit(params: Params): Promise<string | null> {
    try {
        render(await NewPage({ searchParams: Promise.resolve(params) as never }));
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
    listMissions.mockClear();
    workspace.current = 'personal';
    disabledKinds.current = [];
    vi.stubEnv('EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED', 'true');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('/new — a Blueprint hand-off from the marketplace', () => {
    it('goes on to the App create form with the Blueprint, the install and the Ever organization', async () => {
        expect(
            await visit({
                type: 'app',
                blueprint: 'cal-diy',
                ever_org: EVER_ORG,
                install: INSTALL,
            }),
        ).toBe(
            `/works/new?mode=manual&kind=app&blueprint=cal-diy&ever_org=${EVER_ORG}&install=${INSTALL}`,
        );
        // Decided from the address alone: nothing is asked of the API for it.
        expect(listMissions).not.toHaveBeenCalled();
    });

    it('a Blueprint alone is enough, and the chip may be spelled in any case', async () => {
        expect(await visit({ type: 'APP', blueprint: 'cal-diy' })).toBe(
            '/works/new?mode=manual&kind=app&blueprint=cal-diy',
        );
    });

    it('stays in the workspace the visitor is in', async () => {
        workspace.current = 'org:acme';
        expect(await visit({ type: 'app', blueprint: 'cal-diy', install: INSTALL })).toBe(
            `/org/acme/works/new?mode=manual&kind=app&blueprint=cal-diy&install=${INSTALL}`,
        );
    });

    it('a workspace it cannot read is the personal one, never a guess', async () => {
        for (const value of [null, 'org:Not A Slug', 'nonsense']) {
            workspace.current = value;
            expect(await visit({ type: 'app', blueprint: 'cal-diy' })).toBe(
                '/works/new?mode=manual&kind=app&blueprint=cal-diy',
            );
        }
    });

    it('carries only what it read: an install or an Ever organization that is not one is left out', async () => {
        expect(
            await visit({
                type: 'app',
                blueprint: 'cal-diy',
                install: 'https://evil.example/x',
                ever_org: '<b>acme</b>',
                template: 'x',
                redirect_uri: 'https://evil.example',
            } as Params),
        ).toBe('/works/new?mode=manual&kind=app&blueprint=cal-diy');
    });

    it.each([
        ['no Blueprint', { type: 'app', install: INSTALL, ever_org: EVER_ORG }],
        ['a Blueprint that is not spelled like one', { type: 'app', blueprint: 'calcom/cal.diy' }],
        ['a Blueprint given twice', { type: 'app', blueprint: ['cal-diy', 'umami'] }],
    ])('with %s the App chip is as it was: no redirect', async (_name, params) => {
        expect(await visit(params)).toBeNull();
        expect(screen.getByTestId('new-page').getAttribute('data-type')).toBe('app');
        expect(redirect).not.toHaveBeenCalled();
    });

    it.each([
        ['another chip', { type: 'mission', blueprint: 'cal-diy', install: INSTALL }],
        ['a chip that is not one', { type: 'nonsense', blueprint: 'cal-diy' }],
        ['no chip', { blueprint: 'cal-diy', install: INSTALL }],
    ])('a Blueprint means nothing for %s', async (_name, params) => {
        expect(await visit(params)).toBeNull();
        expect(redirect).not.toHaveBeenCalled();
        expect(screen.getByTestId('new-page').getAttribute('data-type')).not.toBe('app');
    });

    it.each([
        ['unset', undefined],
        ['`false`', 'false'],
        ['a value that is not `true`', '1'],
    ])(
        'with the switch %s the page is as it was: the App chip, and no redirect',
        async (_name, value) => {
            vi.unstubAllEnvs();
            if (value !== undefined) vi.stubEnv('EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED', value);
            expect(
                await visit({
                    type: 'app',
                    blueprint: 'cal-diy',
                    ever_org: EVER_ORG,
                    install: INSTALL,
                }),
            ).toBeNull();
            expect(redirect).not.toHaveBeenCalled();
            expect(screen.getByTestId('new-page').getAttribute('data-type')).toBe('app');
        },
    );

    it('a disabled App kind is not reachable this way: the page falls back as for any `?type=app`', async () => {
        disabledKinds.current = ['app'];
        expect(await visit({ type: 'app', blueprint: 'cal-diy', install: INSTALL })).toBeNull();
        expect(redirect).not.toHaveBeenCalled();
        expect(screen.getByTestId('new-page').getAttribute('data-type')).toBe('mission');
    });
});
