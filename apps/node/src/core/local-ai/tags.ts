import {
	FLEET_ATTENDED_CAPABILITY,
	FLEET_BROWSER_CAPABILITY,
	FLEET_INPUT_CAPABILITY,
	FLEET_LOCAL_AI_CAPABILITY,
	FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY,
	FLEET_LOCAL_AI_KIND_CAPABILITY_PREFIX,
	FLEET_LOCAL_MODEL_CAPABILITY_PREFIX,
	FLEET_PUSH_CAPABILITY,
	FLEET_SCREEN_CAPABILITY,
	FLEET_SESSIONS_CAPABILITY,
	FLEET_USAGE_SCAN_CAPABILITY,
	fleetLocalAgentCapability,
	fleetLocalModelTagSlug,
	isFleetLocalAiCapability,
	type FleetAgentExecutionProvider
} from '@ever-works/contracts';
import { FLEET_MANAGED_CAPABILITY } from '../link/modules/control';
import { MAX_CAPABILITY_TAG_LENGTH } from '../types';
import { evaluateLocalAiRuntime } from './agent-binding';
import type { LocalAiProviderRegistry } from './registry';
import type { LocalAiProviderStatus, LocalAiSettings } from './types';

/**
 * Capability tags for local AI, and the operator's extra tags.
 *
 * The node's tag list is capped (32 by default, CONTRACTS `FLEET_DEFAULT_MAX_CAPABILITY_TAGS`)
 * and truncated from the END, so everything here is bounded on its own and
 * appended after the tags older nodes already advertised.
 */

/** Most local-AI tags one node advertises, all families together. */
export const LOCAL_AI_MAX_TAGS = 8;
/** Most `local-model:<id>` tags among them. */
export const LOCAL_AI_MAX_MODEL_TAGS = 4;
/** Most operator-declared extra tags. */
export const MAX_EXTRA_CAPABILITIES = 8;

/**
 * The tag grammar every built-in tag already follows: lower-case words of
 * letters, digits, `.`, `_`, `-`, optionally `family:value` (`gpu:nvidia`,
 * `screen:desktop`). Extra tags are held to it so they read like the rest.
 */
export const CAPABILITY_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)*$/;

/**
 * Tags an operator may NOT declare by hand: machine identity (the scheduler
 * places work by it), the local-AI family (backed by the probe), and every tag
 * whose PRESENCE is a containment or consent promise the node keeps by itself
 * — a hand-written `git-push` would route Tasks to a Git that cannot install
 * the per-run credential, a hand-written `claude-code` to a machine without
 * the CLI.
 */
const RESERVED_TAG_PREFIXES = ['os:', 'arch:', 'node:', 'screen:', 'helper:'] as const;
const RESERVED_TAGS = new Set<string>([
	FLEET_PUSH_CAPABILITY,
	FLEET_ATTENDED_CAPABILITY,
	FLEET_SCREEN_CAPABILITY,
	FLEET_INPUT_CAPABILITY,
	FLEET_SESSIONS_CAPABILITY,
	FLEET_USAGE_SCAN_CAPABILITY,
	FLEET_BROWSER_CAPABILITY,
	FLEET_MANAGED_CAPABILITY,
	'claude-code',
	'codex'
]);

/** Validate the operator's extra tags: grammar, length, not reserved, de-duplicated, bounded. */
export function normalizeExtraCapabilities(raw: readonly unknown[] | undefined): {
	tags: string[];
	problems: string[];
} {
	const tags: string[] = [];
	const problems: string[] = [];
	for (const entry of raw ?? []) {
		if (typeof entry !== 'string') continue;
		const tag = entry.trim();
		if (!tag) continue;
		if (tag.length > MAX_CAPABILITY_TAG_LENGTH || !CAPABILITY_TAG_PATTERN.test(tag)) {
			problems.push(
				`extra capability "${tag.slice(0, 40)}" ignored — tags are lower-case letters, digits, ".", "_", "-" ` +
					`and ":" (at most ${MAX_CAPABILITY_TAG_LENGTH} characters)`
			);
			continue;
		}
		if (
			RESERVED_TAGS.has(tag) ||
			RESERVED_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix)) ||
			isFleetLocalAiCapability(tag)
		) {
			problems.push(`extra capability "${tag}" ignored — this node decides that tag itself`);
			continue;
		}
		if (tags.includes(tag)) continue;
		if (tags.length >= MAX_EXTRA_CAPABILITIES) {
			problems.push(`extra capability "${tag}" ignored — at most ${MAX_EXTRA_CAPABILITIES} extra tags`);
			continue;
		}
		tags.push(tag);
	}
	return { tags, problems };
}

/**
 * A model id as a tag VALUE: lower-cased, every character outside the tag
 * grammar (`:` and `/` of `qwen3:8b`, `org/model`) folded to `-`. Null when the
 * resulting `local-model:<slug>` would not fit a tag. Lossy on purpose — the
 * tag is a routing hint, the exact id lives in the run.
 *
 * The normalisation itself lives in the contracts (`fleetLocalModelTagSlug`),
 * so the platform computes the SAME tag when it routes an `ai-completion` to a
 * model this node advertised.
 */
export function localModelTagSlug(modelId: string): string | null {
	return fleetLocalModelTagSlug(modelId);
}

/** What the node's lanes add to the local-AI tags. */
export interface LocalAiCapabilityOptions {
	/** The local-AI lane runs (`--work`, completions on): advertise `local-ai-completions`. */
	servesCompletions?: boolean;
}

/** What local AI contributes to one heartbeat's capability list. */
export interface LocalAiCapabilityFacts {
	/** Tags to advertise, bounded by {@link LOCAL_AI_MAX_TAGS}. */
	tags: string[];
	/**
	 * Agent CLIs bound to a local provider that cannot run now. Their own tag
	 * (`claude-code`, `codex`) is WITHHELD, the same way a missing binary
	 * withholds it — so the platform stops leasing this node work it would
	 * have to decline.
	 */
	unavailableClis: FleetAgentExecutionProvider[];
}

/**
 * The tags and the withheld CLIs for the providers as last probed.
 *
 * Order (the cap keeps the first): `local-ai`, `local-ai-completions` when
 * this node serves the platform's `ai-completion` jobs, `local-agent:<cli>` per
 * bound CLI that can run, `local-ai:<kind>` per healthy kind, then
 * `local-model:<id>` — the bound models first, then each healthy provider's
 * default and declared models, then what it lists.
 */
export function localAiCapabilityFacts(
	settings: LocalAiSettings | null,
	statuses: readonly LocalAiProviderStatus[],
	registry: LocalAiProviderRegistry,
	options: LocalAiCapabilityOptions = {}
): LocalAiCapabilityFacts {
	if (!settings) return { tags: [], unavailableClis: [] };
	const up = new Map(statuses.filter((status) => status.status === 'up').map((status) => [status.id, status]));
	const healthy = settings.providers.filter((provider) => up.has(provider.id));

	const tags: string[] = [];
	const unavailableClis: FleetAgentExecutionProvider[] = [];
	const boundModels: string[] = [];
	const agentTags: string[] = [];
	for (const runtime of settings.agentRuntimes) {
		const evaluation = evaluateLocalAiRuntime(runtime, settings, statuses, registry);
		if (evaluation.ok) {
			agentTags.push(fleetLocalAgentCapability(runtime.cli));
			boundModels.push(evaluation.model);
		} else if (!unavailableClis.includes(runtime.cli)) {
			unavailableClis.push(runtime.cli);
		}
	}
	if (healthy.length === 0) return { tags: [], unavailableClis };

	tags.push(FLEET_LOCAL_AI_CAPABILITY);
	// Only beside a healthy provider, like every tag of the family: a lane with
	// nothing to forward to must not be offered completions.
	if (options.servesCompletions === true) tags.push(FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY);
	tags.push(...agentTags);
	for (const provider of healthy) {
		const tag = `${FLEET_LOCAL_AI_KIND_CAPABILITY_PREFIX}${provider.kind}`;
		if (!tags.includes(tag)) tags.push(tag);
	}

	const modelSlugs: string[] = [];
	const offerModel = (id: string): void => {
		if (modelSlugs.length >= LOCAL_AI_MAX_MODEL_TAGS) return;
		const slug = localModelTagSlug(id);
		if (slug && !modelSlugs.includes(slug)) modelSlugs.push(slug);
	};
	for (const model of boundModels) offerModel(model);
	for (const provider of healthy) {
		const served = (up.get(provider.id)?.models ?? []).map((model) => model.id);
		const declared = [provider.defaultModel, ...provider.models].filter(
			(id): id is string => typeof id === 'string' && served.includes(id)
		);
		for (const id of declared) offerModel(id);
		// The server's own list only when the operator declared none: a
		// declared list is the operator saying which of them matter.
		if (provider.models.length === 0) for (const id of served) offerModel(id);
	}
	for (const slug of modelSlugs) tags.push(`${FLEET_LOCAL_MODEL_CAPABILITY_PREFIX}${slug}`);

	return { tags: tags.slice(0, LOCAL_AI_MAX_TAGS), unavailableClis };
}
