import type { ConfigFileSystem } from '../core/config-store';
import type { FetchLike } from '../core/fleet-client';
import type { Logger } from '../core/logger';
import {
	defaultLocalAiProviderRegistry,
	evaluateLocalAiRuntime,
	isLocalAiWireApi,
	LOCAL_AI_ENV,
	EXTRA_CAPABILITIES_ENV,
	runLocalAiSmokeTest,
	sanitizeStoredLocalAiConfig,
	setupNodeLocalAi,
	type LocalAiMonitor,
	type LocalAiProviderSettings,
	type LocalAiProviderStatus,
	type LocalAiWireApi,
	type NodeLocalAiConfig,
	type NodeLocalAiSetup
} from '../core/local-ai';

/**
 * `ever-works-node local-ai list | probe | test` — what this machine's local
 * AI providers are, whether they answer, and which agent CLI runs on them.
 *
 *   list   the configuration as the node resolves it — no network;
 *   probe  ask every provider for its health and models now, and say whether
 *          each bound agent CLI could take a Task (exit 1 when not);
 *   test   one tiny real request per wire API to one provider, so an operator
 *          sees which APIs actually work before binding a CLI (exit 1 on a
 *          failure). The only command that makes a model generate anything.
 *
 * Read-only: none of them writes the config. Keys are never printed — only
 * where each one is read from.
 */

/** What the `local-ai` commands need from the CLI shell. */
export interface LocalAiCliDeps {
	fs: Pick<ConfigFileSystem, 'readFile'>;
	configPath: string;
	out(line: string): void;
	env: Readonly<Record<string, string | undefined>>;
	io: { fetchFn: FetchLike; logger: Logger };
	now?: () => number;
	/** Test seam: the key-file reader. */
	readKeyFile?: (path: string) => Promise<string | null>;
}

export interface LocalAiCommandOptions {
	json?: boolean;
}

export interface LocalAiTestCommandOptions extends LocalAiCommandOptions {
	provider?: string;
	model?: string;
	api?: string;
	/** Seconds per request (default 120 — a first request may wait for a model to load). */
	timeout?: string;
}

/** A `local-ai` command that ran and found something wrong; the CLI turns it into exit 1. */
export class LocalAiCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LocalAiCommandError';
	}
}

const DEFAULT_TEST_TIMEOUT_SEC = 120;
const MAX_TEST_TIMEOUT_SEC = 600;

/**
 * The stored `localAi` section and extra tags, read straight from the config
 * FILE — without the credential, so these commands work on a machine whose
 * keychain is locked, and before it is enrolled (an env-only setup).
 */
export async function readStoredLocalAi(
	deps: Pick<LocalAiCliDeps, 'fs' | 'configPath'>
): Promise<{ stored: NodeLocalAiConfig | null; extraCapabilities: string[] }> {
	let raw: string | null = null;
	try {
		raw = await deps.fs.readFile(deps.configPath);
	} catch {
		raw = null;
	}
	if (!raw) return { stored: null, extraCapabilities: [] };
	try {
		const parsed = JSON.parse(raw) as { localAi?: unknown; extraCapabilities?: unknown };
		return {
			stored: sanitizeStoredLocalAiConfig(parsed?.localAi) ?? null,
			extraCapabilities: Array.isArray(parsed?.extraCapabilities)
				? parsed.extraCapabilities.filter((tag): tag is string => typeof tag === 'string')
				: []
		};
	} catch {
		return { stored: null, extraCapabilities: [] };
	}
}

/** Resolve the node's local AI exactly as `start` does. */
export async function loadNodeLocalAi(deps: LocalAiCliDeps): Promise<NodeLocalAiSetup> {
	const { stored, extraCapabilities } = await readStoredLocalAi(deps);
	return setupNodeLocalAi({
		stored,
		extraCapabilities,
		env: deps.env,
		fetchFn: deps.io.fetchFn,
		logger: deps.io.logger,
		...(deps.readKeyFile ? { readKeyFile: deps.readKeyFile } : {}),
		...(deps.now ? { now: deps.now } : {})
	});
}

function describeKey(provider: LocalAiProviderSettings): string {
	if (!provider.apiKey) return 'none (keyless)';
	return provider.apiKey.source === 'file' ? `file ${provider.apiKey.path}` : `env ${provider.apiKey.name}`;
}

/** The settings as safe JSON: locations of keys, never values. */
function providerJson(provider: LocalAiProviderSettings): Record<string, unknown> {
	return {
		id: provider.id,
		kind: provider.kind,
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey ? { ...provider.apiKey } : null,
		models: [...provider.models],
		defaultModel: provider.defaultModel,
		apis: [...provider.apis],
		apisDeclared: provider.apisDeclared
	};
}

function printNotConfigured(deps: LocalAiCliDeps): void {
	deps.out('No local AI is configured on this machine.');
	deps.out(
		`Add a "localAi" section to ${deps.configPath}, or set ${LOCAL_AI_ENV.kind} / ${LOCAL_AI_ENV.baseUrl} ` +
			'(and optionally the key file, model and agent CLI) in the node’s environment. See the README, "Local AI".'
	);
}

/** `local-ai list` — the resolved configuration. No network. */
export async function runLocalAiList(deps: LocalAiCliDeps, options: LocalAiCommandOptions = {}): Promise<void> {
	const setup = await loadNodeLocalAi(deps);
	const monitor = setup.monitor;
	if (options.json) {
		deps.out(
			JSON.stringify(
				{
					kinds: (monitor?.registry ?? defaultLocalAiProviderRegistry()).definitions().map((definition) => ({
						kind: definition.kind,
						name: definition.displayName,
						defaultBaseUrl: definition.defaultBaseUrl ?? null,
						defaultApis: [...definition.defaultApis]
					})),
					providers: monitor ? monitor.settings.providers.map(providerJson) : [],
					agentRuntimes: monitor ? monitor.settings.agentRuntimes.map((runtime) => ({ ...runtime })) : [],
					extraCapabilities: setup.extraCapabilities,
					problems: setup.problems
				},
				null,
				2
			)
		);
		return;
	}
	if (!monitor) {
		printNotConfigured(deps);
	} else {
		for (const provider of monitor.settings.providers) {
			deps.out(`provider     ${provider.id} (${provider.kind})`);
			deps.out(`  address    ${provider.baseUrl}`);
			deps.out(`  key        ${describeKey(provider)}`);
			deps.out(
				`  apis       ${provider.apis.join(', ') || '(none)'}${provider.apisDeclared ? '' : ' (the kind’s defaults)'}`
			);
			deps.out(`  model      ${provider.defaultModel ?? '(none set)'}`);
			if (provider.models.length > 0) deps.out(`  models     ${provider.models.join(', ')}`);
		}
		if (monitor.settings.providers.length === 0) deps.out('provider     (none valid)');
		for (const runtime of monitor.settings.agentRuntimes) {
			deps.out(
				`agent        ${runtime.cli} runs on provider ${runtime.provider || '(none)'}` +
					`${runtime.model ? `, model ${runtime.model}` : ''}`
			);
		}
		if (monitor.settings.agentRuntimes.length === 0) {
			deps.out('agent        (no agent CLI is bound — Tasks run on the CLIs’ own sign-in)');
		}
	}
	deps.out(
		`extra tags   ${setup.extraCapabilities.join(', ') || `(none — config "extraCapabilities" or ${EXTRA_CAPABILITIES_ENV})`}`
	);
	for (const problem of setup.problems) deps.out(`problem      ${problem}`);
}

function statusLine(status: LocalAiProviderStatus): string {
	if (status.status !== 'up') return `${status.status.toUpperCase()} — ${status.error ?? 'not probed'}`;
	const models = status.models
		.slice(0, 8)
		.map((model) => `${model.id}${model.loaded ? ' (loaded)' : ''}`)
		.join(', ');
	return `up in ${status.latencyMs ?? '?'} ms${status.version ? `, version ${status.version}` : ''} — ${
		status.models.length
	} model(s)${models ? `: ${models}` : ''}`;
}

/** `local-ai probe` — health, models, bindings and the tags this node would advertise. Exit 1 when anything is down. */
export async function runLocalAiProbe(deps: LocalAiCliDeps, options: LocalAiCommandOptions = {}): Promise<void> {
	const setup = await loadNodeLocalAi(deps);
	const monitor = setup.monitor;
	if (!monitor) {
		if (options.json) {
			deps.out(JSON.stringify({ providers: [], agentRuntimes: [], tags: [], problems: setup.problems }, null, 2));
			return;
		}
		printNotConfigured(deps);
		for (const problem of setup.problems) deps.out(`problem      ${problem}`);
		return;
	}
	const statuses = await monitor.refresh();
	const runtimes = monitor.settings.agentRuntimes.map((runtime) =>
		evaluateLocalAiRuntime(runtime, monitor.settings, statuses, monitor.registry)
	);
	const facts = monitor.capabilityFacts();
	if (options.json) {
		deps.out(
			JSON.stringify(
				{
					providers: statuses,
					agentRuntimes: runtimes.map((evaluation) =>
						evaluation.ok
							? {
									cli: evaluation.runtime.cli,
									provider: evaluation.provider.id,
									ready: true,
									model: evaluation.model,
									api: evaluation.api,
									endpoint: evaluation.endpoint
								}
							: {
									cli: evaluation.runtime.cli,
									provider: evaluation.runtime.provider,
									ready: false,
									reason: evaluation.reason
								}
					),
					tags: facts.tags,
					withheld: facts.unavailableClis,
					problems: setup.problems
				},
				null,
				2
			)
		);
	} else {
		for (const status of statuses)
			deps.out(`${status.id.padEnd(12)} ${status.kind.padEnd(18)} ${statusLine(status)}`);
		for (const evaluation of runtimes) {
			deps.out(
				evaluation.ok
					? `agent        ${evaluation.runtime.cli}: READY — model ${evaluation.model} over ${evaluation.api} at ${evaluation.endpoint}`
					: `agent        ${evaluation.runtime.cli}: NOT READY — ${evaluation.reason}`
			);
		}
		deps.out(`tags         ${facts.tags.join(', ') || '(none)'}`);
		if (facts.unavailableClis.length > 0) {
			deps.out(`withheld     ${facts.unavailableClis.join(', ')} (bound to local AI that cannot serve it now)`);
		}
		for (const problem of setup.problems) deps.out(`problem      ${problem}`);
	}
	const down = statuses.filter((status) => status.status !== 'up').map((status) => status.id);
	const notReady = runtimes.filter((evaluation) => !evaluation.ok).map((evaluation) => evaluation.runtime.cli);
	if (down.length > 0 || notReady.length > 0) {
		throw new LocalAiCommandError(
			[
				down.length > 0 ? `local AI provider(s) down: ${down.join(', ')}` : '',
				notReady.length > 0 ? `agent CLI(s) that cannot run on local AI now: ${notReady.join(', ')}` : ''
			]
				.filter(Boolean)
				.join('; ')
		);
	}
}

function pickProvider(monitor: LocalAiMonitor, requested: string | undefined): LocalAiProviderSettings {
	const providers = monitor.settings.providers;
	if (requested) {
		const found = providers.find((provider) => provider.id === requested);
		if (!found) {
			throw new LocalAiCommandError(
				`No local AI provider "${requested}" — configured: ${providers.map((provider) => provider.id).join(', ') || 'none'}`
			);
		}
		return found;
	}
	const bound = monitor.settings.agentRuntimes
		.map((runtime) => providers.find((provider) => provider.id === runtime.provider))
		.find((provider): provider is LocalAiProviderSettings => provider !== undefined);
	if (bound) return bound;
	if (providers.length === 1) return providers[0]!;
	throw new LocalAiCommandError(
		`Name the provider to test with --provider (configured: ${providers.map((provider) => provider.id).join(', ') || 'none'})`
	);
}

function parseTimeoutSeconds(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_TEST_TIMEOUT_SEC;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > MAX_TEST_TIMEOUT_SEC) {
		throw new LocalAiCommandError(`--timeout must be a whole number of seconds from 1 to ${MAX_TEST_TIMEOUT_SEC}`);
	}
	return value;
}

/** `local-ai test` — one tiny real request per wire API. Exit 1 when any fails. */
export async function runLocalAiTest(deps: LocalAiCliDeps, options: LocalAiTestCommandOptions = {}): Promise<void> {
	const timeoutSec = parseTimeoutSeconds(options.timeout);
	let apis: LocalAiWireApi[] | undefined;
	if (options.api !== undefined) {
		if (!isLocalAiWireApi(options.api)) {
			throw new LocalAiCommandError('--api must be openai-chat, openai-responses or anthropic-messages');
		}
		apis = [options.api];
	}
	const setup = await loadNodeLocalAi(deps);
	const monitor = setup.monitor;
	if (!monitor || monitor.settings.providers.length === 0) {
		printNotConfigured(deps);
		throw new LocalAiCommandError('Nothing to test: no valid local AI provider is configured');
	}
	const provider = pickProvider(monitor, options.provider);
	const [status] = (await monitor.refresh()).filter((candidate) => candidate.id === provider.id);
	const runtimeModel = monitor.settings.agentRuntimes.find((runtime) => runtime.provider === provider.id)?.model;
	const model =
		options.model ??
		runtimeModel ??
		provider.defaultModel ??
		provider.models[0] ??
		status?.models.find((candidate) => candidate.loaded)?.id ??
		status?.models[0]?.id;
	if (!model) {
		throw new LocalAiCommandError(
			`No model to test on "${provider.id}": pass --model, or set the provider's defaultModel` +
				(status?.status === 'down' ? ` (the provider is down: ${status.error ?? 'no answer'})` : '')
		);
	}
	if (!options.json) {
		deps.out(
			`testing      ${provider.id} (${provider.kind}) at ${provider.baseUrl}, model ${model} — ${status ? statusLine(status) : 'not probed'}`
		);
	}
	const results = await runLocalAiSmokeTest(monitor, provider, {
		model,
		...(apis ? { apis } : {}),
		timeoutMs: timeoutSec * 1000,
		...(deps.now ? { now: deps.now } : {})
	});
	if (options.json) {
		deps.out(JSON.stringify({ provider: provider.id, model, results }, null, 2));
	} else {
		for (const result of results) {
			deps.out(
				`${result.api.padEnd(20)} ${result.ok ? 'OK  ' : 'FAIL'} ${result.latencyMs} ms — ${result.detail}`
			);
		}
		if (results.length === 0) deps.out('(the provider declares no wire API — set its "apis")');
	}
	const failed = results.filter((result) => !result.ok).map((result) => result.api);
	if (failed.length > 0) {
		throw new LocalAiCommandError(`${provider.id}: ${failed.join(', ')} did not answer correctly`);
	}
}
