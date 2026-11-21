import { gunzipSync, gzipSync } from 'node:zlib';
import type { LocalAiRelayRequest } from '@ever-works/plugin';
import type {
    FleetAiCompletionSubmitInput,
    FleetAiCompletionWaitOutcome,
} from '../fleet-ai-completion.service';
import { createFleetLocalAiRelay, type FleetAiCompletionTransport } from '../fleet-local-ai-relay';

/**
 * Local AI completions — the relay a plugin calls: it encodes the body before
 * any boundary, submits once (a retried submit reuses its request id), waits
 * in slices, and on every end tidies up — cancel on a deadline or a cancel,
 * release always. Outcomes are values; nothing here throws.
 */

const JOB = '9b2f5a6e-1c0d-4f3a-9e7b-2d1c0a9f8e7d';
const ANSWER = { id: 'r1', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }] };

function encoded(value: unknown): string {
    return gzipSync(Buffer.from(JSON.stringify(value))).toString('base64');
}

const DONE: FleetAiCompletionWaitOutcome = {
    state: 'done',
    result: {
        status: 200,
        body: encoded(ANSWER),
        bodyEncoding: 'gzip-base64',
        providerId: 'gpu',
        providerKind: 'llama-swap',
        model: 'flashnext',
        latencyMs: 900,
        usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        costUsd: 0,
        costBasis: 'local',
    },
};

function transport(waits: Array<FleetAiCompletionWaitOutcome | Error | 'hang'>) {
    const submitted: FleetAiCompletionSubmitInput[] = [];
    let index = 0;
    const t = {
        submitted,
        listModels: jest.fn(async () => [{ id: 'flashnext', nodes: 2 }]),
        submit: jest.fn(async (input: FleetAiCompletionSubmitInput) => {
            submitted.push(input);
            return { ok: true as const, jobId: JOB };
        }),
        awaitResult: jest.fn(async () => {
            const next = waits[Math.min(index++, waits.length - 1)];
            if (next === 'hang') return new Promise<FleetAiCompletionWaitOutcome>(() => undefined);
            if (next instanceof Error) throw next;
            return next;
        }),
        cancel: jest.fn(async () => ({ cancelled: true })),
        release: jest.fn(async () => ({ released: true })),
    };
    return t;
}

function request(overrides: Partial<LocalAiRelayRequest> = {}): LocalAiRelayRequest {
    return {
        userId: 'user-1',
        api: 'openai-chat',
        model: 'flashnext',
        body: { messages: [{ role: 'user', content: 'hello' }] },
        ...overrides,
    };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createFleetLocalAiRelay — complete', () => {
    it('encodes the body, waits for the answer, decodes it and releases the job', async () => {
        const t = transport([{ state: 'pending', status: 'running' }, DONE]);
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport, {
            sleep: async () => undefined,
        });

        const outcome = await relay.complete(request({ timeoutMs: 120_000, workId: 'work-1' }));

        expect(outcome).toEqual({
            ok: true,
            status: 200,
            body: ANSWER,
            model: 'flashnext',
            providerKind: 'llama-swap',
            latencyMs: 900,
            usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        });
        const [sent] = t.submitted;
        expect(sent).toMatchObject({
            userId: 'user-1',
            workId: 'work-1',
            api: 'openai-chat',
            model: 'flashnext',
            bodyEncoding: 'gzip-base64',
            timeoutSec: 120,
        });
        expect(JSON.parse(gunzipSync(Buffer.from(sent.body, 'base64')).toString())).toEqual(
            request().body,
        );
        await flush();
        expect(t.release).toHaveBeenCalledWith({ userId: 'user-1', jobId: JOB });
        expect(t.cancel).not.toHaveBeenCalled();
    });

    it('retries a submit that threw with the SAME request id (never a second job)', async () => {
        const t = transport([DONE]);
        t.submit
            .mockRejectedValueOnce(new Error('Trigger internal API 502'))
            .mockImplementation(async (input: FleetAiCompletionSubmitInput) => {
                t.submitted.push(input);
                return { ok: true as const, jobId: JOB };
            });
        const ids: string[] = [];
        t.submit.mock.calls; // (typed access below)
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport, {
            sleep: async () => undefined,
            newRequestId: () => 'req-fixed-0001',
        });

        await expect(relay.complete(request())).resolves.toMatchObject({ ok: true });

        for (const call of t.submit.mock.calls)
            ids.push((call[0] as FleetAiCompletionSubmitInput).requestId);
        expect(ids).toEqual(['req-fixed-0001', 'req-fixed-0001']);
    });

    it('hands back the platform’s refusal as it is (no-node), without waiting', async () => {
        const t = transport([DONE]);
        t.submit.mockResolvedValueOnce({
            ok: false,
            code: 'no-node',
            message: 'No local AI node of yours is online',
        } as never);
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport);

        await expect(relay.complete(request())).resolves.toEqual({
            ok: false,
            code: 'no-node',
            message: 'No local AI node of yours is online',
        });
        expect(t.awaitResult).not.toHaveBeenCalled();
    });

    it('hands back a node failure as it is', async () => {
        const t = transport([
            {
                state: 'failed',
                ok: false,
                code: 'failed',
                message: 'The local AI node could not answer: x',
            },
        ]);
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport);
        await expect(relay.complete(request())).resolves.toMatchObject({
            ok: false,
            code: 'failed',
        });
    });

    it('cancels and says timeout at the deadline', async () => {
        let now = 0;
        const t = transport([{ state: 'pending', status: 'running' }]);
        t.awaitResult.mockImplementation(async () => {
            now += 6_000;
            return { state: 'pending', status: 'running' };
        });
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport, { now: () => now });

        await expect(relay.complete(request({ timeoutMs: 20_000 }))).resolves.toEqual({
            ok: false,
            code: 'timeout',
            message: 'No answer from your local AI within 20 s',
        });
        expect(t.cancel).toHaveBeenCalledWith({ userId: 'user-1', jobId: JOB });
    });

    it('says no-node and cancels when nobody leases the request within the queue window', async () => {
        let now = 0;
        const t = transport([]);
        t.awaitResult.mockImplementation(async () => {
            now += 30_000;
            return { state: 'pending', status: 'queued' };
        });
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport, { now: () => now });

        const outcome = await relay.complete(request());

        expect(outcome).toMatchObject({ ok: false, code: 'no-node' });
        expect(t.cancel).toHaveBeenCalled();
    });

    it('stops at once on the caller’s cancel — it never waits out a slice', async () => {
        const t = transport(['hang']);
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport);
        const controller = new AbortController();
        const pending = relay.complete(request({ signal: controller.signal }));
        setTimeout(() => controller.abort(), 20);

        await expect(pending).resolves.toEqual({
            ok: false,
            code: 'cancelled',
            message: 'The local AI completion was cancelled',
        });
        expect(t.cancel).toHaveBeenCalledWith({ userId: 'user-1', jobId: JOB });
    });

    it('does not submit an already-cancelled request', async () => {
        const t = transport([DONE]);
        const controller = new AbortController();
        controller.abort();
        await expect(
            createFleetLocalAiRelay(t as FleetAiCompletionTransport).complete(
                request({ signal: controller.signal }),
            ),
        ).resolves.toMatchObject({ ok: false, code: 'cancelled' });
        expect(t.submit).not.toHaveBeenCalled();
    });

    it('refuses a request too large for a completion before anything crosses a boundary', async () => {
        const t = transport([DONE]);
        const huge = { messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] };
        await expect(
            createFleetLocalAiRelay(t as FleetAiCompletionTransport).complete(
                request({ body: huge }),
            ),
        ).resolves.toMatchObject({ ok: false, code: 'too-large' });
        expect(t.submit).not.toHaveBeenCalled();
    });

    it('gives up (and cancels) when the platform stays unreachable while waiting', async () => {
        const t = transport([new Error('ECONNRESET')]);
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport, {
            sleep: async () => undefined,
            transportRetries: 2,
        });

        const outcome = await relay.complete(request());

        expect(outcome).toMatchObject({ ok: false, code: 'failed' });
        expect(t.awaitResult).toHaveBeenCalledTimes(3);
        expect(t.cancel).toHaveBeenCalled();
    });

    it('needs the user it is for', async () => {
        const t = transport([DONE]);
        await expect(
            createFleetLocalAiRelay(t as FleetAiCompletionTransport).complete(
                request({ userId: '' }),
            ),
        ).resolves.toMatchObject({ ok: false, code: 'invalid-request' });
    });
});

describe('createFleetLocalAiRelay — listModels', () => {
    it('lists the caller’s served models, and nothing when the platform cannot answer', async () => {
        const t = transport([]);
        const relay = createFleetLocalAiRelay(t as FleetAiCompletionTransport, {
            sleep: async () => undefined,
        });
        await expect(relay.listModels({ userId: 'user-1' })).resolves.toEqual([
            { id: 'flashnext', nodes: 2 },
        ]);

        t.listModels.mockRejectedValue(new Error('down'));
        await expect(relay.listModels({ userId: 'user-1' })).resolves.toEqual([]);
        await expect(relay.listModels({ userId: '' })).resolves.toEqual([]);
    });
});
