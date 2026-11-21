import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
    IAgentMemoryPlugin,
    IAgentMemoryFacade,
    AgentMemorySession,
    AgentMemoryRecord,
    AgentMemorySearchResponse,
    AgentMemoryContext,
    FacadeOptions,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { RegisteredPlugin } from '../plugins/services/plugin-registry.service';
import { materializePlugin } from '../plugins/services/plugin-operation.util';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class AgentMemoryFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'AgentMemoryFacadeError';
    }
}

/**
 * Facade for the `agent-memory` capability.
 *
 * Routes save/search/context/session operations to the user's resolved
 * agent-memory plugin — `@ever-works/memanto-plugin` (Memanto server) is
 * the default whenever it is enabled; `@ever-works/agentmemory-plugin`
 * (local or hosted `agentmemory` REST server) serves scopes where it is
 * the only one enabled.
 *
 * Mirrors the other facades: provider resolution + 4-level settings
 * hierarchy via `BaseFacadeService`. Optional governance methods
 * (`deleteEntry`, `listSessions`) probe the resolved plugin for support
 * before dispatching — community plugins MAY skip them.
 */
@Injectable()
export class AgentMemoryFacadeService extends BaseFacadeService implements IAgentMemoryFacade {
    protected readonly logger = new Logger(AgentMemoryFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.AGENT_MEMORY;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    async openSession(
        metadata: Record<string, unknown> | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemorySession> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.openSession({
                metadata,
                settings,
            });
        } catch (error) {
            throw this.wrap(error, 'openSession', plugin.id);
        }
    }

    async closeSession(sessionId: string, facadeOptions: FacadeOptions): Promise<void> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            await plugin.closeSession(sessionId, settings);
        } catch (error) {
            throw this.wrap(error, 'closeSession', plugin.id);
        }
    }

    async saveMemory(
        input: {
            content: string;
            tags?: readonly string[];
            metadata?: Record<string, unknown>;
            sessionId?: string;
            projectId?: string;
        },
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemoryRecord> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.saveMemory({ ...input, settings });
        } catch (error) {
            throw this.wrap(error, 'saveMemory', plugin.id);
        }
    }

    async searchMemory(
        input: {
            query: string;
            limit?: number;
            tags?: readonly string[];
            sessionId?: string;
            projectId?: string;
        },
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemorySearchResponse> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.searchMemory({ ...input, settings });
        } catch (error) {
            throw this.wrap(error, 'searchMemory', plugin.id);
        }
    }

    async buildContext(
        input: {
            query?: string;
            purpose?: string;
            sessionId?: string;
            projectId?: string;
            maxTokens?: number;
        },
        facadeOptions: FacadeOptions,
    ): Promise<AgentMemoryContext> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.buildContext({ ...input, settings });
        } catch (error) {
            throw this.wrap(error, 'buildContext', plugin.id);
        }
    }

    /**
     * `buildContext` variant that also reports WHICH provider served
     * the payload (memory upgrades M2/M3 — the AgentRunLog "recall
     * size/provider" note and the pipeline dispatch log both need the
     * resolved plugin id, which plain `buildContext` does not surface).
     * Single resolution: the plugin is resolved once and used for both
     * the id and the call. Same error posture as `buildContext` —
     * `NoProviderError` propagates un-wrapped from resolution; backend
     * failures are wrapped with the provider id attached.
     */
    async buildContextWithProvider(
        input: {
            query?: string;
            purpose?: string;
            sessionId?: string;
            projectId?: string;
            maxTokens?: number;
        },
        facadeOptions: FacadeOptions,
    ): Promise<{ context: AgentMemoryContext; providerId: string }> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            const context = await plugin.buildContext({ ...input, settings });
            return { context, providerId: plugin.id };
        } catch (error) {
            throw this.wrap(error, 'buildContext', plugin.id);
        }
    }

    async deleteEntry(id: string, facadeOptions: FacadeOptions): Promise<void> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        if (typeof plugin.deleteEntry !== 'function') {
            throw new AgentMemoryFacadeError(
                `Agent-memory provider "${plugin.providerName}" does not support deleteEntry`,
                'deleteEntry',
                plugin.id,
            );
        }
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            await plugin.deleteEntry(id, settings);
        } catch (error) {
            throw this.wrap(error, 'deleteEntry', plugin.id);
        }
    }

    async listSessions(
        options: { limit?: number; projectId?: string } | undefined,
        facadeOptions: FacadeOptions,
    ): Promise<readonly AgentMemorySession[]> {
        const plugin = await this.resolveTypedPlugin(facadeOptions);
        if (typeof plugin.listSessions !== 'function') {
            throw new AgentMemoryFacadeError(
                `Agent-memory provider "${plugin.providerName}" does not support listSessions`,
                'listSessions',
                plugin.id,
            );
        }
        const settings = await this.getResolvedSettings(plugin.id, facadeOptions);
        try {
            return await plugin.listSessions({ ...options, settings });
        } catch (error) {
            throw this.wrap(error, 'listSessions', plugin.id);
        }
    }

    /**
     * Implicit-resolution candidates (default first), minus the providers
     * that report themselves unconfigured for this scope
     * (`IAgentMemoryPlugin.isConfigured`). The Memanto plugin is
     * `autoEnable` + the capability default, so without this gate every
     * scope with no Memanto server set up would route recall and saves to a
     * dead endpoint and lose the agentmemory provider it actually enabled.
     * Explicit choices — `providerOverride` and the Work's active plugin —
     * do not go through here and are never filtered.
     */
    protected override async getEnabledPlugins(
        workId: string,
        userId: string,
    ): Promise<RegisteredPlugin[]> {
        const enabled = await super.getEnabledPlugins(workId, userId);
        const out: RegisteredPlugin[] = [];
        for (const registered of enabled) {
            if (await this.isConfiguredForScope(registered, { userId, workId }))
                out.push(registered);
        }
        return out;
    }

    private async isConfiguredForScope(
        registered: RegisteredPlugin,
        scope: { userId?: string; workId?: string },
    ): Promise<boolean> {
        try {
            // The registry may hold a lazy proxy, whose every property reads as a
            // forwarding function — ask the REAL instance whether it has the probe.
            const plugin = (await materializePlugin(
                registered.plugin,
            )) as Partial<IAgentMemoryPlugin>;
            if (typeof plugin.isConfigured !== 'function') return true;
            const settings = await this.getResolvedSettings(registered.plugin.id, {
                userId: scope.userId,
                workId: scope.workId,
            } as FacadeOptions);
            return (await plugin.isConfigured(settings)) !== false;
        } catch (error) {
            this.logger.warn(
                `agent-memory provider "${registered.plugin.id}" readiness probe failed; skipping it for this scope: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    private resolveTypedPlugin(facadeOptions: FacadeOptions): Promise<IAgentMemoryPlugin> {
        return this.resolvePlugin<IAgentMemoryPlugin>(
            facadeOptions.providerOverride,
            facadeOptions.userId,
            facadeOptions.workId,
        );
    }

    private wrap(error: unknown, operation: string, provider: string): AgentMemoryFacadeError {
        if (error instanceof AgentMemoryFacadeError) return error;
        const message = error instanceof Error ? error.message : 'Agent-memory operation failed';
        const cause = error instanceof Error ? error : undefined;
        return new AgentMemoryFacadeError(message, operation, provider, cause);
    }
}
