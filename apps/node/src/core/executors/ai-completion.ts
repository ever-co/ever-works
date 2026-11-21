import {
	FLEET_AI_COMPLETION_MAX_REQUEST_BYTES,
	FLEET_AI_COMPLETION_MAX_RESPONSE_BYTES,
	normalizeFleetAiCompletionPayload,
	readFleetAiCompletionUsage,
	validateFleetAiCompletionRequestBody,
	type FleetAiCompletionResult,
	type FleetJobView
} from '@ever-works/contracts';
import type { Logger } from '../logger';
import { decodeLocalAiCompletionBody, encodeLocalAiCompletionBody } from '../local-ai/completion-codec';
import { selectLocalAiCompletionTarget } from '../local-ai/completion';
import { LocalAiHttpError } from '../local-ai/http';
import { LOCAL_AI_RUN_MAX_STATUS_AGE_MS, type LocalAiMonitor } from '../local-ai/monitor';
import { LocalAiSecretError } from '../local-ai/secrets';
import type { JobLeaseHandle } from '../worker-loop';

/**
 * The `ai-completion` executor: relay ONE model request to a healthy local AI
 * provider on this node and complete the job with its answer.
 *
 * ## What it guarantees
 *
 *   - **Only to this node's own provider.** The URL comes from the provider's
 *     validated settings and the wire table, never from the job, and must be
 *     on the provider's own origin; the key is read at use time and sent in
 *     that one request.
 *   - **Never logs content.** One line per completion — job id, wire API,
 *     model, provider id, status, latency, token counts — and never a byte of
 *     the prompt or the answer. Errors carry fixed-shape reasons.
 *   - **Bounded.** The request is bounded encoded and decoded, the provider's
 *     answer by size and by the job's budget (clamped to the operator's
 *     ceiling), and the answer that comes back must fit the encoded cap.
 *   - **Hands back what it cannot serve.** No healthy provider for the model
 *     (it went down since the heartbeat), or a provider unreachable at the
 *     transport — the job is DEFERRED (no verdict; the platform re-offers it,
 *     to this node or another), never failed and never sent elsewhere.
 *   - **Free.** `costUsd: 0`, `costBasis: 'local'`.
 *
 * A provider that answers with an error status (a context that is too long,
 * a model it cannot load) is an ANSWER: it goes back with its status, so the
 * caller sees the same error it would see against the server directly.
 */

/** The monitor surface the executor needs (the real `LocalAiMonitor`, or a test double). */
export type AiCompletionMonitor = Pick<LocalAiMonitor, 'settings' | 'registry' | 'current' | 'forward' | 'recheck'>;

export interface AiCompletionExecutorDeps {
	monitor: AiCompletionMonitor;
	/** The operator's ceiling on one request's provider budget (`localAi.completions.maxTimeoutSec`). */
	maxTimeoutMs: number;
	logger?: Logger;
	now?: () => number;
}

/** `90 s`, or `500 ms` under a second. */
function describeBudget(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/** A provider's error body that is not JSON is replaced by this shape (never relayed raw). */
function providerErrorBody(status: number): Record<string, unknown> {
	return {
		error: {
			message: `the local AI provider answered HTTP ${status}`,
			type: 'local_ai_provider_error',
			code: status
		}
	};
}

export async function runAiCompletionJob(
	job: FleetJobView,
	signal: AbortSignal,
	lease: JobLeaseHandle | undefined,
	deps: AiCompletionExecutorDeps
): Promise<Record<string, unknown> | void> {
	const now = deps.now ?? Date.now;
	const parsed = normalizeFleetAiCompletionPayload(job.payload);
	if (!parsed.ok) throw new Error(`ai-completion refused: ${parsed.reason}`);
	const payload = parsed.value;
	let decoded: unknown;
	try {
		decoded = decodeLocalAiCompletionBody(
			payload.body,
			payload.bodyEncoding,
			FLEET_AI_COMPLETION_MAX_REQUEST_BYTES
		);
	} catch (error) {
		throw new Error(`ai-completion refused: ${(error as Error).message}`);
	}
	const body = validateFleetAiCompletionRequestBody(payload.api, decoded);
	if (!body.ok) throw new Error(`ai-completion refused: ${body.reason}`);

	// What is true NOW, not at the last heartbeat: a provider that went away
	// since then is re-probed (bounded) before anything is sent.
	const statuses = await deps.monitor.current({
		maxAgeMs: Math.min(LOCAL_AI_RUN_MAX_STATUS_AGE_MS, deps.monitor.settings.probeIntervalMs)
	});
	const selection = selectLocalAiCompletionTarget(
		deps.monitor.settings,
		statuses,
		deps.monitor.registry,
		payload.api,
		payload.model
	);
	if (!selection.ok) return handBack(lease, selection.reason, deps.logger, job.id);
	const { provider, modelId, url, headers } = selection.target;

	const timeoutMs = Math.max(1, Math.min(payload.timeoutSec * 1000, deps.maxTimeoutMs));
	const startedAt = now();
	let answer: { status: number; text: string };
	try {
		answer = await deps.monitor.forward(
			provider,
			{
				url,
				label: `${provider.id} ${payload.api}`,
				// The node writes the model id the provider serves, and never streams.
				body: { ...body.value, model: modelId, stream: false },
				headers
			},
			{ timeoutMs, maxBytes: FLEET_AI_COMPLETION_MAX_RESPONSE_BYTES, signal }
		);
	} catch (error) {
		if (error instanceof LocalAiSecretError) {
			// The key went missing between the probe and the request: this node
			// cannot serve it now, another may.
			return handBack(lease, `local AI provider "${provider.id}": ${error.message}`, deps.logger, job.id);
		}
		if (error instanceof LocalAiHttpError && error.failure === 'network') {
			// Nothing reached the provider: hand the job back and have the
			// monitor see it down before the next lease.
			void deps.monitor.recheck(provider.id);
			return handBack(
				lease,
				`local AI provider "${provider.id}" is unreachable: ${error.message}`,
				deps.logger,
				job.id
			);
		}
		if (error instanceof LocalAiHttpError && error.failure === 'timeout') {
			throw new Error(
				`the local AI provider "${provider.id}" did not answer within ${describeBudget(timeoutMs)}`
			);
		}
		throw error;
	}
	const latencyMs = Math.max(0, now() - startedAt);

	let json: unknown;
	try {
		json = JSON.parse(answer.text) as unknown;
	} catch {
		if (answer.status >= 200 && answer.status < 300) {
			throw new Error(`the local AI provider "${provider.id}" answered with a body that is not JSON`);
		}
		json = providerErrorBody(answer.status);
	}
	if (answer.status >= 300 && (!json || typeof json !== 'object' || Array.isArray(json))) {
		json = providerErrorBody(answer.status);
	}
	const usage = readFleetAiCompletionUsage(payload.api, json);
	const encoded = encodeLocalAiCompletionBody(json);

	deps.logger?.info(
		`[local-ai] ai-completion ${job.id}: ${payload.api} ${modelId} on "${provider.id}" → HTTP ${answer.status} in ${latencyMs} ms${
			usage ? ` (${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out tokens)` : ''
		}`
	);

	const result: FleetAiCompletionResult = {
		status: answer.status,
		body: encoded.body,
		bodyEncoding: encoded.bodyEncoding,
		providerId: provider.id,
		providerKind: provider.kind,
		model: modelId,
		latencyMs,
		usage,
		costUsd: 0,
		costBasis: 'local'
	};
	return result as unknown as Record<string, unknown>;
}

/**
 * Hand the job back unsettled (the platform re-offers it once the lease
 * lapses). Without a lease handle (an embedder that has none) there is no
 * way to decline, so it fails naming the reason instead.
 */
function handBack(lease: JobLeaseHandle | undefined, reason: string, logger: Logger | undefined, jobId: string): void {
	if (!lease) throw new Error(`ai-completion not served here: ${reason}`);
	logger?.warn(`[local-ai] ai-completion ${jobId} handed back: ${reason}`);
	lease.defer(reason);
}
