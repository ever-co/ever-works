import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isUUID } from 'class-validator';
import {
    FLEET_AI_COMPLETION_JOB_KIND,
    FLEET_AI_COMPLETION_MAX_REQUEST_BYTES,
    FLEET_JOB_QUEUE_EXPIRED_REASON,
    FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY,
    FLEET_NODE_NON_LEASABLE_STATUSES,
    fleetAiCompletionRequiredCapabilities,
    fleetLocalModelFromCapability,
    nodeSatisfiesCapabilities,
    normalizeFleetAiCompletionPayload,
    normalizeFleetAiCompletionResult,
    validateFleetAiCompletionRequestBody,
    type FleetAiCompletionBodyEncoding,
    type FleetAiCompletionFailure,
    type FleetAiCompletionResult,
    type FleetAiWireApi,
    type FleetJobStatus,
} from '@ever-works/contracts';
import { config } from '../../config';
import type { FleetNode } from '../../entities/fleet-node.entity';
import type { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobCompletedEvent } from '../../events/fleet-job.events';
import { FleetJobRepository } from '../fleet-job.repository';
import { FLEET_JOB_CANCELLED_ERROR, FleetJobService } from '../fleet-job.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import {
    decodeFleetAiCompletionBody,
    FleetAiCompletionCodecError,
} from './fleet-ai-completion.codec';

/**
 * Local AI completions — the platform's half: put ONE model request on the
 * owner's fleet as an `ai-completion` job, and hand its answer back.
 *
 * The callers are the local AI relay (`createFleetLocalAiRelay`), in process
 * in the API and over the Trigger.dev internal RPC from the worker — so every
 * method is a short call that RESOLVES with an outcome value (an error's class
 * does not survive that hop): `submit` enqueues, `awaitResult` long-polls a
 * bounded slice of the wait, `cancel` and `release` tidy up.
 *
 * ## What it guarantees
 *
 *   - **Only to the owner's own machines that can serve it.** The job requires
 *     `local-ai`, `local-ai-completions` and the model's `local-model:` tag, and
 *     the lease query offers a job only to its owner's nodes — so a completion
 *     never lands on a machine without a healthy local provider serving that
 *     model, and never on anyone else's.
 *   - **Refused before it is queued** when nothing could take it: the stop
 *     flag is set, the body is not a request the relay forwards, the model
 *     cannot be a tag, or no online node of the owner advertises the model
 *     (`no-node`, naming what to start).
 *   - **Free.** A local answer costs nothing: the job's cost is stamped `0`,
 *     no plugin usage is billed here and no daily ceiling is touched.
 *   - **Leaves nothing behind.** `release` purges the prompt and the answer
 *     from the job row as soon as the caller has the answer (the 30-day
 *     retention purge is only the backstop).
 *   - **Never logs content** — ids, the model and the outcome only.
 */

/** Longest single `awaitResult` slice: well inside the internal RPC's own timeout. */
export const FLEET_AI_COMPLETION_MAX_WAIT_SLICE_MS = 20_000;
/** How often a waiting slice re-reads the job (another API replica may be the one that settled it). */
export const FLEET_AI_COMPLETION_POLL_INTERVAL_MS = 750;

export interface FleetAiCompletionSubmitInput {
    userId: string;
    organizationId?: string | null;
    /** Attribution only. */
    workId?: string | null;
    api: FleetAiWireApi;
    model: string;
    /** The encoded request body (the relay encodes it before it crosses any boundary). */
    body: string;
    bodyEncoding: FleetAiCompletionBodyEncoding;
    timeoutSec?: number;
    /** The caller's id for THIS request: a retried submit with the same id returns the same job. */
    requestId: string;
}

export type FleetAiCompletionFailureOutcome = {
    ok: false;
    code: FleetAiCompletionFailure;
    message: string;
};

/**
 * Both arms name every field (the other arm's as `undefined`): this package
 * compiles without `strictNullChecks`, which does not narrow on `ok`.
 */
export type FleetAiCompletionSubmitOutcome =
    | { ok: true; jobId: string; code?: undefined; message?: undefined }
    | (FleetAiCompletionFailureOutcome & { jobId?: undefined });

export type FleetAiCompletionWaitOutcome =
    | { state: 'pending'; status: FleetJobStatus }
    | { state: 'done'; result: FleetAiCompletionResult }
    | ({ state: 'failed' } & FleetAiCompletionFailureOutcome);

/** One model the owner's serving nodes advertise. */
export interface FleetAiCompletionModel {
    id: string;
    nodes: number;
}

@Injectable()
export class FleetAiCompletionService {
    private readonly logger = new Logger(FleetAiCompletionService.name);

    constructor(
        private readonly jobs: FleetJobService,
        private readonly jobRows: FleetJobRepository,
        private readonly nodes: FleetNodeRepository,
        @Optional() private readonly killSwitch?: FleetKillSwitchService,
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    /**
     * The models the owner's online, serving nodes advertise (`local-model:`
     * tags beside `local-ai-completions`), most widely served first. A read of
     * the registry rows only: no sweep, no write.
     */
    async listModels(userId: string): Promise<FleetAiCompletionModel[]> {
        if (typeof userId !== 'string' || !userId) return [];
        const counts = new Map<string, number>();
        for (const node of await this.servingNodes(userId)) {
            const seen = new Set<string>();
            for (const tag of node.capabilities ?? []) {
                const model = fleetLocalModelFromCapability(tag);
                if (model && !seen.has(model)) {
                    seen.add(model);
                    counts.set(model, (counts.get(model) ?? 0) + 1);
                }
            }
        }
        return [...counts.entries()]
            .map(([id, nodes]) => ({ id, nodes }))
            .sort((a, b) => b.nodes - a.nodes || a.id.localeCompare(b.id));
    }

    /** Validate, check that something can serve it, and enqueue ONE completion. */
    async submit(input: FleetAiCompletionSubmitInput): Promise<FleetAiCompletionSubmitOutcome> {
        const userId = typeof input?.userId === 'string' ? input.userId : '';
        if (!userId)
            return failure('invalid-request', 'A local AI completion needs the user it is for');
        const parsed = normalizeFleetAiCompletionPayload({
            api: input.api,
            model: input.model,
            body: input.body,
            bodyEncoding: input.bodyEncoding,
            timeoutSec: input.timeoutSec,
        });
        if (!parsed.ok) {
            return failure(
                /larger than/.test(parsed.reason) ? 'too-large' : 'invalid-request',
                `The local AI request was refused: ${parsed.reason}`,
            );
        }
        const payload = parsed.value;
        let decoded: unknown;
        try {
            decoded = decodeFleetAiCompletionBody(
                payload.body,
                payload.bodyEncoding,
                FLEET_AI_COMPLETION_MAX_REQUEST_BYTES,
            );
        } catch (error) {
            const reason = error instanceof FleetAiCompletionCodecError ? error.reason : 'invalid';
            return failure(
                reason === 'too-large' ? 'too-large' : 'invalid-request',
                `The local AI request was refused: ${(error as Error).message}`,
            );
        }
        const body = validateFleetAiCompletionRequestBody(payload.api, decoded);
        if (!body.ok) {
            return failure('invalid-request', `The local AI request was refused: ${body.reason}`);
        }
        const required = fleetAiCompletionRequiredCapabilities(payload.model);
        if (!required) {
            return failure(
                'invalid-request',
                `Model "${payload.model.slice(0, 64)}" cannot be routed to a computer: its name does not fit a capability tag. ` +
                    'Serve it under a shorter id (an alias in llama-swap / Ollama).',
            );
        }
        if (await this.isStopped()) {
            return failure(
                'stopped',
                'The fleet is stopped (the global stop flag is set), so no computer takes work.',
            );
        }
        const eligible = (await this.servingNodes(userId)).filter((node) =>
            nodeSatisfiesCapabilities(node.capabilities, required),
        );
        if (eligible.length === 0) {
            return failure(
                'no-node',
                `No local AI node of yours is online for model "${payload.model}". Start ever-works-node with --work on a ` +
                    'computer whose local AI provider serves that model (`ever-works-node local-ai probe` shows what it serves).',
            );
        }
        const requestId =
            typeof input.requestId === 'string' && /^[A-Za-z0-9._:-]{8,100}$/.test(input.requestId)
                ? input.requestId
                : null;
        if (!requestId)
            return failure('invalid-request', 'A local AI completion needs a request id');
        const view = await this.jobs.enqueue({
            userId,
            organizationId: input.organizationId ?? null,
            kind: FLEET_AI_COMPLETION_JOB_KIND,
            payload: {
                api: payload.api,
                model: payload.model,
                body: payload.body,
                bodyEncoding: payload.bodyEncoding,
                timeoutSec: payload.timeoutSec,
            },
            requiredCapabilities: required,
            idempotencyKey: `ai-completion:${userId}:${requestId}`,
        });
        this.logger.debug(
            `ai-completion ${view.id} queued for ${payload.model} (${payload.api}) — ${eligible.length} eligible node(s)`,
        );
        return { ok: true, jobId: view.id };
    }

    /**
     * Wait (at most `waitMs`, capped at {@link FLEET_AI_COMPLETION_MAX_WAIT_SLICE_MS})
     * for one completion. `pending` says only that the slice ran out; the
     * caller decides how long to keep asking. Reads the row (an answer reported
     * to another API replica is seen too) and wakes early on this replica's
     * completion event.
     */
    async awaitResult(input: {
        userId: string;
        jobId: string;
        waitMs?: number;
    }): Promise<FleetAiCompletionWaitOutcome> {
        const waitMs = Math.max(
            0,
            Math.min(
                typeof input?.waitMs === 'number' && Number.isFinite(input.waitMs)
                    ? input.waitMs
                    : 0,
                FLEET_AI_COMPLETION_MAX_WAIT_SLICE_MS,
            ),
        );
        let job = await this.ownedJob(input?.userId, input?.jobId);
        if (!job) return { state: 'failed', ...failure('failed', 'Unknown local AI completion') };
        const deadline = Date.now() + waitMs;
        while (!isTerminal(job.status) && Date.now() < deadline) {
            await this.nextChange(
                job.id,
                Math.min(FLEET_AI_COMPLETION_POLL_INTERVAL_MS, deadline - Date.now()),
            );
            job = (await this.jobRows.findById(job.id)) ?? job;
        }
        if (!isTerminal(job.status)) return { state: 'pending', status: job.status };
        return this.settled(job);
    }

    /** Cancel one completion (a queued job is dropped; a running one is aborted by its node). Never throws. */
    async cancel(input: { userId: string; jobId: string }): Promise<{ cancelled: boolean }> {
        const job = await this.ownedJob(input?.userId, input?.jobId);
        if (!job || isTerminal(job.status)) return { cancelled: false };
        try {
            const outcome = await this.jobs.cancel(job.id);
            return { cancelled: outcome.cancelled };
        } catch (error) {
            this.logger.warn(
                `ai-completion ${job.id}: cancel failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { cancelled: false };
        }
    }

    /**
     * Purge the prompt and the answer from a SETTLED completion the caller has
     * read. A job still running is left alone (the retention purge reaches it
     * later). Never throws.
     */
    async release(input: { userId: string; jobId: string }): Promise<{ released: boolean }> {
        const job = await this.ownedJob(input?.userId, input?.jobId);
        if (!job || !isTerminal(job.status)) return { released: false };
        try {
            return { released: await this.jobRows.purgeTerminalBodiesById(job.id, new Date()) };
        } catch (error) {
            this.logger.warn(
                `ai-completion ${job.id}: purge failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { released: false };
        }
    }

    // ── internals ───────────────────────────────────────────────────

    /** The owner's nodes that can lease work AND serve completions right now. */
    private async servingNodes(userId: string): Promise<FleetNode[]> {
        const cutoff = Date.now() - config.fleet.getNodeOfflineAfterMs();
        const rows = await this.nodes.findByUser(userId);
        return rows.filter((node) => {
            if (node.kind === 'k8s') return false;
            if (
                node.status !== 'online' ||
                FLEET_NODE_NON_LEASABLE_STATUSES.includes(node.status)
            ) {
                return false;
            }
            const beat = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : 0;
            if (!Number.isFinite(beat) || beat < cutoff) return false;
            if (node.workerState === 'quarantined') return false;
            return (node.capabilities ?? []).includes(FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY);
        });
    }

    private async ownedJob(userId: unknown, jobId: unknown): Promise<FleetJob | null> {
        if (typeof userId !== 'string' || !userId || typeof jobId !== 'string' || !isUUID(jobId)) {
            return null;
        }
        const job = await this.jobRows.findById(jobId);
        if (!job || job.userId !== userId || job.kind !== FLEET_AI_COMPLETION_JOB_KIND) return null;
        return job;
    }

    private async settled(job: FleetJob): Promise<FleetAiCompletionWaitOutcome> {
        if (job.bodiesPurgedAt) {
            // Released (or past retention): the answer is gone, by design.
            return {
                state: 'failed',
                ...failure('failed', 'The local AI completion was already released'),
            };
        }
        if (job.status === 'done') {
            const result = normalizeFleetAiCompletionResult(job.result);
            if (!result.ok) {
                this.logger.warn(
                    `ai-completion ${job.id}: the node's result was refused — ${result.reason}`,
                );
                return {
                    state: 'failed',
                    ...failure(
                        'failed',
                        `The local AI node answered with a result the platform refuses: ${result.reason}`,
                    ),
                };
            }
            if (job.costCents == null) {
                // Free by construction: say so on the row (0, not "unknown").
                await this.jobRows.stampCostCents(job.id, 0).catch(() => undefined);
            }
            return { state: 'done', result: result.value };
        }
        const error = typeof job.error === 'string' ? job.error : '';
        if (error === FLEET_JOB_CANCELLED_ERROR || job.cancelRequestedAt) {
            return {
                state: 'failed',
                ...failure('cancelled', 'The local AI completion was cancelled'),
            };
        }
        if (error.startsWith(FLEET_JOB_QUEUE_EXPIRED_REASON)) {
            return {
                state: 'failed',
                ...failure('no-node', 'No local AI node took the completion before it expired'),
            };
        }
        return {
            state: 'failed',
            ...failure(
                /larger than|carries back/.test(error) ? 'too-large' : 'failed',
                `The local AI node could not answer: ${error.slice(0, 300) || 'no reason given'}`,
            ),
        };
    }

    /** Resolve on this replica's completion event for `jobId`, or after `ms`. */
    private nextChange(jobId: string, ms: number): Promise<void> {
        return new Promise((resolve) => {
            let done = false;
            const finish = (): void => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                this.events?.off(FleetJobCompletedEvent.EVENT_NAME, onCompleted);
                resolve();
            };
            const onCompleted = (event: FleetJobCompletedEvent): void => {
                if (event?.job?.id === jobId) finish();
            };
            const timer = setTimeout(finish, Math.max(1, ms));
            (timer as { unref?: () => void }).unref?.();
            this.events?.on(FleetJobCompletedEvent.EVENT_NAME, onCompleted);
        });
    }

    private async isStopped(): Promise<boolean> {
        if (!this.killSwitch) return false;
        try {
            return await this.killSwitch.isStopped();
        } catch {
            // The lease reads a switch it cannot consult as SET; so does this.
            return true;
        }
    }
}

function isTerminal(status: FleetJobStatus): boolean {
    return status === 'done' || status === 'failed';
}

function failure(code: FleetAiCompletionFailure, message: string): FleetAiCompletionFailureOutcome {
    return { ok: false, code, message };
}
