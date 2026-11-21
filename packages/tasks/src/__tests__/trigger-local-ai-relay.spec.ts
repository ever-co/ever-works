import { describe, expect, it, vi } from 'vitest';
import superjson from 'superjson';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { PluginContextFactoryService } from '@ever-works/agent/plugins';
import type { LocalAiRelayServiceRef } from '@ever-works/plugin';
import { bindTriggerLocalAiRelay } from '../trigger/worker/services/trigger-local-ai-relay';
import type { TriggerInternalApiClient } from '../trigger/worker/services/trigger-internal-api.client';

/**
 * Local AI completions in the worker: the relay is bound into the plugin
 * contexts, and every call it makes goes to the API's
 * `FleetAiCompletionService` over the internal RPC — the body already
 * compressed, the five calls by name — never anywhere else.
 */

const JOB = '9b2f5a6e-1c0d-4f3a-9e7b-2d1c0a9f8e7d';
const ANSWER = { id: 'r1', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }] };

function harness() {
    const calls: Array<{ name: string; method: string; args: unknown[] }> = [];
    const callRemote = vi.fn(async (name: string, method: string, serialized: unknown) => {
        const args = superjson.deserialize(serialized as never) as unknown[];
        calls.push({ name, method, args });
        if (method === 'submit') return { ok: true, jobId: JOB };
        if (method === 'awaitResult') {
            return {
                state: 'done',
                result: {
                    status: 200,
                    body: gzipSync(Buffer.from(JSON.stringify(ANSWER))).toString('base64'),
                    bodyEncoding: 'gzip-base64',
                    providerId: 'gpu',
                    providerKind: 'llama-swap',
                    model: 'flashnext',
                    latencyMs: 10,
                    usage: null,
                    costUsd: 0,
                    costBasis: 'local',
                },
            };
        }
        if (method === 'listModels') return [{ id: 'flashnext', nodes: 1 }];
        return { released: true };
    });
    let bound: LocalAiRelayServiceRef | undefined;
    const contexts = {
        injectServices: vi.fn((services: { localAi?: LocalAiRelayServiceRef }) => {
            bound = services.localAi;
        }),
    };
    const relay = bindTriggerLocalAiRelay(
        contexts as unknown as PluginContextFactoryService,
        { callRemote } as unknown as TriggerInternalApiClient,
    );
    return { relay, bound: () => bound, calls, contexts };
}

describe('bindTriggerLocalAiRelay', () => {
    it('hands every plugin context the relay', () => {
        const h = harness();
        expect(h.contexts.injectServices).toHaveBeenCalledTimes(1);
        expect(h.bound()).toBe(h.relay);
    });

    it("relays a completion through the API's FleetAiCompletionService, body compressed", async () => {
        const h = harness();
        const outcome = await h.relay.complete({
            userId: 'user-1',
            api: 'openai-chat',
            model: 'flashnext',
            body: { messages: [{ role: 'user', content: 'hello' }] },
        });

        expect(outcome).toMatchObject({ ok: true, status: 200, body: ANSWER });
        expect(new Set(h.calls.map((call) => call.name))).toEqual(
            new Set(['FleetAiCompletionService']),
        );
        expect(h.calls.map((call) => call.method)).toEqual(
            expect.arrayContaining(['submit', 'awaitResult']),
        );
        const submit = h.calls.find((call) => call.method === 'submit')!.args[0] as {
            body: string;
        };
        expect(JSON.parse(gunzipSync(Buffer.from(submit.body, 'base64')).toString())).toEqual({
            messages: [{ role: 'user', content: 'hello' }],
        });
    });

    it('lists the caller’s served models through the same service', async () => {
        const h = harness();
        await expect(h.relay.listModels({ userId: 'user-1' })).resolves.toEqual([
            { id: 'flashnext', nodes: 1 },
        ]);
        expect(h.calls).toEqual([
            { name: 'FleetAiCompletionService', method: 'listModels', args: ['user-1'] },
        ]);
    });
});
