import {
	FLEET_LOCAL_AI_LANE_CONSENT,
	FLEET_LOCAL_AI_LANE_KINDS,
	type FleetConsents,
	type FleetJobKind
} from '@ever-works/contracts';
import type { WorkerPollCadence } from '../worker-loop';
import { localAiCompletionSettings } from './config';
import type { LocalAiSettings } from './types';

/**
 * The LOCAL-AI lane: a lease loop of its own, beside the work lane, that
 * serves the platform's `ai-completion` jobs.
 *
 *   - Its own concurrency (`localAi.completions.concurrency`, default 1): a
 *     GPU node answers completions without taking an Agent's `--concurrency`
 *     slot, and an Agent's run never waits behind a completion. The work lane
 *     never leases the kind (contracts' {@link FLEET_LOCAL_AI_LANE_KINDS}).
 *   - Only under the `work` consent (`--work`), only with a provider
 *     configured and completions not switched off.
 *   - It asks for work only while a provider is up (the lease gate), and the
 *     node advertises `local-ai-completions` only while the lane runs, so the
 *     platform offers it completions only then.
 *   - A short lease (renewed at a third of it while a request runs), so a
 *     completion handed back — a provider that went away between the lease
 *     and the request — is re-offered within a minute.
 */

/** Lease requested for a completion; renewed by the worker loop while the provider answers. */
export const LOCAL_AI_LANE_LEASE_TTL_SEC = 60;

/** How often a lane that served a completion recently asks for the next one. */
export const LOCAL_AI_LANE_FAST_POLL_MS = 1_000;

/** How long a lane stays on the fast poll after it last leased a completion. */
export const LOCAL_AI_LANE_WARM_WINDOW_MS = 120_000;

/** What the runtime builds the lane from, or why it does not. */
export type LocalAiLanePlan =
	| {
			enabled: true;
			kinds: FleetJobKind[];
			concurrency: number;
			idlePollMs: number;
			maxTimeoutMs: number;
	  }
	| { enabled: false; reason: string };

/** Decide the lane for this process from its consents and the resolved local-AI settings. */
export function planLocalAiLane(consents: FleetConsents, settings: LocalAiSettings | null): LocalAiLanePlan {
	if (!settings || settings.providers.length === 0) {
		return { enabled: false, reason: 'no local AI provider is configured' };
	}
	if (consents[FLEET_LOCAL_AI_LANE_CONSENT] !== true) {
		return { enabled: false, reason: 'the node was not started with --work' };
	}
	const completions = localAiCompletionSettings(settings);
	if (!completions.enabled) {
		return { enabled: false, reason: 'completions are switched off (localAi.completions.enabled)' };
	}
	return {
		enabled: true,
		kinds: [...FLEET_LOCAL_AI_LANE_KINDS],
		concurrency: completions.concurrency,
		idlePollMs: completions.idlePollMs,
		maxTimeoutMs: completions.maxTimeoutMs
	};
}

/**
 * The lane's idle cadence: every second for a while after it leased a
 * completion (a pipeline sends the next request the moment it has the last
 * answer), the configured idle poll otherwise.
 */
export class LocalAiLaneCadence implements WorkerPollCadence {
	private warmUntil = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly options: {
			idlePollMs: number;
			fastPollMs?: number;
			warmWindowMs?: number;
			now?: () => number;
		}
	) {}

	recordPoll(leased: number): void {
		if (leased > 0) this.warmUntil = this.now() + (this.options.warmWindowMs ?? LOCAL_AI_LANE_WARM_WINDOW_MS);
	}

	nextIdleDelayMs(): number {
		const fast = Math.min(this.options.fastPollMs ?? LOCAL_AI_LANE_FAST_POLL_MS, this.options.idlePollMs);
		return this.now() < this.warmUntil ? fast : this.options.idlePollMs;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}
