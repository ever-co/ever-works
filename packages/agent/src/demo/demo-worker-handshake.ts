/**
 * Platform demo mode — the handshake between a Trigger.dev worker and the API.
 *
 * A demo instance runs two deployments that read `DEMO` separately: the API and the
 * Trigger.dev project its workers run in. A worker whose environment lacks `DEMO=true`
 * binds no demo AI quota and no demo repository ledger (see `trigger-facades.module.ts`),
 * so it would make unmetered AI calls and create repositories no sweep can find.
 *
 * So the worker says what it is: when its own `DEMO` is on, every call it makes to the
 * API's internal channel (`/internal/trigger/*`) carries `DEMO_WORKER_HEADER:
 * DEMO_WORKER_HEADER_VALUE`. A demo API refuses a call without it (fail closed). A
 * non-demo API serves a call that carries it, and only logs the drift: nothing a demo
 * worker does needs refusing there. With `DEMO` unset on both sides nothing changes.
 */

/** The header a demo worker sends on every internal call (lower case, as Node reads it). */
export const DEMO_WORKER_HEADER = 'x-ever-works-demo';

/** Its value: the worker's `config.demo.isEnabled()` is true. */
export const DEMO_WORKER_HEADER_VALUE = '1';

/** Whether a received header value says the calling worker runs with `DEMO` on. */
export function isDemoWorkerHeader(value: string | string[] | undefined): boolean {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.trim() === DEMO_WORKER_HEADER_VALUE;
}
