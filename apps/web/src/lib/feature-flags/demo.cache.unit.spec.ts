import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R42 b: one request asks for the demo config from several places (the login page, the
 * session check, the dashboard strip, the expiry redirect). Wrapped in `React.cache`, a
 * server render reads `GET /api/config` once. Outside a server render React's `cache` passes
 * the call through, so this file stands in a memoising `cache` to see the wrapping.
 */
const cacheMock = vi.hoisted(() =>
    vi.fn(<T extends (...args: never[]) => unknown>(fn: T): T => {
        let memo: { value: unknown } | undefined;
        return ((...args: never[]) => {
            memo ??= { value: fn(...args) };
            return memo.value;
        }) as T;
    }),
);

vi.mock('react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react')>()),
    cache: cacheMock,
}));

import { getDemoConfig } from './demo';

describe('getDemoConfig under React.cache', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('is wrapped in React.cache, so a render reads GET /api/config once', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ features: { demoMode: false }, demo: null }),
        });

        // (`cacheMock` ran when `./demo` was imported; Vitest clears call history per test.)
        const [first, second] = await Promise.all([getDemoConfig(), getDemoConfig()]);

        expect(first).toEqual(second);
        expect(first.enabled).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
