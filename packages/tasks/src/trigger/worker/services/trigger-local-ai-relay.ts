import { Logger } from '@nestjs/common';
import type { PluginContextFactoryService } from '@ever-works/agent/plugins';
import { createFleetLocalAiRelay, type FleetAiCompletionTransport } from '@ever-works/agent/fleet';
import type { LocalAiRelayServiceRef } from '@ever-works/plugin';
import { createRemoteProxy } from '../remote-proxy';
import type { TriggerInternalApiClient } from './trigger-internal-api.client';

/**
 * Local AI completions in the Trigger.dev worker — the SAME relay the API
 * binds (`createFleetLocalAiRelay`), over the internal RPC to the API's
 * `FleetAiCompletionService` (the worker owns no database). Bound into every
 * plugin context of the worker, so an AI-provider plugin running a Work
 * generation here (`fleet-local-ai`) finds `services.localAi` exactly as it
 * would in the API.
 *
 * The API exposes only the relay's five calls for that name
 * (`fleetAiCompletionRemoteFacade`); the relay encodes the body before the
 * hop, waits in slices well inside the RPC's own timeout, and retries a
 * transport failure itself (its submit is idempotent by request id), so the
 * client's retry allow-list needs no entry.
 */
export const TRIGGER_LOCAL_AI_RELAY = Symbol('TRIGGER_LOCAL_AI_RELAY');

const logger = new Logger('TriggerLocalAiRelay');

export function bindTriggerLocalAiRelay(
    contexts: PluginContextFactoryService,
    apiClient: TriggerInternalApiClient,
): LocalAiRelayServiceRef {
    const transport = createRemoteProxy(
        apiClient,
        'FleetAiCompletionService',
    ) as FleetAiCompletionTransport;
    const relay = createFleetLocalAiRelay(transport, {
        logger: { warn: (message) => logger.warn(message) },
    });
    contexts.injectServices({ localAi: relay });
    return relay;
}
