import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ever ID — the sign-in start address (`GET /api/auth/ever-id/start`).
 *
 * Pinned, for each of its three outcomes:
 *
 *  - **off** (the default), or Ever ID not offered: `404`, and with the switch
 *    off nothing is read and nothing is called;
 *  - **on, signed out**: the same authorization the "Sign in with Ever ID"
 *    button starts (one `authorize` call, the transaction in the same two
 *    cookies with the same attributes), then the provider's address;
 *  - **on, signed in**: straight to the destination, no authorization.
 *
 * And for every answer: `Cache-Control: no-store`, the sign-in page's
 * Referrer-Policy, and no address that carries the transaction.
 *
 * The cookie module is the real one, over an in-memory jar that records the
 * attributes each cookie was written with.
 */

const jar = vi.hoisted(() => {
    const values = new Map<string, string>();
    const options = new Map<string, Record<string, unknown>>();
    return {
        values,
        options,
        reset() {
            values.clear();
            options.clear();
        },
        store: {
            get: (name: string) =>
                values.has(name) ? { name, value: values.get(name)! } : undefined,
            set: (name: string, value: string, attributes: Record<string, unknown> = {}) => {
                values.set(name, value);
                options.set(name, attributes);
            },
            delete: (arg: string | { name: string }) => {
                values.delete(typeof arg === 'string' ? arg : arg.name);
            },
        },
    };
});

const { authorizeMock, signedInMock, availabilityMock, flag } = vi.hoisted(() => ({
    authorizeMock: vi.fn(),
    signedInMock: vi.fn(),
    availabilityMock: vi.fn(),
    // The rollout-flag service: `null` is an installation without one.
    flag: { client: null as null | { isFeatureEnabled: (...args: unknown[]) => Promise<unknown> } },
}));

vi.mock('next/headers', () => ({
    cookies: async () => jar.store,
    headers: async () => new Headers(),
}));
vi.mock('next-intl/server', () => ({
    getLocale: async () => 'en',
    getTranslations: async () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    getPathname: ({ href }: { href: string }) => href,
}));
vi.mock('@/lib/auth', () => ({
    getAuthFromCookie: signedInMock,
    getRedirectCookie: async () => jar.values.get('__Host-redirect_url'),
}));
vi.mock('@/lib/auth/providers', () => ({ getEverIdAvailability: availabilityMock }));
vi.mock('@/lib/feature-flags/posthog-client', () => ({ getPostHogClient: () => flag.client }));
vi.mock('@/lib/api/ever-id', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api/ever-id')>();
    return { ...actual, everIdAPI: { ...actual.everIdAPI, authorize: authorizeMock } };
});

const PROVIDER_URL =
    'https://id.example/authorize?client_id=works&state=state-SECRET&code_challenge=challenge';
const TRANSACTION = 'sealed-transaction-SECRET';

const NAVIGATION = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

function request(
    search = '',
    init: { headers?: Record<string, string>; method?: string } = {},
): import('next/server').NextRequest {
    return {
        method: init.method ?? 'GET',
        headers: new Headers(init.headers ?? { ...NAVIGATION, 'Sec-Fetch-Site': 'cross-site' }),
        nextUrl: new URL(`https://app.example/api/auth/ever-id/start${search}`),
    } as unknown as import('next/server').NextRequest;
}

async function run(search = '', init?: Parameters<typeof request>[1]): Promise<Response> {
    const { GET } = await import('./route');
    return GET(request(search, init));
}

/** Every answer of the route: never stored, and the sign-in page's Referrer-Policy. */
function expectRouteHeaders(response: Response) {
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
}

function expectNotFound(response: Response) {
    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.body).toBeNull();
    expectRouteHeaders(response);
    // Nothing was started: no transaction, no cookie of any kind.
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(jar.values.size).toBe(0);
}

function expectRedirect(response: Response, location: string) {
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe(location);
    expectRouteHeaders(response);
}

const ORIGINAL_ENV = { ...process.env };

function setUp(env: Record<string, string> = { EVER_ID_START_ROUTE_ENABLED: 'true' }) {
    jar.reset();
    flag.client = null;
    authorizeMock.mockReset();
    signedInMock.mockReset();
    availabilityMock.mockReset();

    authorizeMock.mockResolvedValue({ authorizationUrl: PROVIDER_URL, transaction: TRANSACTION });
    signedInMock.mockResolvedValue(null);
    availabilityMock.mockResolvedValue({ enabled: true, displayName: 'Ever ID' });

    const base = { ...ORIGINAL_ENV };
    delete base.EVER_ID_START_ROUTE_ENABLED;
    process.env = {
        ...base,
        COOKIE_SECRET: 'k'.repeat(48),
        WEB_URL: 'https://app.example',
        ...env,
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
}

function tearDown() {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
}

describe('GET /api/auth/ever-id/start — off: the address does not exist', () => {
    afterEach(tearDown);

    it.each([
        ['unset', {}],
        ['false', { EVER_ID_START_ROUTE_ENABLED: 'false' }],
        ['1', { EVER_ID_START_ROUTE_ENABLED: '1' }],
        ['yes', { EVER_ID_START_ROUTE_ENABLED: 'yes' }],
        ['empty', { EVER_ID_START_ROUTE_ENABLED: '' }],
    ])('switch %s → 404, and nothing is read or called', async (_label, env) => {
        setUp(env);

        expectNotFound(await run('?return=/works/42'));

        // Not even whether Ever ID is on, or who is asking.
        expect(availabilityMock).not.toHaveBeenCalled();
        expect(signedInMock).not.toHaveBeenCalled();
    });

    it('switch off → 404 for a signed-in person too', async () => {
        setUp({});
        signedInMock.mockResolvedValue({ id: 'u1' });

        expectNotFound(await run());

        expect(signedInMock).not.toHaveBeenCalled();
    });

    it('switch on, Ever ID not turned on → 404', async () => {
        setUp();
        availabilityMock.mockResolvedValue({ enabled: false, displayName: 'Ever ID' });

        expectNotFound(await run('?return=/works/42'));

        expect(signedInMock).not.toHaveBeenCalled();
    });

    it('switch on, Ever ID not turned on → 404 for a signed-in person too', async () => {
        setUp();
        availabilityMock.mockResolvedValue({ enabled: false, displayName: 'Ever ID' });
        signedInMock.mockResolvedValue({ id: 'u1' });

        expectNotFound(await run());
    });

    it('switch on, Ever ID on, rollout flag off for the sign-in page → 404', async () => {
        setUp();
        flag.client = { isFeatureEnabled: async () => false };

        expectNotFound(await run());
    });

    it('the API says Ever ID was turned off a moment ago → 404, not an error page', async () => {
        setUp();
        const { EverIdRequestError } = await import('@/lib/api/ever-id');
        authorizeMock.mockRejectedValue(new EverIdRequestError(404, 'ever_id_disabled'));

        const response = await run();

        expect(response.status).toBe(404);
        expect(response.headers.get('Location')).toBeNull();
        expectRouteHeaders(response);
        expect(jar.values.size).toBe(0);
    });
});

describe('GET /api/auth/ever-id/start — on, signed out: the authorization the button starts', () => {
    beforeEach(() => setUp());
    afterEach(tearDown);

    it('redirects to the provider address the API returned, exactly', async () => {
        const response = await run();

        expectRedirect(response, PROVIDER_URL);
        expect(authorizeMock).toHaveBeenCalledTimes(1);
        expect(authorizeMock).toHaveBeenCalledWith({});
    });

    it('keeps the transaction in the flow’s own cookies, with its attributes', async () => {
        await run();

        expect(jar.values.get('__Host-ew_everid_txn')).toBe(TRANSACTION);
        expect(jar.values.get('__Host-ew_everid_intent')).toBe('sign-in');
        for (const name of ['__Host-ew_everid_txn', '__Host-ew_everid_intent']) {
            expect(jar.options.get(name)).toEqual({
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
                path: '/',
                maxAge: 600,
            });
        }
        // The two cookies of a sign-in, and no other.
        expect([...jar.values.keys()].sort()).toEqual([
            '__Host-ew_everid_intent',
            '__Host-ew_everid_txn',
        ]);
    });

    it('writes the cookies exactly as the sign-in button does', async () => {
        await run();
        const fromLink = new Map(jar.options);
        const linkValues = new Map(jar.values);

        jar.reset();
        const { setEverIdTransaction } = await import('@/lib/auth/ever-id-cookies');
        await setEverIdTransaction(TRANSACTION, 'sign-in');

        expect(new Map(jar.values)).toEqual(linkValues);
        expect(new Map(jar.options)).toEqual(fromLink);
    });

    it('asks for a fresh transaction on every request', async () => {
        authorizeMock
            .mockResolvedValueOnce({
                authorizationUrl: `${PROVIDER_URL}&n=1`,
                transaction: 'txn-1',
            })
            .mockResolvedValueOnce({
                authorizationUrl: `${PROVIDER_URL}&n=2`,
                transaction: 'txn-2',
            });

        const first = await run();
        expect(jar.values.get('__Host-ew_everid_txn')).toBe('txn-1');
        const second = await run();

        expect(authorizeMock).toHaveBeenCalledTimes(2);
        expect(first.headers.get('Location')).toBe(`${PROVIDER_URL}&n=1`);
        expect(second.headers.get('Location')).toBe(`${PROVIDER_URL}&n=2`);
        expect(jar.values.get('__Host-ew_everid_txn')).toBe('txn-2');
    });

    it('sends a return path of this site on to the API', async () => {
        const response = await run('?return=/works/42');

        expectRedirect(response, PROVIDER_URL);
        expect(authorizeMock).toHaveBeenCalledWith({ returnTo: '/works/42' });
    });

    it('sends a Blueprint hand-off address on whole', async () => {
        const handoff = '/new?type=app&blueprint=my-app&ever_org=acme';

        await run(`?return=${encodeURIComponent(handoff)}`);

        expect(authorizeMock).toHaveBeenCalledWith({ returnTo: handoff });
    });

    it.each([
        ['an absolute URL', 'https://evil.example/phish'],
        ['a protocol-relative URL', '//evil.example'],
        ['a backslash', '/\\evil.example'],
        ['an encoded `//`', '/%2Fevil.example'],
        ['a double-encoded `//`', '/%252Fevil.example'],
        ['an encoded backslash', '/%5Cevil.example'],
        ['a tab', '/\t/evil.example'],
        ['an encoded line break', '/%0d%0aSet-Cookie:%20a=b'],
        ['a dot segment', '/works/../../evil.example'],
    ])('ignores %s as a return path, and still starts the sign-in', async (_label, value) => {
        const response = await run(`?return=${encodeURIComponent(value)}`);

        expectRedirect(response, PROVIDER_URL);
        expect(authorizeMock).toHaveBeenCalledWith({});
    });

    it('ignores a return path given twice', async () => {
        await run('?return=/works&return=//evil.example');

        expect(authorizeMock).toHaveBeenCalledWith({});
    });

    it('falls back to a relative destination the app stored before sign-in, as the button does', async () => {
        jar.values.set('__Host-redirect_url', '/org-invite/tok');

        await run();

        expect(authorizeMock).toHaveBeenCalledWith({ returnTo: '/org-invite/tok' });
    });

    it('never forwards an absolute stored destination', async () => {
        jar.values.set('__Host-redirect_url', 'https://evil.example/phish');

        await run();

        expect(authorizeMock).toHaveBeenCalledWith({});
    });

    it('an explicit return path wins over the stored one', async () => {
        jar.values.set('__Host-redirect_url', '/org-invite/tok');

        await run('?return=/works/42');

        expect(authorizeMock).toHaveBeenCalledWith({ returnTo: '/works/42' });
    });

    it('a session check that fails outright reads as signed out', async () => {
        signedInMock.mockRejectedValue(new Error('profile check failed'));

        expectRedirect(await run(), PROVIDER_URL);
    });
});

describe('GET /api/auth/ever-id/start — on, signed in: straight to the destination', () => {
    beforeEach(() => {
        setUp();
        signedInMock.mockResolvedValue({ id: 'u1', email: 'alice@example.com', username: 'alice' });
    });
    afterEach(tearDown);

    function expectNoAuthorization() {
        expect(authorizeMock).not.toHaveBeenCalled();
        expect(jar.values.has('__Host-ew_everid_txn')).toBe(false);
        expect(jar.values.has('__Host-ew_everid_intent')).toBe(false);
    }

    it('lands on the normal post-sign-in page when the link names no path', async () => {
        expectRedirect(await run(), '/');
        expectNoAuthorization();
    });

    it('lands on the return path when it is a path of this site', async () => {
        expectRedirect(await run('?return=/works/42'), '/works/42');
        expectNoAuthorization();
    });

    it('keeps the query of the return path', async () => {
        const handoff = '/new?type=app&blueprint=my-app&ever_org=acme';

        expectRedirect(await run(`?return=${encodeURIComponent(handoff)}`), handoff);
    });

    it.each([
        ['an absolute URL', 'https://evil.example/phish'],
        ['a protocol-relative URL', '//evil.example'],
        ['a backslash', '/\\evil.example'],
        ['an encoded `//`', '/%2Fevil.example'],
        ['a double-encoded `//`', '/%252Fevil.example'],
        ['an encoded backslash', '/%5Cevil.example'],
        ['a tab', '/\t/evil.example'],
        ['an encoded line break', '/%0d%0aSet-Cookie:%20a=b'],
        ['a dot segment', '/works/../../evil.example'],
    ])('never leaves the site for %s: the normal page instead', async (_label, value) => {
        const response = await run(`?return=${encodeURIComponent(value)}`);

        expectRedirect(response, '/');
        expect(new URL(response.headers.get('Location')!, 'https://app.example').origin).toBe(
            'https://app.example',
        );
        expectNoAuthorization();
    });

    it('does not use the destination stored for a sign-in: nobody is signing in', async () => {
        jar.values.set('__Host-redirect_url', '/org-invite/tok');

        expectRedirect(await run(), '/');
        expect(jar.values.get('__Host-redirect_url')).toBe('/org-invite/tok');
    });
});

describe('GET /api/auth/ever-id/start — only a person following a link starts anything', () => {
    beforeEach(() => setUp());
    afterEach(tearDown);

    it.each([
        ['an image', { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' }],
        ['a script', { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
        ['a fetch', { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
        ['a frame', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }],
        ['a prefetch', { ...NAVIGATION, 'Sec-Purpose': 'prefetch' }],
    ])('%s loaded by another page → 404, nothing started', async (_label, headers) => {
        expectNotFound(await run('', { headers }));

        expect(availabilityMock).not.toHaveBeenCalled();
    });

    it('a HEAD request → 404, nothing started', async () => {
        expectNotFound(await run('', { method: 'HEAD', headers: {} }));
    });

    it('a client that sends no fetch metadata is served', async () => {
        expectRedirect(await run('', { headers: {} }), PROVIDER_URL);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)(
        '%s → the 404 of a path that does not exist, switch on or off',
        async (method) => {
            const route = await import('./route');
            expectNotFound(await route[method]());

            process.env.EVER_ID_START_ROUTE_ENABLED = 'false';
            expectNotFound(await route[method]());

            expect(availabilityMock).not.toHaveBeenCalled();
            expect(signedInMock).not.toHaveBeenCalled();
        },
    );

    it('answers no method with a 405 or an Allow list: only GET does anything', async () => {
        const route = await import('./route');

        // Next answers 405 for a method a route does not export, and lists the
        // exported ones for OPTIONS: both would tell the route is here.
        expect(Object.keys(route).sort()).toEqual([
            'DELETE',
            'GET',
            'OPTIONS',
            'PATCH',
            'POST',
            'PUT',
            'dynamic',
        ]);
    });

    it('is answered per request, never from a build or a cache', async () => {
        const route = await import('./route');

        expect(route.dynamic).toBe('force-dynamic');
    });
});

describe('GET /api/auth/ever-id/start — when the sign-in cannot start', () => {
    beforeEach(() => setUp());
    afterEach(tearDown);

    async function refusal(status: number, code: string | null, retryAfter: number | null = null) {
        const { EverIdRequestError } = await import('@/lib/api/ever-id');
        return new EverIdRequestError(status, code, retryAfter);
    }

    function expectErrorPage(response: Response, error: string) {
        expect(response.status).toBe(307);
        const url = new URL(response.headers.get('Location')!, 'https://app.example');
        expect(url.origin).toBe('https://app.example');
        expect(url.pathname).toBe('/auth/error');
        expect(url.searchParams.get('error')).toBe(error);
        expectRouteHeaders(response);
        expect(jar.values.size).toBe(0);
        return url;
    }

    it('the API’s rate limit on authorize applies: the error page, with the wait', async () => {
        authorizeMock.mockRejectedValue(await refusal(429, null, 25));

        const url = expectErrorPage(await run('?return=/works/42'), 'ever_id_rate_limited');

        expect(url.searchParams.get('retryAfter')).toBe('25');
        // A code and a wait, and nothing of the request.
        expect([...url.searchParams.keys()].sort()).toEqual(['error', 'retryAfter']);
    });

    it('the provider not responding → the error page', async () => {
        authorizeMock.mockRejectedValue(await refusal(503, 'provider_unavailable'));

        expectErrorPage(await run(), 'ever_id_provider_unavailable');
    });

    it('an unreachable API → the error page', async () => {
        authorizeMock.mockRejectedValue(new TypeError('fetch failed'));

        expectErrorPage(await run(), 'ever_id_provider_unavailable');
    });

    it.each([
        ['no address', { transaction: TRANSACTION }],
        ['a relative address', { authorizationUrl: '/authorize', transaction: TRANSACTION }],
        ['a script address', { authorizationUrl: 'javascript:alert(1)', transaction: TRANSACTION }],
    ])('an answer with %s is not followed', async (_label, answer) => {
        authorizeMock.mockResolvedValue(answer);

        expectErrorPage(await run(), 'ever_id_provider_unavailable');
    });

    it('a transaction too large for a cookie is not half-started', async () => {
        authorizeMock.mockResolvedValue({
            authorizationUrl: PROVIDER_URL,
            transaction: 'x'.repeat(4_001),
        });

        expectErrorPage(await run(), 'ever_id_provider_unavailable');
        // Refused by the flow's own cookie module, before anything was written.
        expect(console.error).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ name: 'EverIdCookieTooLargeError' }),
        );
    });

    it('logs a refusal as its status and code, never the answer’s body', async () => {
        const { EverIdRequestError } = await import('@/lib/api/ever-id');
        authorizeMock.mockRejectedValue(
            new EverIdRequestError(429, null, 25, { message: 'BODY-TEXT', echoed: '/works/42' }),
        );

        await run('?return=/works/42');

        expect(console.error).toHaveBeenCalledTimes(1);
        const logged = vi.mocked(console.error).mock.calls[0];
        expect(logged).toEqual([
            'Ever ID sign-in could not start:',
            'Ever ID request failed with status 429',
        ]);
        expect(JSON.stringify(logged)).not.toContain('BODY-TEXT');
    });
});

describe('GET /api/auth/ever-id/start — its headers', () => {
    beforeEach(() => setUp());
    afterEach(tearDown);

    // `apps/web`, from `src/app/api/auth/ever-id/start`.
    const webRoot = join(__dirname, '..', '..', '..', '..', '..', '..');

    it('carries the Referrer-Policy the app serves the sign-in page with', async () => {
        const policy = (await run()).headers.get('Referrer-Policy');

        // The route cannot import the value (it lives in the build config and
        // in the proxy), so this fails the day either of them changes.
        expect(readFileSync(join(webRoot, 'next.config.ts'), 'utf8')).toContain(
            `{ key: 'Referrer-Policy', value: '${policy}' }`,
        );
        expect(readFileSync(join(webRoot, 'src', 'proxy.ts'), 'utf8')).toContain(
            `'Referrer-Policy': '${policy}'`,
        );
    });

    it('sends the provider address as a valid header value', async () => {
        authorizeMock.mockResolvedValue({
            authorizationUrl: 'HTTPS://ID.example/authorize?state=a b\n&next=1',
            transaction: TRANSACTION,
        });

        const location = (await run()).headers.get('Location')!;

        expect(location).toBe('https://id.example/authorize?state=a%20b&next=1');
        expect(location).not.toMatch(/\s/);
    });
});

describe('GET /api/auth/ever-id/start — nothing secret in an address', () => {
    beforeEach(() => setUp());
    afterEach(tearDown);

    it('the only off-site address is the provider’s own, and the transaction is in none', async () => {
        const signedOut = await run('?return=/works/42');
        expect(signedOut.headers.get('Location')).toBe(PROVIDER_URL);
        expect(signedOut.headers.get('Location')).not.toContain(TRANSACTION);

        signedInMock.mockResolvedValue({ id: 'u1' });
        const signedIn = await run('?return=/works/42');
        expect(signedIn.headers.get('Location')).toBe('/works/42');
    });

    it('the route reuses the flow’s own pieces and gains no token hand-off', () => {
        const source = readFileSync(join(__dirname, 'route.ts'), 'utf8');
        expect(source).toMatch(/everIdAPI\.authorize\(/);
        expect(source).toMatch(/setEverIdTransaction\(/);
        expect(source).not.toMatch(/addSessionTokenToUrl/);
        expect(source).not.toMatch(/getRedirectUrl/);
        expect(source).not.toMatch(/setAuthCookies/);
        expect(source).not.toMatch(/request\.url\b/);
    });
});
