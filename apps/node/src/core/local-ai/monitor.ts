import type { FleetAgentExecutionProvider } from '@ever-works/contracts';
import type { FetchLike } from '../fleet-client';
import type { Logger } from '../logger';
import { evaluateLocalAiRuntime, type LocalAiAgentBinding } from './agent-binding';
import { bearerHeaders, LocalAiHttpError, localAiRequestJson } from './http';
import { isUsableLocalModelId, LOCAL_AI_MAX_MODELS } from './providers/openai-compatible';
import { defaultLocalAiProviderRegistry, type LocalAiProviderRegistry } from './registry';
import { LocalAiSecretError, readLocalAiApiKey, type LocalAiSecretIo } from './secrets';
import { localAiCapabilityFacts, type LocalAiCapabilityFacts } from './tags';
import type { LocalAiProbeContext, LocalAiProviderSettings, LocalAiProviderStatus, LocalAiSettings } from './types';

/**
 * The node's view of its local AI providers: probes, cached and refreshed on
 * an interval, and the per-run binding of an agent CLI.
 *
 * ## Never in the way
 *
 *   - No network at construction: the first probe runs when something asks
 *     (the first heartbeat, a job, `local-ai probe`).
 *   - Every probe is bounded by `probeTimeoutMs` (all of one provider's
 *     requests together) and providers are probed in parallel.
 *   - Concurrent askers share ONE probe round.
 *   - Nothing here throws to its caller: a provider that does not answer is
 *     `down`, with a one-line reason, and the node goes on beating.
 *
 * ## The key
 *
 * Read at use time through {@link LocalAiSecretIo}, registered with the
 * logger's redactor the moment it is read, sent only in the provider's own
 * requests, and scrubbed out of every error message this class produces.
 */

/** A bound run re-probes a provider whose answer is older than this before it starts. */
export const LOCAL_AI_RUN_MAX_STATUS_AGE_MS = 15_000;

export interface LocalAiMonitorOptions {
	settings: LocalAiSettings;
	registry?: LocalAiProviderRegistry;
	fetchFn: FetchLike;
	secrets: LocalAiSecretIo;
	logger?: Logger;
	now?: () => number;
}

interface StoredStatus {
	status: LocalAiProviderStatus;
	checkedAtMs: number | null;
}

export class LocalAiMonitor {
	readonly settings: LocalAiSettings;
	readonly registry: LocalAiProviderRegistry;
	private readonly fetchFn: FetchLike;
	private readonly secrets: LocalAiSecretIo;
	private readonly logger: Logger | undefined;
	private readonly now: () => number;
	private readonly stored = new Map<string, StoredStatus>();
	private round: Promise<void> | null = null;

	constructor(options: LocalAiMonitorOptions) {
		this.settings = options.settings;
		this.registry = options.registry ?? defaultLocalAiProviderRegistry();
		this.fetchFn = options.fetchFn;
		this.secrets = options.secrets;
		this.logger = options.logger;
		this.now = options.now ?? (() => Date.now());
		for (const provider of this.settings.providers) {
			this.stored.set(provider.id, { status: unknownStatus(provider), checkedAtMs: null });
		}
	}

	/** Every provider's last known status, in config order. Never probes. */
	snapshot(): LocalAiProviderStatus[] {
		return this.settings.providers.map(
			(provider) => this.stored.get(provider.id)?.status ?? unknownStatus(provider)
		);
	}

	/**
	 * The statuses, re-probing every provider whose answer is older than
	 * `maxAgeMs` (default: the probe interval). Never rejects.
	 */
	async current(options: { maxAgeMs?: number } = {}): Promise<LocalAiProviderStatus[]> {
		const maxAge = options.maxAgeMs ?? this.settings.probeIntervalMs;
		const now = this.now();
		const stale = this.settings.providers.filter((provider) => {
			const checked = this.stored.get(provider.id)?.checkedAtMs ?? null;
			return checked === null || now - checked >= maxAge;
		});
		if (stale.length > 0) await this.probe(stale);
		return this.snapshot();
	}

	/** Probe every provider now, whatever the cache says. Never rejects. */
	async refresh(): Promise<LocalAiProviderStatus[]> {
		await this.probe(this.settings.providers);
		return this.snapshot();
	}

	/** Capability tags and withheld CLIs from the cached statuses (no probe). */
	capabilityFacts(): LocalAiCapabilityFacts {
		return localAiCapabilityFacts(this.settings, this.snapshot(), this.registry);
	}

	/** The agent CLIs the operator bound to a local provider (bound, whatever their health). */
	boundClis(): FleetAgentExecutionProvider[] {
		return this.settings.agentRuntimes.map((runtime) => runtime.cli);
	}

	/**
	 * The binding for one run of `cli`, or null when `cli` is not bound.
	 *
	 * Re-probes a provider whose answer is older than
	 * {@link LOCAL_AI_RUN_MAX_STATUS_AGE_MS} and re-reads the key, so a run
	 * starts on what is true now rather than on the last heartbeat's view.
	 */
	async bindingFor(
		cli: FleetAgentExecutionProvider,
		options: { maxAgeMs?: number } = {}
	): Promise<LocalAiAgentBinding | null> {
		const runtime = this.settings.agentRuntimes.find((candidate) => candidate.cli === cli);
		if (!runtime) return null;
		const statuses = await this.current({
			maxAgeMs: options.maxAgeMs ?? Math.min(LOCAL_AI_RUN_MAX_STATUS_AGE_MS, this.settings.probeIntervalMs)
		});
		const evaluation = evaluateLocalAiRuntime(runtime, this.settings, statuses, this.registry);
		if (!evaluation.ok) {
			return { kind: 'unavailable', cli, providerId: runtime.provider, reason: evaluation.reason };
		}
		let apiKey: string | null;
		try {
			apiKey = await this.readKey(evaluation.provider);
		} catch (error) {
			return {
				kind: 'unavailable',
				cli,
				providerId: runtime.provider,
				reason: `local AI provider "${evaluation.provider.id}": ${describeError(error)}`
			};
		}
		return {
			kind: 'bound',
			cli,
			providerId: evaluation.provider.id,
			providerKind: evaluation.provider.kind,
			model: evaluation.model,
			smallModel: evaluation.smallModel,
			api: evaluation.api,
			endpoint: evaluation.endpoint,
			apiKey
		};
	}

	/**
	 * One authenticated JSON request to a provider — the seam `local-ai test`
	 * sends its smoke requests through. Throws {@link LocalAiHttpError} /
	 * {@link LocalAiSecretError}; never with the key in the message.
	 */
	async request(
		provider: LocalAiProviderSettings,
		request: {
			method: 'GET' | 'POST';
			url: string;
			label: string;
			body?: unknown;
			headers?: Record<string, string>;
		},
		timeoutMs: number
	): Promise<{ status: number; json: unknown }> {
		const key = await this.readKey(provider);
		try {
			return await localAiRequestJson(this.fetchFn, {
				...request,
				headers: { ...bearerHeaders(key), ...(request.headers ?? {}) },
				timeoutMs
			});
		} catch (error) {
			if (error instanceof LocalAiHttpError) {
				throw new LocalAiHttpError(error.failure, this.scrub(error.message, key), error.status);
			}
			throw error;
		}
	}

	private async readKey(provider: LocalAiProviderSettings): Promise<string | null> {
		const key = await readLocalAiApiKey(provider.apiKey, this.secrets);
		if (key) this.logger?.protect(key);
		return key;
	}

	private probe(providers: readonly LocalAiProviderSettings[]): Promise<void> {
		// One round at a time: an asker that arrives mid-round waits for it
		// rather than starting a second set of requests to the same servers.
		if (this.round) return this.round;
		const round = Promise.all(providers.map((provider) => this.probeOne(provider)))
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => {
				if (this.round === round) this.round = null;
			});
		this.round = round;
		return round;
	}

	private async probeOne(provider: LocalAiProviderSettings): Promise<void> {
		const previous = this.stored.get(provider.id)?.status ?? unknownStatus(provider);
		const startedAt = this.now();
		let next: LocalAiProviderStatus;
		let key: string | null = null;
		const controller = new AbortController();
		// The deadline holds even for a definition that awaits something other
		// than its context's requests: the race below ends the probe at it.
		let expire: (error: Error) => void = () => undefined;
		const expired = new Promise<never>((_resolve, reject) => {
			expire = reject;
		});
		expired.catch(() => undefined);
		const timer = setTimeout(() => {
			controller.abort();
			expire(
				new LocalAiHttpError(
					'timeout',
					`the probe timed out after ${Math.round(this.settings.probeTimeoutMs / 1000)} s`
				)
			);
		}, this.settings.probeTimeoutMs);
		(timer as { unref?: () => void }).unref?.();
		try {
			key = await this.readKey(provider);
			const definition = this.registry.get(provider.kind);
			const deadline = startedAt + this.settings.probeTimeoutMs;
			const context: LocalAiProbeContext = {
				provider,
				signal: controller.signal,
				getJson: async (path: string) =>
					(
						await localAiRequestJson(this.fetchFn, {
							method: 'GET',
							url: `${provider.baseUrl}${path}`,
							label: path,
							headers: bearerHeaders(key),
							timeoutMs: Math.max(1, deadline - this.now()),
							signal: controller.signal
						})
					).json
			};
			const outcome = await Promise.race([definition.probe(context), expired]);
			next = {
				...previous,
				status: 'up',
				checkedAt: new Date(this.now()).toISOString(),
				latencyMs: Math.max(0, this.now() - startedAt),
				// Re-checked here, whatever the definition did: a model id reaches a
				// command line, and a third-party kind's list is untrusted input.
				models: (Array.isArray(outcome.models) ? outcome.models : [])
					.filter((model) => model && isUsableLocalModelId(model.id))
					.slice(0, LOCAL_AI_MAX_MODELS),
				version: typeof outcome.version === 'string' ? outcome.version : null,
				error: null,
				apis: [...provider.apis]
			};
		} catch (error) {
			next = {
				...previous,
				status: 'down',
				checkedAt: new Date(this.now()).toISOString(),
				latencyMs: null,
				models: [],
				version: null,
				error: this.scrub(describeError(error), key),
				apis: [...provider.apis]
			};
		} finally {
			clearTimeout(timer);
		}
		this.stored.set(provider.id, { status: next, checkedAtMs: this.now() });
		this.announce(provider, previous, next);
	}

	/** One log line per CHANGE of health — never per probe. */
	private announce(
		provider: LocalAiProviderSettings,
		previous: LocalAiProviderStatus,
		next: LocalAiProviderStatus
	): void {
		if (!this.logger || previous.status === next.status) return;
		const name = `[local-ai] provider "${provider.id}" (${provider.kind}, ${provider.baseUrl})`;
		if (next.status === 'up') {
			const models = next.models.map((model) => model.id);
			this.logger.info(
				`${name} is up — ${models.length} model(s)${models.length > 0 ? `: ${models.slice(0, 6).join(', ')}` : ''}`
			);
		} else {
			this.logger.warn(`${name} is down — ${next.error ?? 'no answer'}`);
		}
	}

	private scrub(text: string, key: string | null): string {
		const once = key && key.length > 0 ? text.split(key).join('[redacted]') : text;
		return this.logger ? this.logger.redact(once) : once;
	}
}

function unknownStatus(provider: LocalAiProviderSettings): LocalAiProviderStatus {
	return {
		id: provider.id,
		kind: provider.kind,
		status: 'unknown',
		checkedAt: null,
		latencyMs: null,
		models: [],
		version: null,
		error: null,
		apis: [...provider.apis]
	};
}

function describeError(error: unknown): string {
	if (error instanceof LocalAiHttpError || error instanceof LocalAiSecretError) return error.message;
	const message = error instanceof Error ? error.message : String(error);
	return `the probe failed: ${message.slice(0, 200)}`;
}
