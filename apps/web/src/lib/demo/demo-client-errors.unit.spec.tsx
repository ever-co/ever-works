import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});

import { DemoErrorToaster } from '@/components/demo/DemoErrorToaster';
import { browserApiFetch } from '@/lib/api/browser-api';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('demo errors on browser fetches', () => {
    beforeEach(() => toastError.mockReset());
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it.each([
        [429, 'DEMO_AI_BUSY', 'The demo AI is busy — try again in a few seconds'],
        [
            429,
            'DEMO_AI_QUOTA',
            'The free demo AI quota is used up for today — sign up on app.ever.works to keep going',
        ],
        [403, 'DEMO_DISABLED', 'Not available in the demo — sign up to use it'],
        [
            503,
            'DEMO_MODEL_UNAVAILABLE',
            'The demo AI model is temporarily unavailable — please try again later',
        ],
    ])(
        '%i %s toasts the friendly message and hands the caller the untouched response',
        async (status, code, message) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => json(status, { statusCode: status, code, message: 'raw' })),
            );
            render(<DemoErrorToaster />);

            const res = await browserApiFetch('/api/works/w1/kb/search?q=x');
            await flush();

            expect(toastError).toHaveBeenCalledWith(
                message,
                expect.objectContaining({ id: expect.any(String) }),
            );
            expect(res.status).toBe(status);
            expect(await res.json()).toMatchObject({ code }); // body still readable by the caller
        },
    );

    it('demo off: other failures and successes toast nothing', async () => {
        render(<DemoErrorToaster />);
        for (const response of [
            json(429, { code: 'THROTTLED' }),
            json(503, { code: 'DEMO_FULL' }),
            json(500, { message: 'boom' }),
            json(200, { code: 'DEMO_AI_QUOTA' }),
        ]) {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => response),
            );
            await browserApiFetch('/api/x');
            await flush();
        }

        expect(toastError).not.toHaveBeenCalled();
    });
});
