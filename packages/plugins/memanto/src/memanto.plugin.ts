import type {
	IPlugin,
	IAgentMemoryPlugin,
	PluginContext,
	PluginCategory,
	JsonSchema,
	ValidationResult,
	ConnectionValidationResult,
	PluginManifest,
	PluginHealthCheck,
	PluginSettings,
	AgentMemorySession,
	AgentMemorySessionInput,
	AgentMemoryRecord,
	AgentMemorySaveInput,
	AgentMemorySearchInput,
	AgentMemorySearchResponse,
	AgentMemoryContext,
	AgentMemoryContextInput
} from '@ever-works/plugin';
import { randomUUID } from 'node:crypto';

import { MemantoClient, type MemantoTokenStore } from './memanto-client.js';
import {
	buildWriteTags,
	clampText,
	composeRecordId,
	deriveAgentId,
	normalizeUserTags,
	packContext,
	parseRecordId,
	projectTag,
	sanitizeAgentId,
	toAgentMemoryRecord,
	toMemantoType
} from './memanto-mapping.js';
import {
	DEFAULT_AGENT_PREFIX,
	DEFAULT_BASE_URL,
	DEFAULT_RECALL_LIMIT,
	DEFAULT_TIMEOUT_MS,
	ENV_VAR_AGENT_ID,
	ENV_VAR_AGENT_PREFIX,
	ENV_VAR_API_KEY,
	ENV_VAR_BASE_URL,
	MAX_TIMEOUT_MS,
	MEMANTO_MAX_CONTENT_CHARS,
	MEMANTO_MAX_QUERY_CHARS,
	MEMANTO_MAX_RECALL_LIMIT,
	MEMANTO_SOURCE,
	type MemantoMemoryItem,
	type MemantoSettings
} from './types.js';

/** Default context budget when the caller gives none (matches the recall helper's 1500-token default). */
const DEFAULT_CONTEXT_TOKENS = 1500;
const CHARS_PER_TOKEN = 4;
/** How many memories `buildContext` pulls before packing to the budget. */
const CONTEXT_CANDIDATES = 30;

/**
 * Memanto plugin — `agent-memory` capability backed by a Memanto server
 * (https://github.com/moorcheh-ai/memanto), and the platform's DEFAULT
 * agent-memory provider whenever it is enabled.
 *
 * Why it is the preferred default (comparison in the package README and
 * `docs/plugin-system/built-in-plugins.md`): semantic recall over Moorcheh
 * instead of agentmemory's keyless BM25 default, typed memories (13 types:
 * fact, decision, preference, instruction, …) assigned with no LLM call per
 * write, a reversible expiry lifecycle, temporal recall, and published
 * LongMemEval-S / LoCoMo QA scores (89.8% / 87.1%, self-reported). It is
 * NOT auto-enabled: it needs a Memanto server plus a Moorcheh backend —
 * Moorcheh Cloud (`MOORCHEH_API_KEY`, paid beyond the trial) or Moorcheh
 * on-prem, whose Community Edition licence is single-node and
 * non-commercial. agentmemory stays the zero-config, fully offline option.
 *
 * Mapping (see `memanto-mapping.ts` for the details):
 *   - project (Work id) → one Memanto agent `<agentPrefix>-<projectId>`
 *     (one Moorcheh namespace), auto-created on first use; or every project
 *     pinned to one `agentId`, separated by an internal project tag.
 *   - metadata (incl. the API's `ownerUserId` IDOR stamp) → reserved tags,
 *     decoded back on read — Memanto has no metadata field.
 *   - record id → `<memantoAgentId>:<memoryId>`, so `deleteEntry(id)` finds
 *     the right agent without a project.
 *   - sessions → Ever Works-side ids recorded as a tag on every memory the
 *     session writes. Memanto's own "session" is an auth session (one per
 *     agent), handled inside `MemantoClient`.
 *   - `buildContext` → semantic recall (or most-recent when there is no
 *     query), packed best-first into the token budget. No `/answer` call, so
 *     recall never spends LLM credits.
 */
export class MemantoPlugin implements IPlugin, IAgentMemoryPlugin {
	readonly id = 'memanto';
	readonly name = 'Memanto Memory';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities = ['agent-memory'] as const;
	readonly configurationMode = 'hybrid' as const;
	readonly providerName = 'memanto';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			baseUrl: {
				type: 'string',
				title: 'Memanto server URL',
				description:
					'REST endpoint of your Memanto server (`memanto serve`, default http://localhost:8000). For an in-cluster deployment use http://memanto.<namespace>.svc.cluster.local:8000. Falls back to the MEMANTO_BASE_URL env var when empty.',
				// No schema `default`: the settings service resolves an unset field
				// to its schema default, which would shadow the env-var fallback in
				// resolveSettings. The client applies the default itself.
				'x-scope': 'user'
			},
			apiKey: {
				type: 'string',
				title: 'Management key',
				description:
					"The Memanto server's management credential: its MOORCHEH_API_KEY when it runs on Moorcheh Cloud, or its MEMANTO_SECRET_KEY on Moorcheh on-prem. Leave empty only for a server on the same machine (loopback). Falls back to the MEMANTO_API_KEY env var.",
				'x-secret': true,
				'x-scope': 'user'
			},
			agentPrefix: {
				type: 'string',
				title: 'Agent id prefix',
				description:
					"Each Work gets its own Memanto agent (and Moorcheh namespace) named '<prefix>-<workId>'. Change the prefix to keep several Ever Works installs apart on one Memanto server. Falls back to MEMANTO_AGENT_PREFIX, then 'ever-works'.",
				// No schema `default`: the settings service resolves an unset field
				// to its schema default, which would shadow the env-var fallback in
				// resolveSettings. The client applies the default itself.
				'x-scope': 'user'
			},
			agentId: {
				type: 'string',
				title: 'Single shared agent (optional)',
				description:
					"Store every Work's memory in this ONE Memanto agent instead of one agent per Work, keeping Works apart with an internal tag. Use it on Moorcheh's free tier (20 namespaces), or to share one memory with Memanto's own MCP / Claude Code integrations. Letters, digits, '-' and '_' only. Falls back to MEMANTO_AGENT_ID.",
				'x-scope': 'work'
			},
			minSimilarity: {
				type: 'number',
				title: 'Minimum similarity (optional)',
				description:
					'Drop recalled memories scoring below this similarity (0-1). Empty returns the best matches whatever their score.',
				minimum: 0,
				maximum: 1,
				'x-scope': 'user'
			},
			timeoutMs: {
				type: 'number',
				title: 'Request timeout (ms)',
				default: DEFAULT_TIMEOUT_MS,
				minimum: 1000,
				maximum: MAX_TIMEOUT_MS,
				'x-scope': 'user'
			}
		},
		required: []
	};

	private context: PluginContext | null = null;

	// ── IPlugin lifecycle ──────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('memanto plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = null;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return { status: 'healthy', message: 'memanto plugin is ready', checkedAt: Date.now() };
	}

	async isAvailable(): Promise<boolean> {
		// Connectivity is per-call and per-scope (baseUrl / key are user settings).
		return true;
	}

	async validateSettings(settings: Record<string, unknown>): Promise<ValidationResult> {
		const errors: { path: string; message: string }[] = [];
		const baseUrl = settings.baseUrl;
		if (baseUrl !== undefined && baseUrl !== '' && typeof baseUrl !== 'string') {
			errors.push({ path: 'baseUrl', message: '`baseUrl` must be a string' });
		} else if (typeof baseUrl === 'string' && baseUrl) {
			let url: URL | null = null;
			try {
				url = new URL(baseUrl);
			} catch {
				errors.push({ path: 'baseUrl', message: '`baseUrl` is not a valid URL' });
			}
			if (url && url.protocol !== 'http:' && url.protocol !== 'https:') {
				errors.push({ path: 'baseUrl', message: '`baseUrl` must be http:// or https://' });
			} else if (url && isCloudMetadataHost(baseUrl)) {
				errors.push({
					path: 'baseUrl',
					message: '`baseUrl` must not target a cloud metadata / link-local address'
				});
			}
		}
		for (const key of ['agentPrefix', 'agentId'] as const) {
			const v = settings[key];
			if (v === undefined || v === '') continue;
			if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(v)) {
				errors.push({
					path: key,
					message: `\`${key}\` may contain only letters, digits, '-' and '_' (max 48 characters)`
				});
			}
		}
		const minSimilarity = settings.minSimilarity;
		if (
			minSimilarity !== undefined &&
			minSimilarity !== null &&
			minSimilarity !== '' &&
			(typeof minSimilarity !== 'number' || minSimilarity < 0 || minSimilarity > 1)
		) {
			errors.push({ path: 'minSimilarity', message: '`minSimilarity` must be a number between 0 and 1' });
		}
		const timeoutMs = settings.timeoutMs;
		if (
			timeoutMs !== undefined &&
			(typeof timeoutMs !== 'number' || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS)
		) {
			errors.push({
				path: 'timeoutMs',
				message: `\`timeoutMs\` must be a number between 1000 and ${MAX_TIMEOUT_MS}`
			});
		}
		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	async validateConnection(rawSettings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const settings = this.resolveSettings(rawSettings);
		try {
			const client = this.buildClient(settings);
			const health = await client.health();
			if (health.status !== 'healthy') {
				return {
					success: false,
					message: `Memanto at ${settings.baseUrl ?? DEFAULT_BASE_URL} is up but reports "${health.status ?? 'unknown'}"${
						health.moorcheh_connected === false ? ' — it cannot reach its Moorcheh backend' : ''
					}.`
				};
			}
			// /health is public — prove the management credential too.
			await client.listAgents();
			return {
				success: true,
				message:
					`Connected to Memanto ${health.version ?? ''} at ${settings.baseUrl ?? DEFAULT_BASE_URL}.`.replace(
						'  ',
						' '
					)
			};
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : 'Connection validation failed' };
		}
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Typed, semantic long-term memory for agents, backed by a Memanto server (Moorcheh Cloud or on-prem). The default agent-memory provider when enabled.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: false,
			visibility: 'public',
			defaultForCapabilities: ['agent-memory'],
			homepage: 'https://github.com/moorcheh-ai/memanto',
			uiHints: {
				includeInOnboarding: false,
				completionFields: ['baseUrl', 'apiKey']
			}
		};
	}

	// ── IAgentMemoryPlugin ────────────────────────────────────────────

	/**
	 * Memanto has no work-session concept, so the session is an Ever Works id
	 * that tags every memory written under it. Opening one also warms the
	 * Memanto agent (auto-create + activate) so the first save of a run does
	 * not pay that latency, and surfaces a misconfiguration at run start.
	 */
	async openSession(input: AgentMemorySessionInput): Promise<AgentMemorySession> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const { agentId } = this.target(settings, input.projectId);
		await client.ensureSession(agentId);
		return {
			id: `ews_${randomUUID().replace(/-/g, '')}`,
			startedAt: new Date().toISOString(),
			...(input.metadata ? { metadata: input.metadata } : {})
		};
	}

	/** Idempotent no-op: nothing server-side to close (the contract allows it). */
	async closeSession(_sessionId: string, _settings?: PluginSettings): Promise<void> {
		return;
	}

	async saveMemory(input: AgentMemorySaveInput): Promise<AgentMemoryRecord> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const { agentId, projectTagValue } = this.target(settings, input.projectId);
		const content = (input.content ?? '').trim();
		if (!content) throw new Error('memanto saveMemory: content is empty');

		const { tags, droppedMetadataKeys } = buildWriteTags({
			userTags: input.tags,
			metadata: input.metadata,
			sessionId: input.sessionId,
			projectTagValue
		});
		if (droppedMetadataKeys.length > 0) {
			this.context?.logger.warn(
				`memanto: metadata keys not stored (no metadata field; not tag-encodable or over the 20-tag cap): ${droppedMetadataKeys.join(', ')}`
			);
		}

		const body: Record<string, unknown> = {
			content: clampText(content, MEMANTO_MAX_CONTENT_CHARS),
			tags,
			source: MEMANTO_SOURCE
		};
		const meta = input.metadata ?? {};
		const type = toMemantoType(meta.memoryType);
		if (type) body.type = type;
		if (typeof meta.title === 'string' && meta.title.trim()) body.title = clampText(meta.title.trim(), 100);
		if (typeof meta.confidence === 'number' && meta.confidence >= 0 && meta.confidence <= 1) {
			body.confidence = meta.confidence;
		}

		const res = await client.remember(agentId, body);
		if (!res?.memory_id) throw new Error('memanto saveMemory: server returned no memory_id');
		return {
			id: composeRecordId(agentId, res.memory_id),
			content: body.content as string,
			...(input.tags ? { tags: normalizeUserTags(input.tags) } : {}),
			metadata: { ...(input.metadata ?? {}), ...(res.type ? { memoryType: res.type } : {}) },
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			...(input.projectId ? { projectId: input.projectId } : {}),
			createdAt: new Date().toISOString()
		};
	}

	async searchMemory(input: AgentMemorySearchInput): Promise<AgentMemorySearchResponse> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const { agentId, projectTagValue } = this.target(settings, input.projectId);
		const limit = clampLimit(input.limit ?? DEFAULT_RECALL_LIMIT);
		const filterTags = normalizeUserTags(input.tags);
		if (projectTagValue) filterTags.push(projectTag(projectTagValue));

		const query = clampText((input.query ?? '').trim(), MEMANTO_MAX_QUERY_CHARS);
		// A blank / wildcard query has no semantic meaning — answer newest first.
		const wantsRecent = !query || query === '*';
		const body: Record<string, unknown> = { limit, status: 'active' };
		if (filterTags.length > 0) body.tags = filterTags;
		if (!wantsRecent) {
			body.query = query;
			if (typeof settings.minSimilarity === 'number' && settings.minSimilarity > 0) {
				body.min_similarity = settings.minSimilarity;
			}
		}
		const res = wantsRecent ? await client.recallRecent(agentId, body) : await client.recall(agentId, body);
		return {
			results: (res.memories ?? []).map((m) => toAgentMemoryRecord(m, agentId, input.projectId))
		};
	}

	async buildContext(input: AgentMemoryContextInput): Promise<AgentMemoryContext> {
		const settings = this.resolveSettings(input.settings);
		const client = this.buildClient(settings);
		const { agentId, projectTagValue } = this.target(settings, input.projectId);
		const maxChars = Math.max(200, (input.maxTokens ?? DEFAULT_CONTEXT_TOKENS) * CHARS_PER_TOKEN);

		const body: Record<string, unknown> = { limit: CONTEXT_CANDIDATES, status: 'active' };
		if (projectTagValue) body.tags = [projectTag(projectTagValue)];

		const query = clampText((input.query ?? '').trim(), MEMANTO_MAX_QUERY_CHARS);
		let items: readonly MemantoMemoryItem[];
		if (query) {
			const recallBody: Record<string, unknown> = { ...body, query };
			if (typeof settings.minSimilarity === 'number' && settings.minSimilarity > 0) {
				recallBody.min_similarity = settings.minSimilarity;
			}
			items = (await client.recall(agentId, recallBody)).memories ?? [];
		} else {
			items = (await client.recallRecent(agentId, body)).memories ?? [];
		}

		const { content, used } = packContext(items, maxChars);
		return {
			content,
			approxTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
			references: used.map((m) => toAgentMemoryRecord(m, agentId, input.projectId))
		};
	}

	/**
	 * Permanent delete (Memanto `DELETE /memories/{id}`) — the GDPR / "forget"
	 * path. The composite record id names the Memanto agent; a bare id falls
	 * back to the scope's default agent.
	 */
	async deleteEntry(id: string, settingsOverride?: PluginSettings): Promise<void> {
		if (!id) throw new Error('memanto deleteEntry: missing id');
		const settings = this.resolveSettings(settingsOverride);
		const client = this.buildClient(settings);
		const parsed = parseRecordId(id);
		const agentId = parsed.agentId ?? this.target(settings, undefined).agentId;
		if (!parsed.memoryId) throw new Error('memanto deleteEntry: malformed id');
		await client.deleteMemory(agentId, parsed.memoryId);
	}

	/** Every active and expired memory of the scope's default agent (Memanto `recall/all`). */
	async exportAll(settingsOverride?: PluginSettings): Promise<unknown> {
		const settings = this.resolveSettings(settingsOverride);
		const client = this.buildClient(settings);
		const { agentId } = this.target(settings, undefined);
		const res = await client.recallAll(agentId, {});
		return {
			provider: this.providerName,
			agentId,
			memories: (res.memories ?? []).map((m) => toAgentMemoryRecord(m, agentId))
		};
	}

	// ── helpers ────────────────────────────────────────────────────────

	/** Which Memanto agent serves this project, and the project tag when agents are shared. */
	private target(
		settings: MemantoSettings,
		projectId: string | undefined
	): { agentId: string; projectTagValue?: string } {
		if (settings.agentId) {
			const agentId = sanitizeAgentId(settings.agentId) || DEFAULT_AGENT_PREFIX;
			return projectId ? { agentId, projectTagValue: projectId } : { agentId };
		}
		return { agentId: deriveAgentId(settings.agentPrefix, projectId) };
	}

	private resolveSettings(rawSettings?: PluginSettings | Record<string, unknown>): MemantoSettings {
		const flat = flattenSettings(rawSettings);
		const str = (key: string, env: string): string | undefined =>
			typeof flat[key] === 'string' && flat[key] ? (flat[key] as string) : envOf(env);
		const out: MemantoSettings = {};
		const baseUrl = str('baseUrl', ENV_VAR_BASE_URL);
		if (baseUrl) out.baseUrl = baseUrl;
		const apiKey = str('apiKey', ENV_VAR_API_KEY);
		if (apiKey) out.apiKey = apiKey;
		const agentPrefix = str('agentPrefix', ENV_VAR_AGENT_PREFIX);
		if (agentPrefix) out.agentPrefix = agentPrefix;
		const agentId = str('agentId', ENV_VAR_AGENT_ID);
		if (agentId) out.agentId = agentId;
		if (typeof flat.minSimilarity === 'number') out.minSimilarity = flat.minSimilarity;
		if (typeof flat.timeoutMs === 'number') out.timeoutMs = flat.timeoutMs;
		return out;
	}

	private buildClient(settings: MemantoSettings): MemantoClient {
		// Security (SSRF): every operation funnels through here — refuse the
		// cloud metadata service before any request (same guard as agentmemory).
		if (settings.baseUrl && isCloudMetadataHost(settings.baseUrl)) {
			throw new Error(
				'memanto baseUrl is not allowed to target a cloud metadata / link-local address (SSRF guard blocked the destination host).'
			);
		}
		return new MemantoClient({
			baseUrl: settings.baseUrl,
			apiKey: settings.apiKey,
			timeoutMs: settings.timeoutMs,
			tokenStore: this.tokenStore(),
			logger: this.context?.logger ?? console
		});
	}

	private tokenStore(): MemantoTokenStore | undefined {
		const cache = this.context?.cache;
		if (!cache) return undefined;
		return {
			get: (key) => cache.get<string>(key),
			set: (key, value, ttl) => cache.set(key, value, ttl),
			delete: async (key) => {
				await cache.delete(key);
			}
		};
	}
}

function clampLimit(raw: number): number {
	const n = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_RECALL_LIMIT;
	return Math.min(Math.max(n, 1), MEMANTO_MAX_RECALL_LIMIT);
}

/** The facade pre-flattens settings; tests and `validateConnection` may pass the scoped shape. */
function flattenSettings(rawSettings: unknown): Record<string, unknown> {
	if (!rawSettings || typeof rawSettings !== 'object') return {};
	const obj = rawSettings as Record<string, unknown>;
	if ('admin' in obj || 'user' in obj || 'work' in obj || 'effective' in obj) {
		const effective = obj.effective as Record<string, unknown> | undefined;
		if (effective) return effective;
		return {
			...((obj.admin as Record<string, unknown>) || {}),
			...((obj.user as Record<string, unknown>) || {}),
			...((obj.work as Record<string, unknown>) || {})
		};
	}
	return obj;
}

function envOf(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Security (SSRF — cloud-metadata exfiltration). `baseUrl` is a tenant
 * setting used verbatim for every request, and error bodies flow back through
 * `validateConnection`. Loopback / private-LAN hosts stay allowed (Memanto is
 * self-hosted); only the never-legitimate IMDS / link-local surface is blocked.
 */
export function isCloudMetadataHost(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	let host = url.hostname.toLowerCase();
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
	if (host === 'metadata.google.internal' || host === 'metadata.goog') return true;
	if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
	if (host === 'fd00:ec2::254' || host === '::ffff:169.254.169.254' || host === '::ffff:a9fe:a9fe') return true;
	return false;
}
