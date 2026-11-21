import { FLEET_AGENT_EXECUTION_MODEL_PATTERN, isFleetAgentExecutionProvider } from '@ever-works/contracts';
import type { LocalAiProviderRegistry } from './registry';
import {
	isLocalAiWireApi,
	type LocalAiAgentRuntimeSettings,
	type LocalAiApiKeyRef,
	type LocalAiProviderSettings,
	type LocalAiSettings,
	type LocalAiWireApi
} from './types';

/**
 * Local AI configuration: the `localAi` section of the node config file, the
 * `EVER_WORKS_NODE_LOCAL_AI_*` environment shorthand, and the validation that
 * turns both into {@link LocalAiSettings}.
 *
 * ## Secrets
 *
 * The config NEVER holds a key. A provider names WHERE its key is — a file
 * (`apiKeyFile`, read at use time so a rotated key needs no restart) or an
 * environment variable NAME (`apiKeyEnv`). Nothing here reads either; the
 * monitor does, at probe and run time, and protects the value in the logger.
 *
 * ## Validation posture
 *
 * Nothing here throws on operator input: a bad entry is DROPPED with a
 * problem line the node logs at startup and `ever-works-node local-ai list`
 * prints. The one thing that is never dropped is an `agentRuntime` whose
 * provider is invalid — it stays, so the binding fails CLOSED (the CLI's tag is
 * withdrawn and its jobs are declined) instead of quietly running on the cloud
 * seat the operator meant to replace.
 */

/** The `localAi` section as stored in `node-config.json`. Every field optional; validated on use. */
export interface NodeLocalAiConfig {
	providers?: NodeLocalAiProviderConfig[];
	/** One runtime, or one per agent CLI. */
	agentRuntime?: NodeLocalAiAgentRuntimeConfig | NodeLocalAiAgentRuntimeConfig[];
	/** How long a probe answer stays fresh, seconds (default 60, 10–3600). */
	probeIntervalSec?: number;
	/** Budget of one provider's probe, seconds (default 5, 1–30). */
	probeTimeoutSec?: number;
}

export interface NodeLocalAiProviderConfig {
	id?: string;
	kind?: string;
	baseUrl?: string;
	apiKeyFile?: string;
	apiKeyEnv?: string;
	models?: string[];
	defaultModel?: string;
	apis?: string[];
}

export interface NodeLocalAiAgentRuntimeConfig {
	cli?: string;
	provider?: string;
	model?: string;
	smallModel?: string;
}

/** Most providers one node may configure. */
export const LOCAL_AI_MAX_PROVIDERS = 8;
/** Most models one provider may declare. */
export const LOCAL_AI_MAX_DECLARED_MODELS = 32;

export const LOCAL_AI_DEFAULT_PROBE_INTERVAL_MS = 60_000;
export const LOCAL_AI_MIN_PROBE_INTERVAL_MS = 10_000;
export const LOCAL_AI_MAX_PROBE_INTERVAL_MS = 3_600_000;
export const LOCAL_AI_DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const LOCAL_AI_MIN_PROBE_TIMEOUT_MS = 1_000;
export const LOCAL_AI_MAX_PROBE_TIMEOUT_MS = 30_000;

/**
 * A provider id. It becomes a Codex config KEY (`model_providers.<id>`) on a
 * command line, so it is held to "bare identifier": no dot (TOML would read a
 * path), nothing a shell interprets.
 */
export const LOCAL_AI_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** An environment variable NAME (Windows names are case-insensitive; POSIX allows this shape). */
export const LOCAL_AI_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Rooted POSIX or Windows path (no `node:path`: a config can be copied between operating systems). */
const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:[/\\])/;

/**
 * The URL shape a base URL must have AFTER normalisation. It reaches a Codex
 * command line (`-c model_providers.<id>.base_url=…`, double-quoted), so it is
 * a positive pattern: scheme, host (name, IPv4 or bracketed IPv6), port,
 * plain path segments — nothing a shell, cmd.exe or a TOML parser could read
 * as structure (no `%`, `$`, quote, space, `?`, `#`, `@`).
 */
export const LOCAL_AI_BASE_URL_PATTERN =
	/^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * The environment shorthand: ONE provider and (optionally) its agent binding,
 * for a node run as a service whose settings live in an env file
 * (`/etc/default/ever-works-node`).
 */
export const LOCAL_AI_ENV = {
	kind: 'EVER_WORKS_NODE_LOCAL_AI_KIND',
	id: 'EVER_WORKS_NODE_LOCAL_AI_ID',
	baseUrl: 'EVER_WORKS_NODE_LOCAL_AI_BASE_URL',
	apiKeyFile: 'EVER_WORKS_NODE_LOCAL_AI_API_KEY_FILE',
	apiKeyEnv: 'EVER_WORKS_NODE_LOCAL_AI_API_KEY_ENV',
	model: 'EVER_WORKS_NODE_LOCAL_AI_MODEL',
	smallModel: 'EVER_WORKS_NODE_LOCAL_AI_SMALL_MODEL',
	models: 'EVER_WORKS_NODE_LOCAL_AI_MODELS',
	apis: 'EVER_WORKS_NODE_LOCAL_AI_APIS',
	agentCli: 'EVER_WORKS_NODE_LOCAL_AI_AGENT_CLI'
} as const;

/** Operator-declared extra capability tags (comma-separated), added to what the node detects. */
export const EXTRA_CAPABILITIES_ENV = 'EVER_WORKS_NODE_EXTRA_CAPABILITIES';

/**
 * Shape-only copy of a stored `localAi` section, for `parseConfig`: known keys,
 * primitive types, bounded arrays. Values are NOT validated here (that needs
 * the registry, and must be able to report problems) — `resolveLocalAiSettings`
 * does it. Undefined for anything that is not an object.
 */
export function sanitizeStoredLocalAiConfig(raw: unknown): NodeLocalAiConfig | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const source = raw as Record<string, unknown>;
	const out: NodeLocalAiConfig = {};
	if (Array.isArray(source.providers)) {
		out.providers = source.providers
			.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
			.slice(0, LOCAL_AI_MAX_PROVIDERS * 2)
			.map((entry) => {
				const provider: NodeLocalAiProviderConfig = {};
				for (const key of ['id', 'kind', 'baseUrl', 'apiKeyFile', 'apiKeyEnv', 'defaultModel'] as const) {
					if (typeof entry[key] === 'string') provider[key] = entry[key] as string;
				}
				for (const key of ['models', 'apis'] as const) {
					if (Array.isArray(entry[key])) {
						provider[key] = (entry[key] as unknown[])
							.filter((value): value is string => typeof value === 'string')
							.slice(0, LOCAL_AI_MAX_DECLARED_MODELS * 2);
					}
				}
				return provider;
			});
	}
	const runtime = (value: unknown): NodeLocalAiAgentRuntimeConfig | null => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		const entry = value as Record<string, unknown>;
		const out: NodeLocalAiAgentRuntimeConfig = {};
		for (const key of ['cli', 'provider', 'model', 'smallModel'] as const) {
			if (typeof entry[key] === 'string') out[key] = entry[key] as string;
		}
		return out;
	};
	if (Array.isArray(source.agentRuntime)) {
		out.agentRuntime = source.agentRuntime
			.map(runtime)
			.filter((entry): entry is NodeLocalAiAgentRuntimeConfig => entry !== null)
			.slice(0, 8);
	} else {
		const single = runtime(source.agentRuntime);
		if (single) out.agentRuntime = single;
	}
	for (const key of ['probeIntervalSec', 'probeTimeoutSec'] as const) {
		if (typeof source[key] === 'number' && Number.isFinite(source[key])) out[key] = source[key] as number;
	}
	return out;
}

/** Split a comma-separated env value; blanks dropped. */
function splitList(value: string | undefined): string[] {
	if (typeof value !== 'string') return [];
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Read an env var by exact name, trimmed; undefined when unset or blank. */
function readEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
	const value = env[name];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The provider + agent binding the environment shorthand describes, or nulls
 * when `EVER_WORKS_NODE_LOCAL_AI_KIND` is unset. `EVER_WORKS_NODE_LOCAL_AI_AGENT_CLI`
 * (`claude-code` / `codex`) binds that CLI to the env provider; `none` or
 * absent binds nothing.
 */
export function readLocalAiEnv(env: Readonly<Record<string, string | undefined>>): {
	provider: NodeLocalAiProviderConfig | null;
	agentRuntime: NodeLocalAiAgentRuntimeConfig | null;
} {
	const kind = readEnv(env, LOCAL_AI_ENV.kind);
	if (!kind) return { provider: null, agentRuntime: null };
	const provider: NodeLocalAiProviderConfig = { kind };
	const id = readEnv(env, LOCAL_AI_ENV.id);
	if (id) provider.id = id;
	const baseUrl = readEnv(env, LOCAL_AI_ENV.baseUrl);
	if (baseUrl) provider.baseUrl = baseUrl;
	const apiKeyFile = readEnv(env, LOCAL_AI_ENV.apiKeyFile);
	if (apiKeyFile) provider.apiKeyFile = apiKeyFile;
	const apiKeyEnv = readEnv(env, LOCAL_AI_ENV.apiKeyEnv);
	if (apiKeyEnv) provider.apiKeyEnv = apiKeyEnv;
	const model = readEnv(env, LOCAL_AI_ENV.model);
	if (model) provider.defaultModel = model;
	const models = splitList(env[LOCAL_AI_ENV.models]);
	if (models.length > 0) provider.models = models;
	const apis = splitList(env[LOCAL_AI_ENV.apis]);
	if (apis.length > 0) provider.apis = apis;
	const cli = readEnv(env, LOCAL_AI_ENV.agentCli);
	if (!cli || cli === 'none') return { provider, agentRuntime: null };
	const agentRuntime: NodeLocalAiAgentRuntimeConfig = { cli, provider: provider.id ?? kind };
	if (model) agentRuntime.model = model;
	const smallModel = readEnv(env, LOCAL_AI_ENV.smallModel);
	if (smallModel) agentRuntime.smallModel = smallModel;
	return { provider, agentRuntime };
}

/** The extra capability tags the environment declares (validated later, with the config's). */
export function readExtraCapabilitiesEnv(env: Readonly<Record<string, string | undefined>>): string[] {
	return splitList(env[EXTRA_CAPABILITIES_ENV]);
}

/**
 * Normalise a base URL to the server ROOT: trailing slashes and one trailing
 * `/v1` dropped (the platform's own `ollama` / `vllm` / `lm-studio` plugins
 * take `…/v1`; the node takes either). Null, with the reason, when it is not a
 * plain http(s) URL this node is willing to put on a command line.
 */
export function normalizeLocalAiBaseUrl(raw: string): { url: string } | { problem: string } {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return { problem: 'is not a URL' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { problem: 'must be an http:// or https:// URL' };
	}
	if (parsed.username || parsed.password) {
		// A credential in the URL would be printed by every status line and
		// handed to the CLI's argv. The key has its own field.
		return { problem: 'must not carry a user name or password (use apiKeyFile / apiKeyEnv)' };
	}
	if (parsed.search || parsed.hash) {
		return { problem: 'must not carry a query string or fragment' };
	}
	let path = parsed.pathname.replace(/\/+$/, '');
	if (/\/v1$/i.test(path)) path = path.slice(0, -3);
	const url = `${parsed.protocol}//${parsed.host}${path}`;
	if (!LOCAL_AI_BASE_URL_PATTERN.test(url)) {
		return { problem: 'contains characters this node does not put on a command line' };
	}
	return { url };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.round(value), min), max);
}

function isModelId(value: string): boolean {
	return FLEET_AGENT_EXECUTION_MODEL_PATTERN.test(value);
}

/** The input of {@link resolveLocalAiSettings}. */
export interface LocalAiSettingsInput {
	/** The stored `localAi` section (already shape-sanitised by `parseConfig`). */
	stored?: NodeLocalAiConfig | null;
	/** The process environment, for the `EVER_WORKS_NODE_LOCAL_AI_*` shorthand. */
	env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Validate and merge the config file's `localAi` and the env shorthand.
 *
 * The env provider REPLACES a file provider with the same id; the env agent
 * binding REPLACES the file's binding for the same CLI. `settings` is null when
 * nothing is configured, so a node without local AI behaves exactly as before.
 */
export function resolveLocalAiSettings(
	input: LocalAiSettingsInput,
	registry: LocalAiProviderRegistry
): { settings: LocalAiSettings | null; problems: string[] } {
	const problems: string[] = [];
	const stored = input.stored ?? {};
	const fromEnv = readLocalAiEnv(input.env ?? {});

	const rawProviders: Array<{ raw: NodeLocalAiProviderConfig; origin: string }> = (stored.providers ?? []).map(
		(raw, index) => ({ raw, origin: `localAi.providers[${index}]` })
	);
	if (fromEnv.provider) {
		const envId = fromEnv.provider.id ?? fromEnv.provider.kind;
		const replaced = rawProviders.findIndex(({ raw }) => (raw.id ?? raw.kind) === envId);
		const entry = { raw: fromEnv.provider, origin: `${LOCAL_AI_ENV.kind} (environment)` };
		if (replaced >= 0) rawProviders.splice(replaced, 1, entry);
		else rawProviders.push(entry);
	}

	const providers: LocalAiProviderSettings[] = [];
	for (const { raw, origin } of rawProviders) {
		if (providers.length >= LOCAL_AI_MAX_PROVIDERS) {
			problems.push(`${origin}: ignored — at most ${LOCAL_AI_MAX_PROVIDERS} local AI providers per node`);
			continue;
		}
		const provider = validateProvider(raw, origin, registry, problems);
		if (!provider) continue;
		if (providers.some((existing) => existing.id === provider.id)) {
			problems.push(`${origin}: ignored — another provider already has the id "${provider.id}"`);
			continue;
		}
		providers.push(provider);
	}

	const rawRuntimes: Array<{ raw: NodeLocalAiAgentRuntimeConfig; origin: string }> = (
		Array.isArray(stored.agentRuntime) ? stored.agentRuntime : stored.agentRuntime ? [stored.agentRuntime] : []
	).map((raw, index) => ({
		raw,
		origin: `localAi.agentRuntime${Array.isArray(stored.agentRuntime) ? `[${index}]` : ''}`
	}));
	if (fromEnv.agentRuntime) {
		const replaced = rawRuntimes.findIndex(({ raw }) => raw.cli === fromEnv.agentRuntime?.cli);
		const entry = { raw: fromEnv.agentRuntime, origin: `${LOCAL_AI_ENV.agentCli} (environment)` };
		if (replaced >= 0) rawRuntimes.splice(replaced, 1, entry);
		else rawRuntimes.push(entry);
	}
	const agentRuntimes: LocalAiAgentRuntimeSettings[] = [];
	for (const { raw, origin } of rawRuntimes) {
		const runtime = validateAgentRuntime(raw, origin, problems);
		if (!runtime) continue;
		if (agentRuntimes.some((existing) => existing.cli === runtime.cli)) {
			problems.push(`${origin}: ignored — ${runtime.cli} is already bound to a local provider`);
			continue;
		}
		if (runtime.provider && !providers.some((provider) => provider.id === runtime.provider)) {
			// Kept on purpose (see the module comment): the binding fails closed.
			problems.push(
				`${origin}: ${runtime.cli} is bound to provider "${runtime.provider}", which is not a valid ` +
					`configured provider — this node will NOT run ${runtime.cli} Tasks until that is fixed`
			);
		}
		agentRuntimes.push(runtime);
	}

	if (providers.length === 0 && agentRuntimes.length === 0) {
		return { settings: null, problems };
	}
	return {
		settings: {
			providers,
			agentRuntimes,
			probeIntervalMs: clamp(
				typeof stored.probeIntervalSec === 'number' ? stored.probeIntervalSec * 1000 : undefined,
				LOCAL_AI_DEFAULT_PROBE_INTERVAL_MS,
				LOCAL_AI_MIN_PROBE_INTERVAL_MS,
				LOCAL_AI_MAX_PROBE_INTERVAL_MS
			),
			probeTimeoutMs: clamp(
				typeof stored.probeTimeoutSec === 'number' ? stored.probeTimeoutSec * 1000 : undefined,
				LOCAL_AI_DEFAULT_PROBE_TIMEOUT_MS,
				LOCAL_AI_MIN_PROBE_TIMEOUT_MS,
				LOCAL_AI_MAX_PROBE_TIMEOUT_MS
			)
		},
		problems
	};
}

function validateProvider(
	raw: NodeLocalAiProviderConfig,
	origin: string,
	registry: LocalAiProviderRegistry,
	problems: string[]
): LocalAiProviderSettings | null {
	const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
	if (!kind) {
		problems.push(`${origin}: ignored — no "kind" (known: ${registry.kinds().join(', ')})`);
		return null;
	}
	if (!registry.has(kind)) {
		problems.push(`${origin}: ignored — unknown kind "${kind}" (known: ${registry.kinds().join(', ')})`);
		return null;
	}
	const definition = registry.get(kind);
	const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : kind;
	if (!LOCAL_AI_PROVIDER_ID_PATTERN.test(id)) {
		problems.push(
			`${origin}: ignored — id "${id}" must be lower-case letters, digits, "-" or "_" (at most 32 characters)`
		);
		return null;
	}
	const label = `${origin} ("${id}")`;
	const rawUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl : definition.defaultBaseUrl;
	if (!rawUrl) {
		problems.push(`${label}: ignored — "baseUrl" is required for kind ${kind}`);
		return null;
	}
	const normalized = normalizeLocalAiBaseUrl(rawUrl);
	if ('problem' in normalized) {
		problems.push(`${label}: ignored — baseUrl ${normalized.problem}`);
		return null;
	}

	let apiKey: LocalAiApiKeyRef | null = null;
	const keyFile = typeof raw.apiKeyFile === 'string' ? raw.apiKeyFile.trim() : '';
	const keyEnv = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : '';
	if (keyFile && keyEnv) {
		problems.push(`${label}: ignored — set apiKeyFile OR apiKeyEnv, not both`);
		return null;
	}
	if (keyFile) {
		if (!ABSOLUTE_PATH.test(keyFile)) {
			problems.push(`${label}: ignored — apiKeyFile must be an absolute path`);
			return null;
		}
		apiKey = { source: 'file', path: keyFile };
	} else if (keyEnv) {
		if (!LOCAL_AI_ENV_NAME_PATTERN.test(keyEnv)) {
			problems.push(`${label}: ignored — apiKeyEnv must be an environment variable NAME, not a value`);
			return null;
		}
		apiKey = { source: 'env', name: keyEnv };
	}

	const models: string[] = [];
	for (const model of raw.models ?? []) {
		const value = model.trim();
		if (!value) continue;
		if (!isModelId(value)) {
			problems.push(`${label}: model "${value.slice(0, 64)}" ignored — not an opaque model id`);
			continue;
		}
		if (!models.includes(value) && models.length < LOCAL_AI_MAX_DECLARED_MODELS) models.push(value);
	}
	let defaultModel: string | null = null;
	if (typeof raw.defaultModel === 'string' && raw.defaultModel.trim()) {
		const value = raw.defaultModel.trim();
		if (isModelId(value)) defaultModel = value;
		else problems.push(`${label}: defaultModel "${value.slice(0, 64)}" ignored — not an opaque model id`);
	}

	let apis: LocalAiWireApi[] = [...definition.defaultApis];
	let apisDeclared = false;
	if (Array.isArray(raw.apis)) {
		const declared: LocalAiWireApi[] = [];
		for (const api of raw.apis) {
			const value = api.trim();
			if (isLocalAiWireApi(value)) {
				if (!declared.includes(value)) declared.push(value);
			} else {
				problems.push(
					`${label}: api "${value.slice(0, 64)}" ignored (known: openai-chat, openai-responses, anthropic-messages)`
				);
			}
		}
		apis = declared;
		apisDeclared = true;
	}

	return { id, kind, baseUrl: normalized.url, apiKey, models, defaultModel, apis, apisDeclared };
}

function validateAgentRuntime(
	raw: NodeLocalAiAgentRuntimeConfig,
	origin: string,
	problems: string[]
): LocalAiAgentRuntimeSettings | null {
	const cli = typeof raw.cli === 'string' ? raw.cli.trim() : '';
	if (!isFleetAgentExecutionProvider(cli)) {
		problems.push(`${origin}: ignored — "cli" must be claude-code or codex`);
		return null;
	}
	const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
	if (!provider) {
		// Kept, failing closed: the operator asked for a local runtime.
		problems.push(`${origin}: ${cli} names no "provider" — this node will NOT run ${cli} Tasks until it does`);
	}
	const pick = (key: 'model' | 'smallModel'): string | null => {
		const value = typeof raw[key] === 'string' ? raw[key]!.trim() : '';
		if (!value) return null;
		if (isModelId(value)) return value;
		problems.push(`${origin}: ${key} "${value.slice(0, 64)}" ignored — not an opaque model id`);
		return null;
	};
	return { cli, provider, model: pick('model'), smallModel: pick('smallModel') };
}
