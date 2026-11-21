import { z } from 'zod';
import { fleetLocalModelTagSlug } from '@ever-works/contracts';
import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations, type AiOperationsConfig } from '@ever-works/plugin/ai';
import type {
	AiModel,
	AiModelCapabilities,
	AiProviderCallScope,
	AiProviderTransport,
	AskJsonCompletionOptions,
	AskJsonCompletionResponse,
	ChatCompletionChunk,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ConnectionValidationResult,
	JsonSchema,
	LocalAiRelayServiceRef,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginSettings
} from '@ever-works/plugin';
import { createFleetLocalAiFetch, FLEET_LOCAL_AI_API_KEY, FLEET_LOCAL_AI_BASE_URL } from './fleet-transport';

/**
 * Local AI on your computers — an AI provider whose models are the ones the
 * caller's OWN fleet nodes serve (llama-swap, Ollama, LM Studio, vLLM, any
 * OpenAI-compatible server on or next to the machine), so a Work generation —
 * or any other AI call — runs on the owner's GPU for free.
 *
 * ## How it reaches the models
 *
 * Not over a URL: every request goes through the platform's local AI relay
 * (`PluginContext.services.localAi`), which queues it as an `ai-completion`
 * fleet job for one of the caller's online nodes serving the model; the node
 * sends it to its healthy local provider and the answer comes back. The plugin
 * hands that path to every client as a TRANSPORT (`fleet-transport.ts`):
 *
 *   - its own calls (`createChatCompletion`, streaming, `askJson`) run the
 *     shared `AiOperations` with that `fetch`;
 *   - a pipeline that builds its own AI SDK model (`agent-pipeline`) gets the
 *     same `fetch` from `getProviderConfig` (`createTransport`).
 *
 * So tools, JSON mode and structured output behave exactly as against the
 * server itself, and a new provider kind or wire API on the nodes needs
 * nothing here.
 *
 * ## Free
 *
 * Every model reports a price of 0 (explicitly — a shared catalogue price for
 * a model with the same name never applies), so no budget, ceiling or credit
 * is ever touched by a local answer.
 */

const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_CONTEXT_LENGTH = 32_768;
const DEFAULT_MAX_TOKENS = 8_192;

export class FleetLocalAiPlugin extends BaseAiProvider {
	readonly id = 'fleet-local-ai';
	readonly name = 'Local AI on your computers';
	readonly version = '1.0.0';
	readonly providerType = 'fleet-local-ai';
	readonly providerName = 'Local AI on your computers';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			defaultModel: {
				type: 'string',
				title: 'Model',
				description:
					'A model one of your computers serves (its local AI provider must be up and the node started with --work)',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Tasks Model',
				description: 'Optional: a smaller local model for tags and short descriptions',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			mediumModel: {
				type: 'string',
				title: 'Standard Tasks Model',
				description: 'Optional: the local model for listings and summaries',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Tasks Model',
				description:
					'Optional: the local model for full pages and multi-step work (the agent pipeline uses it)',
				'x-widget': 'model-select',
				'x-scope': 'user'
			},
			requestTimeoutSec: {
				type: 'number',
				title: 'Request timeout (seconds)',
				description:
					'How long one request may take, waiting for a computer included. Local models on long prompts are slow.',
				default: DEFAULT_TIMEOUT_SEC,
				minimum: 10,
				maximum: 1800,
				'x-scope': 'user'
			},
			contextLength: {
				type: 'number',
				title: 'Context window (tokens)',
				description: 'The context your local model is served with; long conversations are compacted to fit',
				default: DEFAULT_CONTEXT_LENGTH,
				minimum: 2048,
				'x-scope': 'user'
			},
			temperature: {
				type: 'number',
				title: 'Temperature',
				default: 0.7,
				minimum: 0,
				maximum: 2,
				'x-hidden': true
			},
			maxTokens: {
				type: 'number',
				title: 'Max Tokens',
				description: 'Reasoning models spend their thinking from this budget too',
				default: DEFAULT_MAX_TOKENS,
				'x-hidden': true
			}
		},
		required: ['defaultModel']
	};

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: FLEET_LOCAL_AI_API_KEY,
			model: '',
			baseURL: FLEET_LOCAL_AI_BASE_URL,
			temperature: 0.7,
			maxTokens: DEFAULT_MAX_TOKENS,
			providerType: 'fleet-local-ai'
		});
		context.logger.log('Local AI on your computers plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	/** The platform's relay to the caller's machines, when this process has one. */
	private get relay(): LocalAiRelayServiceRef | undefined {
		return this.context?.services.localAi;
	}

	private loaded(): AiOperations {
		if (!this.aiOps) throw new Error('Local AI on your computers plugin not loaded');
		return this.aiOps;
	}

	/** The AiOperations config for one call: the settings, the placeholder origin, the transport. */
	private callConfig(settings: PluginSettings | undefined, scope: AiProviderCallScope | undefined) {
		const config: Partial<AiOperationsConfig> = {
			...this.resolveConfig(settings),
			baseURL: FLEET_LOCAL_AI_BASE_URL,
			apiKey: FLEET_LOCAL_AI_API_KEY,
			fetch: this.fetchFor(scope, settings)
		};
		return config;
	}

	private fetchFor(scope: AiProviderCallScope | undefined, settings: PluginSettings | undefined) {
		return createFleetLocalAiFetch({
			relay: this.relay,
			scope: {
				...(scope?.userId ? { userId: scope.userId } : {}),
				...(scope?.workId ? { workId: scope.workId } : {})
			},
			timeoutMs: timeoutSec(settings) * 1000
		});
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		return this.loaded().createChatCompletion(options, this.callConfig(options.settings, options.scope));
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		yield* this.loaded().createStreamingChatCompletion(options, this.callConfig(options.settings, options.scope));
	}

	async askJson(prompt: string, options?: AskJsonCompletionOptions): Promise<AskJsonCompletionResponse> {
		const config = this.callConfig(options?.settings, options?.scope);
		if (options?.model) config.model = options.model;
		return this.loaded().askJson(prompt, options?.schema ?? z.object({}), config, {
			temperature: options?.temperature,
			maxTokens: options?.maxTokens
		});
	}

	/** The transport a client that builds its own model (the agent pipeline) must use. */
	createTransport(scope: AiProviderCallScope, settings?: PluginSettings): AiProviderTransport {
		return {
			baseUrl: FLEET_LOCAL_AI_BASE_URL,
			apiKey: FLEET_LOCAL_AI_API_KEY,
			fetch: this.fetchFor(scope, settings)
		};
	}

	/** The models the caller's online nodes serve (none without the caller or the relay). */
	async listModels(settings?: PluginSettings, scope?: AiProviderCallScope): Promise<readonly AiModel[]> {
		const relay = this.relay;
		if (!relay || !scope?.userId) return [];
		const models = await relay.listModels({ userId: scope.userId });
		return models.map((model) =>
			this.describeModel(model.id, settings, `${model.id} — on ${model.nodes} of your computers`)
		);
	}

	/** Any model id: a local model is free and its window is the one configured (no network). */
	async getModel(modelId: string, settings?: PluginSettings): Promise<AiModel | null> {
		return modelId ? this.describeModel(modelId, settings) : null;
	}

	async isAvailable(settings?: PluginSettings, scope?: AiProviderCallScope): Promise<boolean> {
		return (await this.check(settings, scope)).success;
	}

	async validateConnection(
		settings: Record<string, unknown>,
		scope?: { readonly userId?: string; readonly workId?: string }
	): Promise<ConnectionValidationResult> {
		return this.check(settings, scope);
	}

	private async check(
		settings: PluginSettings | undefined,
		scope: AiProviderCallScope | undefined
	): Promise<ConnectionValidationResult> {
		if (!this.relay) {
			return {
				success: false,
				message: 'This process cannot reach your computers (the platform did not provide the local AI relay).'
			};
		}
		if (!scope?.userId) {
			return { success: false, message: 'Local AI on your computers needs to know whose computers to use.' };
		}
		const models = await this.relay.listModels({ userId: scope.userId });
		if (models.length === 0) {
			return {
				success: false,
				message:
					'None of your computers serves a local model right now. Start ever-works-node with --work on a computer ' +
					'with a local AI provider (llama-swap, Ollama, LM Studio, vLLM); `ever-works-node local-ai probe` shows what it serves.'
			};
		}
		const wanted = typeof settings?.defaultModel === 'string' ? settings.defaultModel : '';
		const slug = wanted ? fleetLocalModelTagSlug(wanted) : null;
		if (wanted && !models.some((model) => model.id === wanted || model.id === slug)) {
			return {
				success: false,
				message: `None of your computers serves "${wanted}" right now. They serve: ${models
					.map((model) => model.id)
					.slice(0, 8)
					.join(', ')}.`
			};
		}
		const served = wanted ? models.find((model) => model.id === wanted || model.id === slug) : models[0];
		return {
			success: true,
			message: `${served?.id ?? 'A model'} is served by ${served?.nodes ?? 0} of your computers.`
		};
	}

	private describeModel(id: string, settings: PluginSettings | undefined, name = id): AiModel {
		return {
			id,
			name,
			description: 'Served by a local AI provider on one of your computers',
			capabilities: { ...this.getCapabilities(), maxContextLength: contextLength(settings) },
			// Explicit zeros: a catalogue price for a model of the same name never applies.
			inputCostPer1k: 0,
			outputCostPer1k: 0
		};
	}

	getCapabilities(): AiModelCapabilities {
		return {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: false,
			maxContextLength: DEFAULT_CONTEXT_LENGTH
		};
	}

	protected getDefaultModelId(): string {
		return '';
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return this.relay
			? { status: 'healthy', message: 'Local AI relay available', checkedAt: Date.now() }
			: { status: 'degraded', message: 'No local AI relay in this process', checkedAt: Date.now() };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Run AI on the local model servers of your own computers (fleet nodes with local AI) — no API key, no per-token cost',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			distribution: 'core',
			visibility: 'public',
			uiHints: { completionFields: ['defaultModel'] },
			readme: [
				'## What is it?',
				'',
				'An AI provider whose models are the ones YOUR computers serve: a fleet node (`ever-works-node`) with a local AI provider — llama-swap, Ollama, LM Studio, vLLM or any OpenAI-compatible server — answers the requests. Nothing is billed: the model runs on your hardware.',
				'',
				'## How it works',
				'',
				'Each request is queued for one of your online computers that serves the model; that computer sends it to its local model server and returns the answer. Tools, JSON output and streaming work as with any OpenAI-compatible provider. Requests only ever go to your own computers.',
				'',
				'## Getting started',
				'',
				'1. On a computer with a GPU, run a local model server (e.g. llama-swap) and configure it in the node (`localAi` in `node-config.json`).',
				'2. Start the node with `--work`; `ever-works-node local-ai probe` shows the models it serves.',
				'3. Enable this plugin and pick the model; select it as the AI provider of a Work (or of one generation).'
			].join('\n')
		};
	}
}

function timeoutSec(settings: PluginSettings | undefined): number {
	const value = settings?.requestTimeoutSec;
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.min(Math.max(Math.round(value), 10), 1800)
		: DEFAULT_TIMEOUT_SEC;
}

function contextLength(settings: PluginSettings | undefined): number {
	const value = settings?.contextLength;
	return typeof value === 'number' && Number.isFinite(value) && value >= 2048
		? Math.round(value)
		: DEFAULT_CONTEXT_LENGTH;
}

export default FleetLocalAiPlugin;
