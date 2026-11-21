import { EventEmitter2 } from '@nestjs/event-emitter';
import { gzipSync } from 'node:zlib';
import {
    FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES,
    FLEET_JOB_QUEUE_EXPIRED_REASON,
    type FleetJobView,
} from '@ever-works/contracts';
import { FleetJobCompletedEvent } from '../../../events/fleet-job.events';
import { FLEET_JOB_CANCELLED_ERROR } from '../../fleet-job.service';
import { FleetAiCompletionService } from '../fleet-ai-completion.service';

/**
 * Local AI completions — the platform service: what it refuses before
 * queueing (and why), what it enqueues (and for whom), how a caller waits for
 * the answer (bounded slices, woken by the completion), and that a settled
 * completion is free and can be purged.
 */

const USER = 'user-1';
const JOB_ID = '9b2f5a6e-1c0d-4f3a-9e7b-2d1c0a9f8e7d';

function encode(value: unknown): string {
    return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
}

const CHAT = { messages: [{ role: 'user', content: 'hello' }] };

function node(overrides: Record<string, unknown> = {}) {
    return {
        id: 'node-1',
        userId: USER,
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        workerState: 'idle',
        capabilities: [
            'os:linux',
            'local-ai',
            'local-ai-completions',
            'local-ai:llama-swap',
            'local-model:flashnext',
        ],
        ...overrides,
    };
}

function harness(
    options: {
        nodes?: Array<Record<string, unknown>>;
        stopped?: boolean | Error;
        job?: Record<string, unknown> | null;
    } = {},
) {
    let job: Record<string, unknown> | null =
        options.job === undefined
            ? {
                  id: JOB_ID,
                  userId: USER,
                  kind: 'ai-completion',
                  status: 'queued',
                  result: null,
                  error: null,
                  costCents: null,
                  cancelRequestedAt: null,
                  bodiesPurgedAt: null,
              }
            : options.job;
    const jobs = {
        enqueue: jest.fn(
            async (input: Record<string, unknown>) =>
                ({ id: JOB_ID, ...input }) as unknown as FleetJobView,
        ),
        cancel: jest.fn(async () => ({ cancelled: true, state: 'queued-dropped' })),
    };
    const jobRows = {
        findById: jest.fn(async () => (job ? { ...job } : null)),
        stampCostCents: jest.fn(async () => undefined),
        purgeTerminalBodiesById: jest.fn(async () => true),
    };
    const nodes = { findByUser: jest.fn(async () => options.nodes ?? [node()]) };
    const killSwitch = {
        isStopped: jest.fn(async () => {
            if (options.stopped instanceof Error) throw options.stopped;
            return options.stopped === true;
        }),
    };
    const events = new EventEmitter2();
    const service = new FleetAiCompletionService(
        jobs as never,
        jobRows as never,
        nodes as never,
        killSwitch as never,
        events,
    );
    const setJob = (patch: Record<string, unknown>) => {
        job = { ...(job ?? {}), ...patch };
    };
    return { service, jobs, jobRows, nodes, killSwitch, events, setJob };
}

function submitInput(overrides: Record<string, unknown> = {}) {
    return {
        userId: USER,
        api: 'openai-chat' as const,
        model: 'flashnext',
        body: encode(CHAT),
        bodyEncoding: 'gzip-base64' as const,
        timeoutSec: 300,
        requestId: 'req-0123456789',
        ...overrides,
    };
}

describe('FleetAiCompletionService.listModels', () => {
    it('counts the models the owner’s online serving nodes advertise, most widely served first', async () => {
        const { service } = harness({
            nodes: [
                node({
                    id: 'a',
                    capabilities: ['local-ai', 'local-ai-completions', 'local-model:flashnext'],
                }),
                node({
                    id: 'b',
                    capabilities: [
                        'local-ai',
                        'local-ai-completions',
                        'local-model:flashnext',
                        'local-model:qwen3-8b',
                    ],
                }),
                // Not serving: no completions tag (an older node, or completions off).
                node({ id: 'c', capabilities: ['local-ai', 'local-model:other'] }),
                // Not reachable: offline, stale, paused, quarantined, a cluster node.
                node({
                    id: 'd',
                    status: 'offline',
                    capabilities: ['local-ai-completions', 'local-model:x1'],
                }),
                node({
                    id: 'e',
                    lastHeartbeatAt: new Date(Date.now() - 24 * 3600_000),
                    capabilities: ['local-ai-completions', 'local-model:x2'],
                }),
                node({
                    id: 'f',
                    status: 'paused',
                    capabilities: ['local-ai-completions', 'local-model:x3'],
                }),
                node({
                    id: 'g',
                    workerState: 'quarantined',
                    capabilities: ['local-ai-completions', 'local-model:x4'],
                }),
                node({
                    id: 'h',
                    kind: 'k8s',
                    capabilities: ['local-ai-completions', 'local-model:x5'],
                }),
            ],
        });

        await expect(service.listModels(USER)).resolves.toEqual([
            { id: 'flashnext', nodes: 2 },
            { id: 'qwen3-8b', nodes: 1 },
        ]);
    });

    it('answers nothing for no user', async () => {
        await expect(harness().service.listModels('')).resolves.toEqual([]);
    });
});

describe('FleetAiCompletionService.submit', () => {
    it('enqueues one completion for the owner, routed by the model tag, idempotent per request id', async () => {
        const { service, jobs } = harness();

        await expect(service.submit(submitInput())).resolves.toEqual({ ok: true, jobId: JOB_ID });

        expect(jobs.enqueue).toHaveBeenCalledWith({
            userId: USER,
            organizationId: null,
            kind: 'ai-completion',
            payload: {
                api: 'openai-chat',
                model: 'flashnext',
                body: submitInput().body,
                bodyEncoding: 'gzip-base64',
                timeoutSec: 300,
            },
            requiredCapabilities: ['local-ai', 'local-ai-completions', 'local-model:flashnext'],
            idempotencyKey: `ai-completion:${USER}:req-0123456789`,
        });
    });

    it('refuses with no-node, naming what to start, when no online node serves the model', async () => {
        const { service, jobs } = harness({
            nodes: [node({ capabilities: ['local-ai', 'local-ai-completions'] })],
        });

        const outcome = await service.submit(submitInput());

        expect(outcome).toMatchObject({ ok: false, code: 'no-node' });
        expect(outcome.message).toContain(
            'No local AI node of yours is online for model "flashnext"',
        );
        expect(outcome.message).toContain('--work');
        expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('refuses with stopped while the global stop flag is set — or cannot be read', async () => {
        for (const stopped of [true, new Error('db down')]) {
            const { service, jobs } = harness({ stopped });
            await expect(service.submit(submitInput())).resolves.toMatchObject({
                ok: false,
                code: 'stopped',
            });
            expect(jobs.enqueue).not.toHaveBeenCalled();
        }
    });

    it.each([
        [
            'a body with no messages',
            { body: encode({ model: 'flashnext' }) },
            'invalid-request',
            /messages/,
        ],
        [
            'a body that is not gzip',
            { body: Buffer.from('plain').toString('base64') },
            'invalid-request',
            /gzip/,
        ],
        ['an unknown wire API', { api: 'openai' }, 'invalid-request', /api must be/],
        [
            'a model that cannot be a tag',
            { model: 'm'.repeat(40) },
            'invalid-request',
            /cannot be routed/,
        ],
        [
            'a body over the encoded cap',
            { body: 'A'.repeat(FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES + 4) },
            'too-large',
            /larger than/,
        ],
        [
            'a body over the decoded cap',
            { body: gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20)).toString('base64') },
            'too-large',
            /larger than/,
        ],
        ['no request id', { requestId: '' }, 'invalid-request', /request id/],
        ['no user', { userId: '' }, 'invalid-request', /user/],
    ])('refuses %s before queueing anything', async (_label, overrides, code, message) => {
        const { service, jobs } = harness();
        const outcome = await service.submit(submitInput(overrides as Record<string, unknown>));
        expect(outcome).toMatchObject({ ok: false, code });
        expect(outcome.message).toMatch(message as RegExp);
        expect(jobs.enqueue).not.toHaveBeenCalled();
    });
});

describe('FleetAiCompletionService.awaitResult', () => {
    const result = {
        status: 200,
        body: encode({ choices: [] }),
        bodyEncoding: 'gzip-base64',
        providerId: 'gpu',
        providerKind: 'llama-swap',
        model: 'flashnext',
        latencyMs: 1200,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        costUsd: 0,
        costBasis: 'local',
    };

    it('returns the answer of a done job and stamps its cost 0 — free, not unknown', async () => {
        const { service, setJob, jobRows } = harness();
        setJob({ status: 'done', result });

        await expect(
            service.awaitResult({ userId: USER, jobId: JOB_ID, waitMs: 0 }),
        ).resolves.toEqual({
            state: 'done',
            result,
        });
        expect(jobRows.stampCostCents).toHaveBeenCalledWith(JOB_ID, 0);
    });

    it('answers pending once its slice runs out', async () => {
        const { service } = harness();
        const started = Date.now();
        await expect(
            service.awaitResult({ userId: USER, jobId: JOB_ID, waitMs: 50 }),
        ).resolves.toEqual({
            state: 'pending',
            status: 'queued',
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    });

    it('wakes as soon as the completion event for its job fires', async () => {
        const { service, setJob, events } = harness();
        setTimeout(() => {
            setJob({ status: 'done', result });
            events.emit(
                FleetJobCompletedEvent.EVENT_NAME,
                new FleetJobCompletedEvent({ id: JOB_ID } as FleetJobView, USER, 'node-report'),
            );
        }, 30);
        const started = Date.now();
        const outcome = await service.awaitResult({ userId: USER, jobId: JOB_ID, waitMs: 15_000 });
        expect(outcome.state).toBe('done');
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it.each([
        [
            'an operator or caller cancel',
            { status: 'failed', error: FLEET_JOB_CANCELLED_ERROR },
            'cancelled',
        ],
        [
            'the queue SLA',
            { status: 'failed', error: `${FLEET_JOB_QUEUE_EXPIRED_REASON}: nobody took it` },
            'no-node',
        ],
        [
            'a node failure',
            { status: 'failed', error: 'the local AI provider "gpu" did not answer within 60 s' },
            'failed',
        ],
        [
            'an oversized answer',
            {
                status: 'failed',
                error: 'the answer is 300 KiB encoded — more than the 200 KiB a completion carries back',
            },
            'too-large',
        ],
        ['a result the platform refuses', { status: 'done', result: { status: 'x' } }, 'failed'],
        ['a released job', { status: 'done', result, bodiesPurgedAt: new Date() }, 'failed'],
    ])('maps %s to %s', async (_label, patch, code) => {
        const { service, setJob } = harness();
        setJob(patch);
        await expect(service.awaitResult({ userId: USER, jobId: JOB_ID })).resolves.toMatchObject({
            state: 'failed',
            ok: false,
            code,
        });
    });

    it('knows no completion of another owner, another kind, or a malformed id', async () => {
        for (const job of [
            { id: JOB_ID, userId: 'someone-else', kind: 'ai-completion', status: 'done' },
            { id: JOB_ID, userId: USER, kind: 'agent-task', status: 'done' },
        ]) {
            const { service } = harness({ job });
            await expect(
                service.awaitResult({ userId: USER, jobId: JOB_ID }),
            ).resolves.toMatchObject({
                state: 'failed',
                message: 'Unknown local AI completion',
            });
        }
        await expect(
            harness().service.awaitResult({ userId: USER, jobId: 'not-a-uuid' }),
        ).resolves.toMatchObject({
            state: 'failed',
        });
    });
});

describe('FleetAiCompletionService.cancel / release', () => {
    it('cancels an owned, unsettled completion and nothing else', async () => {
        const { service, jobs, setJob } = harness();
        await expect(service.cancel({ userId: USER, jobId: JOB_ID })).resolves.toEqual({
            cancelled: true,
        });
        expect(jobs.cancel).toHaveBeenCalledWith(JOB_ID);

        setJob({ status: 'done' });
        jobs.cancel.mockClear();
        await expect(service.cancel({ userId: USER, jobId: JOB_ID })).resolves.toEqual({
            cancelled: false,
        });
        await expect(service.cancel({ userId: 'other', jobId: JOB_ID })).resolves.toEqual({
            cancelled: false,
        });
        expect(jobs.cancel).not.toHaveBeenCalled();
    });

    it('purges the prompt and the answer of a settled completion only', async () => {
        const { service, jobRows, setJob } = harness();
        await expect(service.release({ userId: USER, jobId: JOB_ID })).resolves.toEqual({
            released: false,
        });
        expect(jobRows.purgeTerminalBodiesById).not.toHaveBeenCalled();

        setJob({ status: 'done' });
        await expect(service.release({ userId: USER, jobId: JOB_ID })).resolves.toEqual({
            released: true,
        });
        expect(jobRows.purgeTerminalBodiesById).toHaveBeenCalledWith(JOB_ID, expect.any(Date));
    });
});
