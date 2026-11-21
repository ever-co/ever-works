import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MAX_FAILED_POLLS, type WorkStatusResult } from './generation-console';
import { useGenerationConsole, type FetchWorkStatus } from './use-generation-console';

const WORK = { id: 'w-1', slug: 'ai-robots', name: 'AI robots directory' };
const BASE_MS = 1_000;

/** Renders the hook and walks it into a running generation, as the step does. */
function startRun(fetchStatus: FetchWorkStatus) {
    const hook = renderHook(() => useGenerationConsole({ fetchStatus, pollIntervalMs: BASE_MS }));
    act(() => {
        hook.result.current.start();
        hook.result.current.started(WORK);
    });
    return hook;
}

const generating: WorkStatusResult = { ok: true, status: { status: 'generating' } as never };

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useGenerationConsole — polling the Work status', () => {
    it('polls at the base rate while the run goes on', async () => {
        const fetchStatus = vi.fn<FetchWorkStatus>().mockResolvedValue(generating);
        startRun(fetchStatus);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(1);
        expect(fetchStatus).toHaveBeenCalledWith('w-1');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(BASE_MS * 3);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(4);
    });

    it.each(['unauthenticated', 'not-found'] as const)(
        'stops for good on %s and says so',
        async (reason) => {
            const fetchStatus = vi.fn<FetchWorkStatus>().mockResolvedValue({ ok: false, reason });
            const { result } = startRun(fetchStatus);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(result.current.state.phase).toBe('lost');
            expect(result.current.state.stopReason).toBe(reason);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });
            expect(fetchStatus).toHaveBeenCalledTimes(1);
        },
    );

    it('backs off on errors, then stops after too many in a row', async () => {
        const fetchStatus = vi
            .fn<FetchWorkStatus>()
            .mockResolvedValue({ ok: false, reason: 'error' });
        const { result } = startRun(fetchStatus);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        // Failures 1 and 2 retry at the base rate…
        await act(async () => {
            await vi.advanceTimersByTimeAsync(BASE_MS * 2);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(3);
        // …the third waits twice as long.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(BASE_MS);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(3);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(BASE_MS);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(4);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10 * 60_000);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(MAX_FAILED_POLLS);
        expect(result.current.state.phase).toBe('lost');
        expect(result.current.state.stopReason).toBe('unreachable');
    });

    it('treats a thrown read like a failed one', async () => {
        const fetchStatus = vi
            .fn<FetchWorkStatus>()
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValue(generating);
        const { result } = startRun(fetchStatus);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.state.failedPolls).toBe(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(BASE_MS);
        });
        expect(result.current.state.failedPolls).toBe(0);
        expect(result.current.state.phase).toBe('generating');
    });

    it('stops when the run ends', async () => {
        const fetchStatus = vi
            .fn<FetchWorkStatus>()
            .mockResolvedValue({ ok: true, status: { status: 'generated' } as never });
        const { result } = startRun(fetchStatus);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.state.phase).toBe('generated');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(1);
    });

    it('stops when the console unmounts', async () => {
        const fetchStatus = vi.fn<FetchWorkStatus>().mockResolvedValue(generating);
        const { unmount } = startRun(fetchStatus);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(fetchStatus).toHaveBeenCalledTimes(1);
    });
});
