import { describe, it, expect, vi, beforeEach } from 'vitest';
import superjson from 'superjson';

const { triggerConfig, demoConfig } = vi.hoisted(() => ({
    triggerConfig: {
        getInternalBaseUrl: vi.fn(),
        getInternalSecret: vi.fn(),
        getInternalRequestTimeoutMs: vi.fn(),
    },
    demoConfig: { isEnabled: vi.fn() },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: { trigger: triggerConfig, demo: demoConfig },
}));

import { TriggerInternalApiClient } from '../trigger/worker/services/trigger-internal-api.client';
import { createRemoteProxy } from '../trigger/worker/remote-proxy';

/**
 * Platform demo mode — the worker half of the DEMO drift handshake.
 *
 * A worker whose own `DEMO` is on says so on every call to the API's internal channel
 * (`x-ever-works-demo: 1`), so a demo API can refuse a worker that lacks it (its
 * environment would make unmetered AI calls and unledgered repository creates). With
 * `DEMO` off the worker sends exactly the headers it always sent.
 */

const DEMO_HEADER = 'x-ever-works-demo';

const okJsonResponse = (body: unknown): Response =>
    ({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
    }) as unknown as Response;

describe('TriggerInternalApiClient — demo handshake header', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com/');
        triggerConfig.getInternalSecret.mockReturnValue('secret-1');
        triggerConfig.getInternalRequestTimeoutMs.mockReturnValue(45000);
        demoConfig.isEnabled.mockReturnValue(false);

        fetchSpy = vi.fn();
        // @ts-expect-error - install fetch on global
        globalThis.fetch = fetchSpy;
    });

    const headersOf = (call: number): Record<string, string> =>
        fetchSpy.mock.calls[call][1].headers as Record<string, string>;

    it('sends x-ever-works-demo: 1 on remote/call when the worker runs with DEMO on', async () => {
        demoConfig.isEnabled.mockReturnValue(true);
        fetchSpy.mockResolvedValueOnce(okJsonResponse({ result: superjson.serialize('ok') }));

        const proxy = createRemoteProxy(new TriggerInternalApiClient(), 'DemoAiQuotaService');
        await proxy.consume({ userId: 'u1' });

        expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/remote/call');
        expect(headersOf(0)).toEqual({
            'content-type': 'application/json',
            'x-trigger-secret': 'secret-1',
            [DEMO_HEADER]: '1',
        });
    });

    it('sends it on the work-context read too (every internal route)', async () => {
        demoConfig.isEnabled.mockReturnValue(true);
        fetchSpy.mockResolvedValueOnce(okJsonResponse({ work: { id: 'w1' }, user: { id: 'u1' } }));

        await new TriggerInternalApiClient().fetchWorkContext('w1', 'u1');

        expect(headersOf(0)[DEMO_HEADER]).toBe('1');
    });

    it('demo off: sends no demo header, only the headers it always sent', async () => {
        fetchSpy
            .mockResolvedValueOnce(okJsonResponse({ result: superjson.serialize('ok') }))
            .mockResolvedValueOnce(okJsonResponse({ work: { id: 'w1' }, user: { id: 'u1' } }));
        const client = new TriggerInternalApiClient();

        await client.callRemote('WorkRepository', 'findById', superjson.serialize(['w1']));
        await client.fetchWorkContext('w1', 'u1');

        for (const call of [0, 1]) {
            expect(headersOf(call)).toEqual({
                'content-type': 'application/json',
                'x-trigger-secret': 'secret-1',
            });
            expect(headersOf(call)).not.toHaveProperty(DEMO_HEADER);
        }
    });

    it("surfaces a demo API's refusal of a header-less call as a clear, non-retried error", async () => {
        // What the API answers a worker that lacks `DEMO=true` (see the controller spec).
        fetchSpy.mockResolvedValue({
            ok: false,
            status: 409,
            text: () =>
                Promise.resolve(
                    JSON.stringify({
                        statusCode: 409,
                        error: 'Conflict',
                        code: 'DEMO_WORKER_MISMATCH',
                        message:
                            'This API runs in demo mode (DEMO=true) but the calling Trigger.dev worker does not.',
                    }),
                ),
        } as unknown as Response);

        await expect(
            // A retry-safe read: a 4xx is still answered once, never re-issued.
            new TriggerInternalApiClient().callRemote(
                'WorkRepository',
                'findById',
                superjson.serialize(['w1']),
            ),
        ).rejects.toThrow(/\(409\).*DEMO_WORKER_MISMATCH/);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
