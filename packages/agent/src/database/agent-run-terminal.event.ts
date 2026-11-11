/**
 * The in-process event `AgentRunRepository` raises after an `agent_runs` row
 * reaches a terminal status (completed / failed / cancelled), on every path
 * that writes one: the cloud worker's finalize, the fleet reconciler, the
 * heartbeat worker, a user cancel, a dispatch rollback and the stuck-run
 * sweeper (reaped or parked).
 *
 * Leaf file with no runtime imports, same posture as `run-cost-settler.ts`:
 * the repository lives in `DatabaseModule`, the listeners live in modules that
 * import it (an escalation listener in `AgentsModule` today), so a direct
 * injection would cycle. The repository emits through an `@Optional()`
 * `EventEmitter2` (bound by the API's global `EventEmitterModule.forRoot()`);
 * unit tests and contexts without the emitter emit nothing.
 *
 * Best-effort by contract: a listener failure never fails, or rolls back, the
 * terminal write that raised the event.
 */

export const AGENT_RUN_TERMINAL_EVENT = 'agent-run.terminal' as const;

export interface AgentRunTerminalEvent {
    runId: string;
    agentId: string;
    /** The status the row ended in: `completed`, `failed` or `cancelled`. */
    status: string;
    /** When the row went terminal; `null` only for a row written without one. */
    finishedAt: Date | null;
    /**
     * The needs-attention token the platform raised on the run while it was
     * live (`queued-too-long`, `stale-parked`), or `null`. Carried so a
     * listener can tell, without a read, whether the run has anything open.
     */
    attentionReason: string | null;
    /**
     * Why the run was parked while queued, as it stood when it ended
     * (`concurrency-limit`, …), or `null` when it was not parked (a promoted
     * run has its reason cleared before it is dispatched).
     */
    queuedReason: string | null;
}
