import { DemoFeatureDisabledError, DemoRateLimitedError } from './demo-errors';

/**
 * Platform demo mode — injection token + contract for the demo's AI quota.
 *
 * `AiFacadeService` asks it before every upstream AI call on a demo instance.
 * The API binds it to its DB counters; Trigger.dev workers (no DB) bind a
 * remote proxy to the same service. Unbound on a demo instance = every AI call
 * is refused ({@link demoAiQuotaUnboundError}): an uncounted call must not go out.
 */
export interface DemoAiQuotaPort {
    /**
     * Count one AI call. Throws `DemoQuotaExceededError` when the sandbox's or
     * the day's requests are used up, `DemoRateLimitedError` when the minute's
     * are. `userId` is undefined for system work (no sandbox to charge).
     */
    consume(userId: string | undefined): Promise<void>;
}

export const DEMO_AI_QUOTA = 'DEMO_AI_QUOTA' as const;

/** Logged (once per consumer) when a demo instance has no `DEMO_AI_QUOTA` bound. */
export const DEMO_AI_QUOTA_UNBOUND_MESSAGE =
    'Demo mode is on but DEMO_AI_QUOTA is not bound: refusing every AI call';

/** The refusal for an AI call on a demo instance with no `DEMO_AI_QUOTA` bound. */
export function demoAiQuotaUnboundError(): DemoFeatureDisabledError {
    return new DemoFeatureDisabledError('ai (quota not configured)');
}

/**
 * `background` work (generation steps, agent iterations) waits out a busy
 * minute; `interactive` work (chat) is told at once.
 */
export type DemoAiCallMode = 'background' | 'interactive';

/** The longest a background call waits, in total, for a busy minute to pass. */
export const DEMO_AI_RATE_WAIT_BUDGET_MS = 60_000;

/** The wait used when a busy answer carries no usable `retryAfterMs`. */
const FALLBACK_WAIT_MS = 1_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consume one AI call from the demo quota. A background call that finds the
 * minute busy sleeps `retryAfterMs` and asks again, until it has waited
 * {@link DEMO_AI_RATE_WAIT_BUDGET_MS} in total; then the last refusal is
 * rethrown. Any other refusal (a used-up quota) is final.
 */
export async function consumeDemoAiQuota(
    port: DemoAiQuotaPort,
    userId: string | undefined,
    mode: DemoAiCallMode,
    sleep: (ms: number) => Promise<void> = realSleep,
): Promise<void> {
    let waited = 0;
    for (;;) {
        try {
            await port.consume(userId);
            return;
        } catch (error) {
            const retryAfterMs = busyRetryAfterMs(error);
            const remaining = DEMO_AI_RATE_WAIT_BUDGET_MS - waited;
            if (mode !== 'background' || retryAfterMs === null || remaining <= 0) throw error;
            const wait = Math.min(retryAfterMs > 0 ? retryAfterMs : FALLBACK_WAIT_MS, remaining);
            await sleep(wait);
            waited += wait;
        }
    }
}

/**
 * The `retryAfterMs` of a "minute busy" refusal, or null for any other error.
 * Recognised by class or by its `DEMO_AI_BUSY` code, so a refusal rebuilt on
 * the other side of a process boundary still counts.
 */
function busyRetryAfterMs(error: unknown): number | null {
    const busy =
        error instanceof DemoRateLimitedError ||
        (error instanceof Error && (error as { code?: unknown }).code === 'DEMO_AI_BUSY');
    if (!busy) return null;
    const ms = Number((error as { retryAfterMs?: unknown }).retryAfterMs);
    return Number.isFinite(ms) ? Math.ceil(ms) : 0;
}
