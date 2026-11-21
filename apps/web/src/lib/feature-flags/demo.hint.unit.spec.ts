import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
    DEMO_CONFIG_BUDGET_MS,
    DEMO_CONFIG_FAILURE_TTL_MS,
    DEMO_CONFIG_RETRY_BUDGET_MS,
    DEMO_CONFIG_TTL_MS,
    getDemoConfig,
    resetDemoConfigCacheForTests,
} from './demo';

/**
 * The web's own `DEMO` hint. A demo web runs with `DEMO=true` in its environment too. There a
 * failed or slow `GET /api/config` (the demo API is one replica on SQLite and now and then takes
 * longer than the 1.5 s budget) must not turn into "not a demo": that showed the normal login
 * form on about 1 render in 10. A hinted web retries once with a longer budget, then falls back
 * to the last good answer, else the code defaults with `enabled: true`. A web without the hint
 * (production) still fails closed after one try, exactly as before.
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
/** The code defaults a hinted web falls back to with no good answer yet. */
const HINT_DEFAULTS = {
    enabled: true,
    signUpUrl: 'https://app.ever.works/register',
    sandboxTtlHours: 24,
};
const NOT_A_DEMO = {
    enabled: false,
    signUpUrl: 'https://app.ever.works/register',
    sandboxTtlHours: 24,
};

/** A fetch that never answers: it rejects only when its deadline aborts it. */
function hangsUntilAborted(_url: string, init: { signal: AbortSignal }) {
    return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
}

const T0 = new Date('2026-11-21T10:00:00.000Z').getTime();

describe('getDemoConfig: the web-side DEMO hint', () => {
    let timeoutSpy: MockInstance<typeof AbortSignal.timeout>;

    beforeEach(() => {
        resetDemoConfigCacheForTests();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        vi.stubEnv('DEMO', '');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        // Real deadlines, a hundred times shorter, so a hanging API costs milliseconds here.
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        timeoutSpy = vi
            .spyOn(AbortSignal, 'timeout')
            .mockImplementation((ms: number) => realTimeout(Math.max(1, Math.round(ms / 100))));
    });
    afterEach(() => {
        timeoutSpy.mockRestore();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('retries once with a longer budget (~3 s) after the 1.5 s one', () => {
        expect(DEMO_CONFIG_BUDGET_MS).toBe(1500);
        expect(DEMO_CONFIG_RETRY_BUDGET_MS).toBeGreaterThan(DEMO_CONFIG_BUDGET_MS);
        expect(DEMO_CONFIG_RETRY_BUDGET_MS).toBeLessThanOrEqual(3000);
    });

    describe('a hinted web (DEMO=true in its own environment)', () => {
        beforeEach(() => vi.stubEnv('DEMO', 'true'));

        it('shows the demo, with the default sign-up URL and TTL, when the API fails twice', async () => {
            fetchMock.mockRejectedValue(new TypeError('fetch failed'));

            await expect(getDemoConfig()).resolves.toEqual(HINT_DEFAULTS);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('shows the demo when the API is too slow for both budgets', async () => {
            fetchMock.mockImplementation(hangsUntilAborted);

            await expect(getDemoConfig()).resolves.toEqual(HINT_DEFAULTS);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([
                DEMO_CONFIG_BUDGET_MS,
                DEMO_CONFIG_RETRY_BUDGET_MS,
            ]);
        });

        it('takes the retry when the first read is slow and the second answers', async () => {
            fetchMock
                .mockImplementationOnce(hangsUntilAborted)
                .mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY));

            await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it.each([
            ['a non-200', () => fetchMock.mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY, 503))],
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
        ])('retries after %s too', async (_label, failOnce) => {
            failOnce();
            fetchMock.mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY));

            await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('falls back to the last good answer, not the defaults, once it has one', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY));
            await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);

            vi.setSystemTime(T0 + DEMO_CONFIG_TTL_MS);
            fetchMock.mockRejectedValue(new TypeError('fetch failed'));

            await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('keeps the fallback only briefly: the API is read again after the failure TTL', async () => {
            fetchMock
                .mockRejectedValueOnce(new TypeError('fetch failed'))
                .mockRejectedValueOnce(new TypeError('fetch failed'))
                .mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY));

            await expect(getDemoConfig()).resolves.toEqual(HINT_DEFAULTS);
            vi.setSystemTime(T0 + DEMO_CONFIG_FAILURE_TTL_MS);
            await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);
        });

        it('trusts an API answer: a 200 that says demoMode false is not a demo', async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ features: { demoMode: false }, demo: null }),
            );

            await expect(getDemoConfig()).resolves.toEqual(NOT_A_DEMO);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it.each(['true', '1', 'yes', ' YES ', 'True'])(
            'reads DEMO=%j as the hint',
            async (value) => {
                vi.stubEnv('DEMO', value);
                fetchMock.mockRejectedValue(new TypeError('fetch failed'));

                expect((await getDemoConfig()).enabled).toBe(true);
            },
        );
    });

    describe('an un-hinted web (DEMO unset: production)', () => {
        it('fails closed after ONE read, exactly as before: not a demo, no retry', async () => {
            fetchMock.mockRejectedValue(new TypeError('fetch failed'));

            await expect(getDemoConfig()).resolves.toEqual(NOT_A_DEMO);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([DEMO_CONFIG_BUDGET_MS]);
        });

        it('fails closed on a slow API within the one 1.5 s budget', async () => {
            fetchMock.mockImplementation(hangsUntilAborted);

            await expect(getDemoConfig()).resolves.toEqual(NOT_A_DEMO);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does not fall back to an earlier demo answer either', async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse(DEMO_ON_BODY));
            await expect(getDemoConfig()).resolves.toEqual(DEMO_ON);

            vi.setSystemTime(T0 + DEMO_CONFIG_TTL_MS);
            fetchMock.mockRejectedValue(new TypeError('fetch failed'));

            await expect(getDemoConfig()).resolves.toEqual(NOT_A_DEMO);
        });

        it.each(['', 'false', '0', 'no', 'off'])(
            'does not read DEMO=%j as the hint',
            async (value) => {
                vi.stubEnv('DEMO', value);
                fetchMock.mockRejectedValue(new TypeError('fetch failed'));

                await expect(getDemoConfig()).resolves.toEqual(NOT_A_DEMO);
                expect(fetchMock).toHaveBeenCalledTimes(1);
            },
        );
    });
});
