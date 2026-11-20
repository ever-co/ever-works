import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDemoConfig } from './demo';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('getDemoConfig', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('is enabled with the API numbers when features.demoMode is true', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                features: { demoMode: true },
                demo: { signUpUrl: 'https://example.test/register', sandboxTtlHours: 12 },
            }),
        );
        await expect(getDemoConfig()).resolves.toEqual({
            enabled: true,
            signUpUrl: 'https://example.test/register',
            sandboxTtlHours: 12,
        });
    });

    it('falls back to the defaults when the demo block is missing or malformed', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ features: { demoMode: true }, demo: { sandboxTtlHours: 'x' } }),
        );
        await expect(getDemoConfig()).resolves.toEqual({
            enabled: true,
            signUpUrl: 'https://app.ever.works/register',
            sandboxTtlHours: 24,
        });
    });

    it('is disabled when demoMode is false or absent', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ features: { demoMode: false }, demo: null }));
        expect((await getDemoConfig()).enabled).toBe(false);
        fetchMock.mockResolvedValue(jsonResponse({ features: {} }));
        expect((await getDemoConfig()).enabled).toBe(false);
    });

    it('fails closed on a fetch error (unreachable or timeout)', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));
        expect((await getDemoConfig()).enabled).toBe(false);
        fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
        expect((await getDemoConfig()).enabled).toBe(false);
    });

    it('fails closed on a non-200 and on a body that is not JSON', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ features: { demoMode: true } }, 500));
        expect((await getDemoConfig()).enabled).toBe(false);
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError('bad json');
            },
        });
        expect((await getDemoConfig()).enabled).toBe(false);
    });
});
