import type { FetchLike } from '../fleet-client';
import type { Logger } from '../logger';
import { readExtraCapabilitiesEnv, resolveLocalAiSettings, type NodeLocalAiConfig } from './config';
import { LocalAiMonitor } from './monitor';
import { defaultLocalAiProviderRegistry, type LocalAiProviderRegistry } from './registry';
import { readKeyFileFromDisk, type LocalAiSecretIo } from './secrets';
import { normalizeExtraCapabilities } from './tags';

/** What a node shell (the `start` runtime, `local-ai`, `capabilities`) builds local AI from. */
export interface NodeLocalAiSetupInput {
	/** `config.localAi` (shape-sanitised by `parseConfig`). */
	stored?: NodeLocalAiConfig | null;
	/** `config.extraCapabilities`. */
	extraCapabilities?: readonly string[] | null;
	/** The process environment: the `EVER_WORKS_NODE_LOCAL_AI_*` shorthand and `apiKeyEnv` lookups. */
	env: Readonly<Record<string, string | undefined>>;
	fetchFn: FetchLike;
	logger?: Logger;
	registry?: LocalAiProviderRegistry;
	/** Test seam: replaces the real key-file reader. */
	readKeyFile?: LocalAiSecretIo['readKeyFile'];
	now?: () => number;
}

export interface NodeLocalAiSetup {
	/** Null when nothing is configured: the node then behaves exactly as before local AI. */
	monitor: LocalAiMonitor | null;
	/** Validated extra tags (config + env), ready for `CapabilityEnvironment.extraCapabilities`. */
	extraCapabilities: string[];
	/** One line per entry that was dropped or will fail closed — logged at startup, printed by `local-ai list`. */
	problems: string[];
}

/**
 * Resolve the node's local AI and extra tags from its config and environment.
 * Pure apart from what it is handed: no network, no disk (the monitor reads
 * keys and probes only when asked).
 */
export function setupNodeLocalAi(input: NodeLocalAiSetupInput): NodeLocalAiSetup {
	const registry = input.registry ?? defaultLocalAiProviderRegistry();
	const { settings, problems } = resolveLocalAiSettings({ stored: input.stored ?? null, env: input.env }, registry);
	const extras = normalizeExtraCapabilities([
		...(input.extraCapabilities ?? []),
		...readExtraCapabilitiesEnv(input.env)
	]);
	const monitor = settings
		? new LocalAiMonitor({
				settings,
				registry,
				fetchFn: input.fetchFn,
				secrets: { readKeyFile: input.readKeyFile ?? readKeyFileFromDisk, env: input.env },
				...(input.logger ? { logger: input.logger } : {}),
				...(input.now ? { now: input.now } : {})
			})
		: null;
	return { monitor, extraCapabilities: extras.tags, problems: [...problems, ...extras.problems] };
}
