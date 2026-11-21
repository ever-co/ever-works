'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import type { GenerateStatus } from '@/lib/api/types-only';
import { INITIAL_CONSOLE_STATE, consoleReducer, isTerminalPhase } from './generation-console';

/**
 * Reads a Work's current `generateStatus`. `null` when the Work could not be
 * read (a failed poll); `{}` when it has no status yet (the job is queued).
 */
export type FetchWorkStatus = (workId: string) => Promise<Partial<GenerateStatus> | null>;

/**
 * The status source the Work page itself polls (`WorkLayoutClient`):
 * `getWorkForStatusRefresh` → `GET /api/works/:id`. Loaded on demand so this
 * module stays importable where server actions are not.
 */
export const fetchWorkStatusFromApi: FetchWorkStatus = async (workId) => {
    const { getWorkForStatusRefresh } = await import('@/app/actions/dashboard/works');
    const work = await getWorkForStatusRefresh(workId);
    if (!work) return null;
    return work.generateStatus ?? {};
};

export interface UseGenerationConsoleOptions {
    readonly fetchStatus: FetchWorkStatus;
    /** The Work page polls every 5 s; the console is the only thing on screen, so 3 s. */
    readonly pollIntervalMs?: number;
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Console state for one onboarding run: the reducer, the status polling while
 * the generation runs, and a ticking clock for the header.
 */
export function useGenerationConsole({
    fetchStatus,
    pollIntervalMs = 3_000,
}: UseGenerationConsoleOptions) {
    const [state, dispatch] = useReducer(consoleReducer, INITIAL_CONSOLE_STATE);

    // Always call the latest fetcher without restarting the poll when a parent
    // passes a new function identity.
    const fetchRef = useRef(fetchStatus);
    useEffect(() => {
        fetchRef.current = fetchStatus;
    }, [fetchStatus]);

    const workId = state.work?.id;
    const polling = state.phase === 'generating' && Boolean(workId);

    useEffect(() => {
        if (!polling || !workId) return;
        let cancelled = false;
        let inFlight = false;

        const tick = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const status = await fetchRef.current(workId);
                if (cancelled) return;
                if (status) {
                    dispatch({ type: 'status', status, at: nowIso() });
                } else {
                    dispatch({ type: 'pollFailed', at: nowIso() });
                }
            } catch {
                if (!cancelled) dispatch({ type: 'pollFailed', at: nowIso() });
            } finally {
                inFlight = false;
            }
        };

        void tick();
        const interval = window.setInterval(() => void tick(), pollIntervalMs);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [polling, workId, pollIntervalMs]);

    // Header clock: ticks while the run is active, frozen once it ends.
    const active = state.phase === 'starting' || state.phase === 'generating';
    const [now, setNow] = useState(0);
    useEffect(() => {
        if (!active) return;
        const update = () => setNow(Date.now());
        const first = window.setTimeout(update, 0);
        const interval = window.setInterval(update, 1_000);
        return () => {
            window.clearTimeout(first);
            window.clearInterval(interval);
        };
    }, [active]);

    const startedMs = state.startedAt ? Date.parse(state.startedAt) : 0;
    const endedMs = state.endedAt ? Date.parse(state.endedAt) : undefined;
    const elapsedMs = startedMs ? (endedMs ?? Math.max(now, startedMs)) - startedMs : 0;

    return {
        state,
        elapsedMs,
        finished: isTerminalPhase(state.phase),
        start: () => dispatch({ type: 'start', at: nowIso() }),
        started: (work: { id: string; slug: string; name: string }) =>
            dispatch({ type: 'started', work, at: nowIso() }),
        startFailed: (message: string) => dispatch({ type: 'startFailed', message, at: nowIso() }),
    };
}
