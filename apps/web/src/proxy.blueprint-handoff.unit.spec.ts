import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getAuthFromRequestMock, intlMock } = vi.hoisted(() => ({
    getAuthFromRequestMock: vi.fn(),
    intlMock: vi.fn(async (_request: unknown) => new Response(null, { status: 200 })),
}));

vi.mock('next-intl/middleware', () => ({ default: () => intlMock }));
vi.mock('./lib/auth', () => ({ getAuthFromRequest: getAuthFromRequestMock }));

import proxy from './proxy';

/**
 * A Blueprint hand-off from Ever Platform's marketplace
 * (`/new?type=app&blueprint=…&ever_org=…&install=…`) through the proxy's
 * sign-in gate: a signed-out visitor is sent to sign in and comes back to the
 * same hand-off, and every other address is gated exactly as it was.
 */
const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const EVER_ORG = '01JMQCK0RG000000000000000A';
const ORIGIN = 'https://app.example';

const visit = (path: string) => proxy(new NextRequest(`${ORIGIN}${path}`));

/** Where a redirect goes, as the path and the address sign-in is told to come back to. */
function target(response: Response) {
    const location = new URL(response.headers.get('location') ?? '', ORIGIN);
    return {
        origin: location.origin,
        pathname: location.pathname,
        keys: [...location.searchParams.keys()],
        back: location.searchParams.get('redirect_uri'),
    };
}

describe('the sign-in gate — a Blueprint hand-off', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: false, isExpired: false });
        vi.stubEnv('EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED', 'true');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each([
        ['unset', undefined],
        ['`false`', 'false'],
        ['a value that is not `true`', '1'],
    ])(
        'with the switch %s the gate is as it always was: sign-in, with nothing to come back to',
        async (_name, value) => {
            vi.unstubAllEnvs();
            if (value !== undefined) vi.stubEnv('EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED', value);
            const response = await visit(
                `/new?type=app&blueprint=cal-diy&ever_org=${EVER_ORG}&install=${INSTALL}`,
            );
            expect(response.status).toBe(307);
            expect(target(response)).toEqual({
                origin: ORIGIN,
                pathname: '/login',
                keys: [],
                back: null,
            });
        },
    );

    it('a signed-out visitor signs in and comes back with the Blueprint, the install and the Ever organization', async () => {
        const response = await visit(
            `/new?type=app&blueprint=cal-diy&ever_org=${EVER_ORG}&install=${INSTALL}`,
        );

        expect(response.status).toBe(307);
        expect(target(response)).toEqual({
            origin: ORIGIN,
            pathname: '/login',
            keys: ['redirect_uri'],
            back: `/new?type=app&blueprint=cal-diy&ever_org=${EVER_ORG}&install=${INSTALL}`,
        });
    });

    it('the create form itself, and a workspace, come back as they were asked for', async () => {
        expect(
            target(await visit(`/works/new?kind=app&blueprint=cal-diy&install=${INSTALL}`)).back,
        ).toBe(`/works/new?mode=manual&kind=app&blueprint=cal-diy&install=${INSTALL}`);
        expect(target(await visit('/org/acme/new?type=app&blueprint=cal-diy')).back).toBe(
            '/org/acme/new?type=app&blueprint=cal-diy',
        );
    });

    it('an expired session is the same as none', async () => {
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: true });
        expect(target(await visit('/new?type=app&blueprint=cal-diy')).back).toBe(
            '/new?type=app&blueprint=cal-diy',
        );
    });

    it('carries nothing through sign-in but the hand-off, and never leaves the site', async () => {
        const response = await visit(
            '/new?type=app&blueprint=cal-diy&install=nope&redirect_uri=https%3A%2F%2Fevil.example&next=%2F%2Fevil.example&access_token=secret',
        );
        expect(target(response)).toEqual({
            origin: ORIGIN,
            pathname: '/login',
            keys: ['redirect_uri'],
            back: '/new?type=app&blueprint=cal-diy',
        });
    });

    it.each([
        ['another chip of /new', '/new?type=mission&blueprint=cal-diy'],
        ['/new without a Blueprint', `/new?type=app&install=${INSTALL}`],
        ['a Blueprint that is not one', '/new?type=app&blueprint=https%3A%2F%2Fevil.example'],
        ['another page', '/works?kind=app&blueprint=cal-diy'],
        ['a plain visit', '/dashboard'],
    ])(
        '%s is gated as it always was: sign-in, with nothing to come back to',
        async (_name, path) => {
            const response = await visit(path);
            expect(response.status).toBe(307);
            expect(target(response)).toEqual({
                origin: ORIGIN,
                pathname: '/login',
                keys: [],
                back: null,
            });
        },
    );

    it('a signed-in visitor is not redirected: the page reads the hand-off itself', async () => {
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
        const response = await visit(`/new?type=app&blueprint=cal-diy&install=${INSTALL}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
    });
});
