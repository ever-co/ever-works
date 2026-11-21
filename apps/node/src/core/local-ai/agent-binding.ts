import type { FleetAgentExecutionProvider } from '@ever-works/contracts';
import type { ModelCliLocalProvider } from '../executors/model-cli';
import { LOCAL_AI_BASE_URL_PATTERN } from './config';
import { isSameLocalAiOrigin } from './http';
import type { LocalAiProviderRegistry } from './registry';
import {
	defaultLocalAiEndpoint,
	type LocalAiAgentRuntimeSettings,
	type LocalAiProviderSettings,
	type LocalAiProviderStatus,
	type LocalAiSettings,
	type LocalAiWireApi
} from './types';

/**
 * How an agent CLI is pointed at a local provider.
 *
 * Keyed by the WIRE API a CLI speaks, never by provider kind: Claude Code
 * needs a server that answers the Anthropic Messages API, Codex one that
 * answers the OpenAI Responses API, and which product serves it is
 * irrelevant here. A new provider kind therefore needs nothing in this file;
 * a new agent CLI adds one entry to {@link LOCAL_AI_CLI_WIRE_API} and its
 * launch branch below.
 */
export const LOCAL_AI_CLI_WIRE_API: Readonly<Record<FleetAgentExecutionProvider, LocalAiWireApi>> = {
	'claude-code': 'anthropic-messages',
	codex: 'openai-responses'
};

/**
 * Credential and endpoint variables a local run must NOT inherit, whatever the
 * job's `envPassthrough` / `envGrants` say.
 *
 * The platform grants a run its cloud credentials by NAME (by default
 * `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_ACCESS_TOKEN`,
 * `OPENAI_API_KEY`). On a local run they are dead weight at best — and at worst
 * the CLI's own precedence picks one of them over the local endpoint and the
 * run silently bills the cloud seat. They are stripped from the name lists
 * before the env is built, so they never reach the child; the local endpoint
 * and token are then set by the overlay, which the command runner applies last.
 */
export const LOCAL_AI_REPLACED_ENV_NAMES: readonly string[] = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_BASE_URL',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'AWS_BEARER_TOKEN_BEDROCK',
	'CODEX_ACCESS_TOKEN',
	'OPENAI_API_KEY',
	'OPENAI_BASE_URL'
];

/** `names` without {@link LOCAL_AI_REPLACED_ENV_NAMES} (case-insensitive: Windows env names are). */
export function withoutReplacedCredentialNames(names: readonly string[] | undefined): string[] | undefined {
	if (!names) return names;
	const replaced = new Set(LOCAL_AI_REPLACED_ENV_NAMES.map((name) => name.toUpperCase()));
	return names.filter((name) => typeof name === 'string' && !replaced.has(name.toUpperCase()));
}

/**
 * The token Claude Code is given for a KEYLESS server (Ollama, LM Studio).
 *
 * Never empty, on purpose: with no `ANTHROPIC_AUTH_TOKEN` Claude Code falls
 * back to the machine's own Claude login — and would send that subscription
 * token to the local server. A fixed placeholder is what keyless servers
 * expect (Ollama documents `ANTHROPIC_AUTH_TOKEN=ollama`).
 */
export const LOCAL_AI_KEYLESS_TOKEN = 'ever-works-local-ai';

/** The env var a Codex run reads its local provider's key from (`model_providers.<id>.env_key`). */
export const LOCAL_AI_CODEX_KEY_ENV = 'LOCAL_AI_API_KEY';

/** Why a runtime can or cannot run right now. */
export type LocalAiRuntimeEvaluation =
	| {
			ok: true;
			runtime: LocalAiAgentRuntimeSettings;
			provider: LocalAiProviderSettings;
			model: string;
			smallModel: string;
			api: LocalAiWireApi;
			/** Where the CLI is pointed for {@link api}. */
			endpoint: string;
	  }
	| { ok: false; runtime: LocalAiAgentRuntimeSettings; reason: string };

/**
 * Decide whether `runtime` can run on its provider as last probed.
 *
 * FAILS CLOSED on everything it cannot prove: a provider that is not
 * configured, not probed yet, down, missing the wire API the CLI needs, with
 * no model to run or not serving the one named. The reasons are one line each
 * and name the fix; none carries a secret.
 */
export function evaluateLocalAiRuntime(
	runtime: LocalAiAgentRuntimeSettings,
	settings: LocalAiSettings,
	statuses: readonly LocalAiProviderStatus[],
	registry: LocalAiProviderRegistry
): LocalAiRuntimeEvaluation {
	const fail = (reason: string): LocalAiRuntimeEvaluation => ({ ok: false, runtime, reason });
	if (!runtime.provider) return fail(`${runtime.cli} is bound to local AI but names no provider`);
	const provider = settings.providers.find((candidate) => candidate.id === runtime.provider);
	if (!provider) {
		return fail(
			`${runtime.cli} is bound to local AI provider "${runtime.provider}", which is not configured on this node ` +
				'(or was rejected — see `ever-works-node local-ai list`)'
		);
	}
	const api = LOCAL_AI_CLI_WIRE_API[runtime.cli];
	if (!provider.apis.includes(api)) {
		return fail(
			`local AI provider "${provider.id}" (${provider.kind}) does not speak ${api}, which ${runtime.cli} needs — ` +
				`add "${api}" to the provider's "apis" if the server serves it`
		);
	}
	const status = statuses.find((candidate) => candidate.id === provider.id);
	if (!status || status.status === 'unknown') {
		return fail(`local AI provider "${provider.id}" has not answered a probe yet`);
	}
	if (status.status === 'down') {
		return fail(`local AI provider "${provider.id}" is down: ${status.error ?? 'it did not answer its probe'}`);
	}
	const served = status.models.map((model) => model.id);
	const model =
		runtime.model ??
		provider.defaultModel ??
		(provider.models.length === 1 ? provider.models[0]! : null) ??
		(served.length === 1 ? served[0]! : null);
	if (!model) {
		return fail(
			`no model for ${runtime.cli} on local AI provider "${provider.id}" — set the agent runtime's "model" or ` +
				`the provider's "defaultModel"${served.length > 0 ? ` (it serves: ${served.slice(0, 8).join(', ')})` : ''}`
		);
	}
	if (served.length > 0 && !servesModel(served, model)) {
		return fail(
			`local AI provider "${provider.id}" does not serve model "${model}" (it serves: ${served.slice(0, 8).join(', ')})`
		);
	}
	if (served.length === 0) {
		return fail(`local AI provider "${provider.id}" answered but serves no models`);
	}
	const endpoint = resolveLocalAiEndpoint(registry, provider, api);
	if (!endpoint) {
		return fail(
			`the ${provider.kind} kind points ${api} away from provider "${provider.id}"'s own address — refused`
		);
	}
	return {
		ok: true,
		runtime,
		provider,
		model,
		smallModel: runtime.smallModel ?? model,
		api,
		endpoint
	};
}

/**
 * Where a client of `api` is pointed on `provider`: the kind's `endpoint()`
 * override, else the default layout. Null when an override leaves the
 * provider's own origin or is not a plain URL (the key would go with it), so
 * the caller refuses instead of following it.
 */
export function resolveLocalAiEndpoint(
	registry: LocalAiProviderRegistry,
	provider: LocalAiProviderSettings,
	api: LocalAiWireApi
): string | null {
	const definition = registry.has(provider.kind) ? registry.get(provider.kind) : null;
	const override = definition?.endpoint?.(provider, api);
	if (override === undefined) return defaultLocalAiEndpoint(provider.baseUrl, api);
	const value = typeof override === 'string' ? override.replace(/\/+$/, '') : '';
	return LOCAL_AI_BASE_URL_PATTERN.test(value) && isSameLocalAiOrigin(value, provider.baseUrl) ? value : null;
}

/** True when `served` lists `model` — Ollama's implicit `:latest` tag counted as the bare name. */
export function servesModel(served: readonly string[], model: string): boolean {
	if (served.includes(model)) return true;
	if (!model.includes(':') && served.includes(`${model}:latest`)) return true;
	if (model.endsWith(':latest') && served.includes(model.slice(0, -':latest'.length))) return true;
	return false;
}

/**
 * The binding the agent-task executor is handed for one run (`io.localAiRuntime`).
 *
 *   - `null` from the resolver — the CLI is not bound: an ordinary cloud run;
 *   - `unavailable` — bound, but it cannot run now: the node DECLINES the job
 *     (hands it back unsettled) rather than run it on the cloud seat;
 *   - `bound` — run it locally with what {@link buildLocalAgentLaunch} derives.
 */
export type LocalAiAgentBinding =
	| { kind: 'unavailable'; cli: FleetAgentExecutionProvider; providerId: string; reason: string }
	| {
			kind: 'bound';
			cli: FleetAgentExecutionProvider;
			providerId: string;
			providerKind: string;
			model: string;
			smallModel: string;
			api: LocalAiWireApi;
			endpoint: string;
			/** The provider key read for THIS run (file or env), or null for a keyless server. Never logged. */
			apiKey: string | null;
	  };

/** What the model step changes for a bound run. */
export interface LocalAgentLaunch {
	/** Applied LAST by the command runner, over its scrub (see `NodeCommandEnvOverlay`). */
	envOverlay: Record<string, string>;
	/** Replaces the job's (cloud) model on the CLI's command line. */
	model: string;
	/** Codex only: the `-c model_provider=…` override pointing it at the local server. */
	codexProvider?: ModelCliLocalProvider;
	/** Values scrubbed out of everything the run reports (the key). */
	protectedValues: string[];
}

/**
 * The env, model and Codex override for one bound run.
 *
 * Claude Code: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (the key, or the
 * keyless placeholder), every model slot it consults set to the local model
 * (main, the opus/sonnet/haiku aliases, the small/fast model, subagents), and
 * the switches that stop it sending telemetry, error reports and update
 * checks to Anthropic from a run that is meant to stay on the LAN.
 *
 * Codex: `-c model_provider=<id>` with that provider's `base_url`, `wire_api`
 * and (when keyed) `env_key`, the key in that env var.
 */
export function buildLocalAgentLaunch(binding: Extract<LocalAiAgentBinding, { kind: 'bound' }>): LocalAgentLaunch {
	const protectedValues = binding.apiKey ? [binding.apiKey] : [];
	if (binding.cli === 'claude-code') {
		return {
			model: binding.model,
			envOverlay: {
				ANTHROPIC_BASE_URL: binding.endpoint,
				ANTHROPIC_AUTH_TOKEN: binding.apiKey ?? LOCAL_AI_KEYLESS_TOKEN,
				ANTHROPIC_MODEL: binding.model,
				ANTHROPIC_DEFAULT_OPUS_MODEL: binding.model,
				ANTHROPIC_DEFAULT_SONNET_MODEL: binding.model,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: binding.smallModel,
				ANTHROPIC_SMALL_FAST_MODEL: binding.smallModel,
				CLAUDE_CODE_SUBAGENT_MODEL: binding.model,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				DISABLE_TELEMETRY: '1',
				DISABLE_ERROR_REPORTING: '1',
				DISABLE_AUTOUPDATER: '1'
			},
			protectedValues
		};
	}
	return {
		model: binding.model,
		envOverlay: binding.apiKey ? { [LOCAL_AI_CODEX_KEY_ENV]: binding.apiKey } : {},
		codexProvider: {
			id: binding.providerId,
			baseUrl: binding.endpoint,
			wireApi: 'responses',
			...(binding.apiKey ? { envKey: LOCAL_AI_CODEX_KEY_ENV } : {})
		},
		protectedValues
	};
}
