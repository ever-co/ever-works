'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { GenerateStatusType } from '@/lib/api/enums';
import {
    INITIAL_CONSOLE_STATE,
    consoleReducer,
    isTerminalPhase,
    MAX_FAILED_POLLS,
    nextPollDelay,
    type WorkStatusResult,
} from './generation-console';

/**
 * Reads a Work's current `generateStatus`, or why it could not be read. An
 * empty status (`{}`) means the job is still queued.
 */
export type FetchWorkStatus = (workId: string) => Promise<WorkStatusResult>;

/**
 * The same source the Work page polls (`GET /api/works/:id`), through
 * `getWorkGenerationStatusAction`, which tells an ended session and a missing
 * Work apart from a transient error. Loaded on demand so this module stays
 * importable where server actions are not.
 */
export const fetchWorkStatusFromApi: FetchWorkStatus = async (workId) => {
    const { getWorkGenerationStatusAction } =
        await import('@/app/actions/onboarding/generation-status');
    return getWorkGenerationStatusAction(workId);
};

export interface UseGenerationConsoleOptions {
    readonly fetchStatus: FetchWorkStatus;
    /** The Work page polls every 5 s; the console is the only thing on screen, so 3 s. */
    readonly pollIntervalMs?: number;
}

const FINAL_STATUSES: ReadonlySet<string> = new Set([
    GenerateStatusType.GENERATED,
    GenerateStatusType.ERROR,
    GenerateStatusType.CANCELLED,
]);

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

    // One read at a time, each scheduled after the last one answered: at the
    // base rate while reads succeed, backing off while they fail. An ended
    // session or a missing Work stops the reads for good; so does the run
    // ending (the phase leaves `generating`) and unmounting.
    useEffect(() => {
        if (!polling || !workId) return;
        let cancelled = false;
        let timer: number | undefined;
        let failures = 0;

        const tick = async () => {
            let result: WorkStatusResult;
            try {
                result = await fetchRef.current(workId);
            } catch {
                result = { ok: false, reason: 'error' };
            }
            if (cancelled) return;

            // The chain also ends on its own (a final status, the last allowed
            // failure) rather than only when the reducer's new phase re-renders.
            if (result.ok) {
                failures = 0;
                dispatch({ type: 'status', status: result.status, at: nowIso() });
                if (result.status.status && FINAL_STATUSES.has(result.status.status)) return;
            } else if (result.reason === 'error') {
                failures += 1;
                dispatch({ type: 'pollFailed', at: nowIso() });
                if (failures >= MAX_FAILED_POLLS) return;
            } else {
                dispatch({ type: 'pollStopped', reason: result.reason, at: nowIso() });
                return;
            }
            timer = window.setTimeout(() => void tick(), nextPollDelay(failures, pollIntervalMs));
        };

        void tick();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
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
