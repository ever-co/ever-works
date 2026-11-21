import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PluginContextFactoryService } from '../../plugins/services/plugin-context-factory.service';
import { FleetAiCompletionService } from './fleet-ai-completion.service';
import { createFleetLocalAiRelay } from './fleet-local-ai-relay';

/**
 * Local AI completions — hands every plugin the relay to the caller's own
 * machines (`PluginContext.services.localAi`), in the process that owns the
 * fleet (the API): the relay's transport is {@link FleetAiCompletionService}
 * itself. The Trigger.dev worker binds the same relay over its internal RPC
 * (`TriggerPluginsModule`), so a plugin finds it wherever it runs.
 *
 * `PluginContextFactoryService` comes from the global plugins module and is
 * optional: a context without the plugin runtime simply has no relay.
 */
@Injectable()
export class FleetLocalAiPluginServices implements OnModuleInit {
    private readonly logger = new Logger(FleetLocalAiPluginServices.name);

    constructor(
        private readonly completions: FleetAiCompletionService,
        @Optional() private readonly contexts?: PluginContextFactoryService,
    ) {}

    onModuleInit(): void {
        if (!this.contexts) return;
        this.contexts.injectServices({
            localAi: createFleetLocalAiRelay(this.completions, {
                logger: { warn: (message) => this.logger.warn(message) },
            }),
        });
    }
}
