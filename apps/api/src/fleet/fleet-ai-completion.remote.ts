import type {
    FleetAiCompletionService,
    FleetAiCompletionSubmitInput,
} from '@ever-works/agent/fleet';

/**
 * Local AI completions — what the Trigger.dev worker may call on
 * `FleetAiCompletionService` over the internal RPC (`/internal/trigger/remote/call`),
 * and nothing else: the five calls the worker-side relay
 * (`createFleetLocalAiRelay`, bound into every plugin context by
 * `TriggerPluginsModule`) is composed of. The derived allow-list of this facade
 * is exactly these five names.
 *
 * Every argument is REBUILT from the fields the service reads (strings as
 * strings, the wait as a number), so nothing else a caller sends reaches it;
 * the service itself re-checks that a job belongs to the user named.
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
                    typeof raw.waitMs === 'number' && Number.isFinite(raw.waitMs) ? raw.waitMs : 0,
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

function readIds(input: unknown): { userId: string; jobId: string } {
    const raw = record(input);
    return { userId: text(raw.userId), jobId: text(raw.jobId) };
}

function readSubmit(input: unknown): FleetAiCompletionSubmitInput {
    const raw = record(input);
    const out: FleetAiCompletionSubmitInput = {
        userId: text(raw.userId),
        api: text(raw.api) as FleetAiCompletionSubmitInput['api'],
        model: text(raw.model),
        body: text(raw.body),
        bodyEncoding: text(raw.bodyEncoding) as FleetAiCompletionSubmitInput['bodyEncoding'],
        requestId: text(raw.requestId),
    };
    if (typeof raw.timeoutSec === 'number' && Number.isFinite(raw.timeoutSec))
        out.timeoutSec = raw.timeoutSec;
    if (typeof raw.workId === 'string' && raw.workId) out.workId = raw.workId;
    return out;
}
