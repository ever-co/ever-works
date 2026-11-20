import {
    DEMO_AI_QUOTA,
    DEMO_AI_RATE_WAIT_BUDGET_MS,
    DemoQuotaExceededError,
    DemoRateLimitedError,
    consumeDemoAiQuota,
    type DemoAiQuotaPort,
} from '..';

/**
 * Platform demo mode — how a call waits for the demo's AI quota. Background
 * work waits out a busy minute (bounded); interactive work is told at once.
 */
describe('consumeDemoAiQuota', () => {
    const port = (consume: jest.Mock): DemoAiQuotaPort => ({ consume });

    it('exposes a stable injection token', () => {
        expect(DEMO_AI_QUOTA).toBe('DEMO_AI_QUOTA');
    });

    it('consumes once with the user id', async () => {
        const consume = jest.fn().mockResolvedValue(undefined);
        const sleep = jest.fn();

        await consumeDemoAiQuota(port(consume), 'u1', 'background', sleep);

        expect(consume).toHaveBeenCalledTimes(1);
        expect(consume).toHaveBeenCalledWith('u1');
        expect(sleep).not.toHaveBeenCalled();
    });

    it('background: waits retryAfterMs and retries until the quota answers', async () => {
        const consume = jest
            .fn()
            .mockRejectedValueOnce(new DemoRateLimitedError(1200))
            .mockRejectedValueOnce(new DemoRateLimitedError(800))
            .mockResolvedValue(undefined);
        const sleep = jest.fn().mockResolvedValue(undefined);

        await consumeDemoAiQuota(port(consume), 'u1', 'background', sleep);

        expect(consume).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls).toEqual([[1200], [800]]);
    });

    it('background: stops after 60 s of waiting in total and rethrows the last error', async () => {
        const last = new DemoRateLimitedError(25_000);
        const consume = jest
            .fn()
            .mockRejectedValueOnce(new DemoRateLimitedError(25_000))
            .mockRejectedValueOnce(new DemoRateLimitedError(25_000))
            .mockRejectedValueOnce(new DemoRateLimitedError(25_000))
            .mockRejectedValueOnce(last);
        const sleep = jest.fn().mockResolvedValue(undefined);

        await expect(consumeDemoAiQuota(port(consume), 'u1', 'background', sleep)).rejects.toBe(
            last,
        );

        const waited = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
        expect(waited).toBe(DEMO_AI_RATE_WAIT_BUDGET_MS);
        expect(DEMO_AI_RATE_WAIT_BUDGET_MS).toBe(60_000);
        // 25 s + 25 s + the 10 s left, then the fourth refusal is final.
        expect(sleep.mock.calls).toEqual([[25_000], [25_000], [10_000]]);
        expect(consume).toHaveBeenCalledTimes(4);
    });

    it('background: a zero or invalid retryAfterMs still waits, so the loop ends', async () => {
        const consume = jest.fn().mockRejectedValue(new DemoRateLimitedError(0));
        const sleep = jest.fn().mockResolvedValue(undefined);

        await expect(
            consumeDemoAiQuota(port(consume), 'u1', 'background', sleep),
        ).rejects.toBeInstanceOf(DemoRateLimitedError);

        expect(sleep.mock.calls.every(([ms]) => ms > 0)).toBe(true);
        const waited = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
        expect(waited).toBe(DEMO_AI_RATE_WAIT_BUDGET_MS);
    });

    it('background: a used-up quota is final, no wait', async () => {
        const consume = jest.fn().mockRejectedValue(new DemoQuotaExceededError('day'));
        const sleep = jest.fn();

        await expect(
            consumeDemoAiQuota(port(consume), 'u1', 'background', sleep),
        ).rejects.toBeInstanceOf(DemoQuotaExceededError);

        expect(consume).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('interactive: a busy minute is rethrown at once', async () => {
        const busy = new DemoRateLimitedError(50);
        const consume = jest.fn().mockRejectedValue(busy);
        const sleep = jest.fn();

        await expect(consumeDemoAiQuota(port(consume), 'u1', 'interactive', sleep)).rejects.toBe(
            busy,
        );

        expect(consume).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('recognises a busy error carried by code (a remote proxy rebuilt it)', async () => {
        const remote = Object.assign(new Error('busy'), {
            code: 'DEMO_AI_BUSY',
            retryAfterMs: 300,
        });
        const consume = jest.fn().mockRejectedValueOnce(remote).mockResolvedValue(undefined);
        const sleep = jest.fn().mockResolvedValue(undefined);

        await consumeDemoAiQuota(port(consume), 'u1', 'background', sleep);

        expect(sleep).toHaveBeenCalledWith(300);
        expect(consume).toHaveBeenCalledTimes(2);
    });
});
