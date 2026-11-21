import { randomUUID } from 'node:crypto';
import {
    clampFleetAiCompletionTimeoutSec,
    FLEET_AI_COMPLETION_MAX_REQUEST_BYTES,
    FLEET_AI_COMPLETION_MAX_RESPONSE_BYTES,
    type FleetAiCompletionFailure,
} from '@ever-works/contracts';
import type {
    LocalAiRelayFailure,
    LocalAiRelayModel,
    LocalAiRelayOutcome,
    LocalAiRelayRequest,
    LocalAiRelayScope,
    LocalAiRelayServiceRef,
} from '@ever-works/plugin';
import {
    decodeFleetAiCompletionBody,
    encodeFleetAiCompletionBody,
    FleetAiCompletionCodecError,
} from './fleet-ai-completion.codec';
import type {
    FleetAiCompletionModel,
    FleetAiCompletionSubmitInput,
    FleetAiCompletionSubmitOutcome,
    FleetAiCompletionWaitOutcome,
} from './fleet-ai-completion.service';

/**
 * Local AI completions — the RELAY a plugin calls (`PluginServices.localAi`),
 * composed over the platform service's short calls.
 *
 * The same composition runs in both places a plugin can run: in the API the
 * transport IS `FleetAiCompletionService`; in the Trigger.dev worker it is a
 * remote proxy to it over the internal RPC — which is why the service speaks
 * in short calls and outcome values, and why this side owns the waiting:
 *
 *   1. encode the body (gzip + base64) HERE, before it crosses any boundary,
 *      so a long context fits both the RPC and the job payload;
 *   2. `submit` with a request id of its own — a retried submit (a 502 from a
 *      proxy) returns the SAME job, never a second one;
 *   3. `awaitResult` in slices until the answer, the caller's deadline, or the
 *      caller's cancel (raced locally: a cancel never waits out a slice);
 *   4. on a deadline or a cancel, `cancel` the job; on any end, `release` it
 *      so the prompt and the answer leave the job row.
 *
 * A request nobody leases within {@link FleetLocalAiRelayOptions.queueTimeoutMs}
 * is `no-node` (the machine that looked online stopped serving), not a
 * fifteen-minute wait. A transport error is retried (bounded) — the job keeps
 * running server-side whatever this side's connection does.
 */

/** The platform service as the relay calls it (the service itself, or a remote proxy to it). */
export interface FleetAiCompletionTransport {
    listModels(userId: string): Promise<FleetAiCompletionModel[]>;
    submit(input: FleetAiCompletionSubmitInput): Promise<FleetAiCompletionSubmitOutcome>;
    awaitResult(input: {
        userId: string;
        jobId: string;
        waitMs: number;
    }): Promise<FleetAiCompletionWaitOutcome>;
    cancel(input: { userId: string; jobId: string }): Promise<unknown>;
    release(input: { userId: string; jobId: string }): Promise<unknown>;
}

export const FLEET_LOCAL_AI_RELAY_DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const FLEET_LOCAL_AI_RELAY_MIN_TIMEOUT_MS = 10_000;
export const FLEET_LOCAL_AI_RELAY_MAX_TIMEOUT_MS = 60 * 60_000;
export const FLEET_LOCAL_AI_RELAY_QUEUE_TIMEOUT_MS = 120_000;
export const FLEET_LOCAL_AI_RELAY_WAIT_SLICE_MS = 15_000;

export interface FleetLocalAiRelayOptions {
    /** The whole wait when a request names none. */
    defaultTimeoutMs?: number;
    /** How long a request may sit unleased before it is `no-node`. */
    queueTimeoutMs?: number;
    /** One `awaitResult` slice. */
    waitSliceMs?: number;
    /** Retries of one transport call that threw. */
    transportRetries?: number;
    retryDelayMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    newRequestId?: () => string;
    logger?: { warn(message: string): void };
}

const ABORTED = Symbol('aborted');

export function createFleetLocalAiRelay(
    transport: FleetAiCompletionTransport,
    options: FleetLocalAiRelayOptions = {},
): LocalAiRelayServiceRef {
    const now = options.now ?? Date.now;
    const sleep =
        options.sleep ??
        ((ms: number) =>
            new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, ms);
                (timer as { unref?: () => void }).unref?.();
            }));
    const retries = options.transportRetries ?? 4;
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    const queueTimeoutMs = options.queueTimeoutMs ?? FLEET_LOCAL_AI_RELAY_QUEUE_TIMEOUT_MS;
    const waitSliceMs = options.waitSliceMs ?? FLEET_LOCAL_AI_RELAY_WAIT_SLICE_MS;
    const newRequestId = options.newRequestId ?? (() => randomUUID());

    /** One transport call, retried on a throw (never past `deadline`). */
    async function retrying<T>(what: string, deadline: number, call: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await call();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const delay = retryDelayMs * 2 ** attempt;
                if (attempt >= retries || now() + delay >= deadline) {
                    throw new RelayTransportError(`${what}: ${message}`);
                }
                options.logger?.warn(
                    `local AI relay: ${what} failed (${message}) — retrying in ${delay} ms`,
                );
                await sleep(delay);
            }
        }
    }

    return {
        async listModels(scope: LocalAiRelayScope): Promise<readonly LocalAiRelayModel[]> {
            if (!scope?.userId) return [];
            try {
                const models = await retrying('listing models', now() + 30_000, () =>
                    transport.listModels(scope.userId),
                );
                return (Array.isArray(models) ? models : []).map((model) => ({
                    id: model.id,
                    nodes: model.nodes,
                }));
            } catch (error) {
                options.logger?.warn(`local AI relay: ${(error as Error).message}`);
                return [];
            }
        },

        async complete(request: LocalAiRelayRequest): Promise<LocalAiRelayOutcome> {
            const userId = request?.userId;
            if (typeof userId !== 'string' || !userId) {
                return fail('invalid-request', 'A local AI completion needs the user it is for');
            }
            const signal = request.signal;
            if (signal?.aborted) return fail('cancelled', 'The local AI completion was cancelled');
            let encoded: ReturnType<typeof encodeFleetAiCompletionBody>;
            try {
                encoded = encodeFleetAiCompletionBody(
                    request.body,
                    FLEET_AI_COMPLETION_MAX_REQUEST_BYTES,
                );
            } catch (error) {
                return fail(
                    error instanceof FleetAiCompletionCodecError && error.reason === 'too-large'
                        ? 'too-large'
                        : 'invalid-request',
                    (error as Error).message,
                );
            }
            const started = now();
            const timeoutMs = clampTimeout(request.timeoutMs ?? options.defaultTimeoutMs);
            const deadline = started + timeoutMs;

            let submitted: FleetAiCompletionSubmitOutcome;
            try {
                submitted = await retrying('submitting the request', deadline, () =>
                    transport.submit({
                        userId,
                        ...(request.workId ? { workId: request.workId } : {}),
                        api: request.api,
                        model: request.model,
                        body: encoded.body,
                        bodyEncoding: encoded.bodyEncoding,
                        timeoutSec: clampFleetAiCompletionTimeoutSec(Math.floor(timeoutMs / 1000)),
                        requestId: newRequestId(),
                    }),
                );
            } catch (error) {
                return fail(
                    'failed',
                    `The platform could not take the request: ${(error as Error).message}`,
                );
            }
            if (!submitted.ok) return fail(submitted.code, submitted.message);
            const jobId = submitted.jobId;
            const ids = { userId, jobId };
            const giveUp = async (
                code: FleetAiCompletionFailure,
                message: string,
            ): Promise<LocalAiRelayFailure> => {
                await transport.cancel(ids).catch(() => undefined);
                return fail(code, message);
            };

            try {
                for (;;) {
                    if (signal?.aborted)
                        return await giveUp('cancelled', 'The local AI completion was cancelled');
                    const remaining = deadline - now();
                    if (remaining <= 0) {
                        return await giveUp(
                            'timeout',
                            `No answer from your local AI within ${Math.round(timeoutMs / 1000)} s`,
                        );
                    }
                    let outcome: FleetAiCompletionWaitOutcome | typeof ABORTED;
                    try {
                        outcome = await raceAbort(
                            retrying('waiting for the answer', deadline, () =>
                                transport.awaitResult({
                                    ...ids,
                                    waitMs: Math.max(1, Math.min(waitSliceMs, remaining)),
                                }),
                            ),
                            signal,
                        );
                    } catch (error) {
                        return await giveUp(
                            'failed',
                            `The platform could not be reached while waiting for the answer: ${(error as Error).message}`,
                        );
                    }
                    if (outcome === ABORTED) {
                        return await giveUp('cancelled', 'The local AI completion was cancelled');
                    }
                    if (outcome.state === 'pending') {
                        if (outcome.status === 'queued' && now() - started >= queueTimeoutMs) {
                            return await giveUp(
                                'no-node',
                                `No local AI node took the request within ${Math.round(queueTimeoutMs / 1000)} s — ` +
                                    'the computer that serves the model may have stopped serving (is its local AI provider up?)',
                            );
                        }
                        continue;
                    }
                    if (outcome.state === 'failed') return fail(outcome.code, outcome.message);
                    const result = outcome.result;
                    let body: unknown;
                    try {
                        body = decodeFleetAiCompletionBody(
                            result.body,
                            result.bodyEncoding,
                            FLEET_AI_COMPLETION_MAX_RESPONSE_BYTES,
                        );
                    } catch (error) {
                        return fail(
                            error instanceof FleetAiCompletionCodecError &&
                                error.reason === 'too-large'
                                ? 'too-large'
                                : 'failed',
                            `The local AI answer could not be read: ${(error as Error).message}`,
                        );
                    }
                    return {
                        ok: true,
                        status: result.status,
                        body,
                        model: result.model,
                        providerKind: result.providerKind,
                        latencyMs: result.latencyMs,
                        usage: result.usage,
                    };
                }
            } finally {
                // The prompt and the answer leave the job row now (a job still
                // running is left to the retention purge).
                void Promise.resolve()
                    .then(() => transport.release(ids))
                    .catch(() => undefined);
            }
        },
    };
}

class RelayTransportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RelayTransportError';
    }
}

function fail(code: FleetAiCompletionFailure, message: string): LocalAiRelayFailure {
    return { ok: false, code, message };
}

function clampTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return FLEET_LOCAL_AI_RELAY_DEFAULT_TIMEOUT_MS;
    }
    return Math.min(
        Math.max(Math.round(value), FLEET_LOCAL_AI_RELAY_MIN_TIMEOUT_MS),
        FLEET_LOCAL_AI_RELAY_MAX_TIMEOUT_MS,
    );
}

/** `promise`, or {@link ABORTED} the moment `signal` aborts (the promise is then left to settle unobserved). */
function raceAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
    if (!signal) return promise;
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.resolve(ABORTED);
    }
    return new Promise<T | typeof ABORTED>((resolve, reject) => {
        const onAbort = (): void => {
            promise.catch(() => undefined);
            resolve(ABORTED);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}
