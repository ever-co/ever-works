import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEMO_CONFIG_FAILURE_TTL_MS,
    DEMO_CONFIG_TTL_MS,
    getDemoConfig,
    resetDemoConfigCacheForTests,
} from './demo';

/**
 * The demo config's in-process cache. Outside a render (a route handler such as the chat
 * turn, a server action) `React.cache` passes every call through, so without it each chat
 * message re-read `GET /api/config`, production included. An API answer is kept for
 * `DEMO_CONFIG_TTL_MS` (about a minute, the endpoint's own `max-age`); a failure ("not a demo")
 * only for `DEMO_CONFIG_FAILURE_TTL_MS`, so an API blip cannot pin the wrong answer.
 */

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const DEMO_ON_BODY = {
    features: { demoMode: true },
    demo: { signUpUrl: 'https://example.test/register', sandboxTtlHours: 12 },
};
const DEMO_ON = { enabled: true, signUpUrl: 'https://example.test/register', sandboxTtlHours: 12 };
const DEMO_OFF = {
    enabled: false,
    signUpUrl: 'https://app.ever.works/register',
    sandboxTtlHours: 24,
};

const T0 = new Date('2026-11-21T10:00:00.000Z').getTime();

describe('getDemoConfig: the in-process cache', () => {
    beforeEach(() => {
        resetDemoConfigCacheForTests();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        // A web without its own DEMO hint: the hinted web has `demo.hint.unit.spec.ts`.
        vi.stubEnv('DEMO', '');
        // Only the clock: the fetch's own `AbortSignal.timeout` keeps real timers.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('keeps an answer for about a minute, and a failure for at most ~10 s', () => {
        expect(DEMO_CONFIG_TTL_MS).toBeGreaterThanOrEqual(30_000);
        expect(DEMO_CONFIG_TTL_MS).toBeLessThanOrEqual(60_000);
        expect(DEMO_CONFIG_FAILURE_TTL_MS).toBeLessThanOrEqual(10_000);
        expect(DEMO_CONFIG_FAILURE_TTL_MS).toBeLessThan(DEMO_CONFIG_TTL_MS);
    });

    it('two reads within the TTL make one fetch', async () => {
        fetchMock.mockResolvedValue(jsonResponse(DEMO_ON_BODY));

        await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);
        vi.setSystemTime(T0 + DEMO_CONFIG_TTL_MS - 1);
        await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads the API again once the TTL is over', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY))
            .mockResolvedValueOnce(jsonResponse({ features: { demoMode: false }, demo: null }));

        await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);
        vi.setSystemTime(T0 + DEMO_CONFIG_TTL_MS);
        await expect(getDemoConfig()).resolves.toEqual(DEMO_OFF);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a failure soon: an API blip does not pin "not a demo" for the full TTL', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY));

        await expect(getDemoConfig()).resolves.toEqual(DEMO_OFF);
        vi.setSystemTime(T0 + DEMO_CONFIG_FAILURE_TTL_MS);
        await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['a non-200', () => fetchMock.mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY, 503))],
        [
            'a timeout',
            () => fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError')),
        ],
        [
            'a body that is not JSON',
            () =>
                fetchMock.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => {
                        throw new SyntaxError('bad json');
                    },
                }),
        ],
    ])('treats %s as a short-lived failure', async (_label, fail) => {
        fail();
        fetchMock.mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY));

        await expect(getDemoConfig()).resolves.toEqual(DEMO_OFF);
        vi.setSystemTime(T0 + DEMO_CONFIG_FAILURE_TTL_MS);
        await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);
    });

    it('shares one fetch between reads that start while it is in flight', async () => {
        let answer!: (value: unknown) => void;
        fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

        const first = getDemoConfig();
        const second = getDemoConfig();
        answer(jsonResponse(DEMO_ON_BODY));

        await expect(Promise.all([first, second])).resolves.toEqual([DEMO_ON, DEMO_ON]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('demo off: the same answer as before, read once per TTL instead of once per call', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ features: { demoMode: false }, demo: null }));

        for (let call = 0; call < 5; call++) {
            vi.setSystemTime(T0 + call * 1_000);
            await expect(getDemoConfig()).resolves.toEqual(DEMO_OFF);
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/\/config$/),
            expect.objectContaining({ cache: 'no-store' }),
        );
    });
});
