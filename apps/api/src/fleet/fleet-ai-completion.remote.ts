import {
    FLEET_AI_COMPLETION_MAX_WAIT_SLICE_MS,
    type FleetAiCompletionService,
    type FleetAiCompletionSubmitInput,
} from '@ever-works/agent/fleet';
import {
    clampFleetAiCompletionTimeoutSec,
    FLEET_AI_COMPLETION_BODY_ENCODINGS,
    FLEET_AI_WIRE_APIS,
} from '@ever-works/contracts';

/**
 * Local AI completions — what the Trigger.dev worker may call on
 * `FleetAiCompletionService` over the internal RPC (`/internal/trigger/remote/call`),
 * and nothing else: the five calls the worker-side relay
 * (`createFleetLocalAiRelay`, bound into every plugin context by
 * `TriggerPluginsModule`) is composed of. The derived allow-list of this facade
 * is exactly these five names.
 *
 * Every argument is REBUILT into a fresh object from the scalar fields the
 * service reads — strings as strings; the wire API and the body encoding only
 * from their vocabularies (anything else arrives as `''`, which the service
 * refuses); the provider budget clamped to the contract's range and the wait
 * to one slice — so nothing else a caller sends reaches it, and nothing it
 * sends can hold the service longer than the service would allow. The
 * service itself re-checks that a job belongs to the user named (an empty or
 * malformed id is "unknown").
 */
export function fleetAiCompletionRemoteFacade(service: FleetAiCompletionService) {
    return {
        listModels: (userId?: unknown) => service.listModels(text(userId)),
        submit: (input?: unknown) => service.submit(readSubmit(input)),
        awaitResult: (input?: unknown) => {
            const raw = record(input);
            return service.awaitResult({
                userId: text(raw.userId),
                jobId: text(raw.jobId),
                waitMs:
                    typeof raw.waitMs === 'number' && Number.isFinite(raw.waitMs)
                        ? Math.min(Math.max(0, raw.waitMs), FLEET_AI_COMPLETION_MAX_WAIT_SLICE_MS)
                        : 0,
            });
        },
        cancel: (input?: unknown) => service.cancel(readIds(input)),
        release: (input?: unknown) => service.release(readIds(input)),
    };
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** `value` when it is one of `allowed`, else `''` (which the service refuses). */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | '' {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : '';
}

function readIds(input: unknown): { userId: string; jobId: string } {
    const raw = record(input);
    return { userId: text(raw.userId), jobId: text(raw.jobId) };
}

function readSubmit(input: unknown): FleetAiCompletionSubmitInput {
    const raw = record(input);
    const out: FleetAiCompletionSubmitInput = {
        userId: text(raw.userId),
        // `''` is not a member of either union: the service refuses it, which is the point.
        api: oneOf(raw.api, FLEET_AI_WIRE_APIS) as FleetAiCompletionSubmitInput['api'],
        model: text(raw.model),
        body: text(raw.body),
        bodyEncoding: oneOf(
            raw.bodyEncoding,
            FLEET_AI_COMPLETION_BODY_ENCODINGS,
        ) as FleetAiCompletionSubmitInput['bodyEncoding'],
        requestId: text(raw.requestId),
    };
    if (typeof raw.timeoutSec === 'number' && Number.isFinite(raw.timeoutSec)) {
        out.timeoutSec = clampFleetAiCompletionTimeoutSec(raw.timeoutSec);
    }
    if (typeof raw.workId === 'string' && raw.workId) out.workId = raw.workId;
    return out;
}
