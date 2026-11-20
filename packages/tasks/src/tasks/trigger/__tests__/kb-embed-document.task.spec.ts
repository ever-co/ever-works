import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DemoFeatureDisabledError } from '@ever-works/agent/demo';

/**
 * `kb-embed-document` — what the task does when the embedder refuses.
 *
 * On a demo instance (`DEMO=true`) `AiFacadeService.embed` throws
 * `DemoFeatureDisabledError('embeddings')`: the document simply has no
 * semantic signal (KB search runs lexical-only), so the run is skipped and
 * acked, not failed and retried. Any other embedder error still propagates so
 * Trigger.dev's retry/backoff applies.
 *
 * The worker / agent modules are mocked (they pull the whole worker graph in);
 * `@ever-works/agent/demo` is the real built module, so the error class the
 * task matches is the one the facade throws.
 */

const h = vi.hoisted(() => ({
    recorded: [] as Array<{ run: (payload: unknown) => Promise<unknown> }>,
    embed: vi.fn(),
    replaceForDocument: vi.fn(),
    getDocumentBodyForEmbedding: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

vi.mock('@trigger.dev/sdk', () => ({
    task: (params: { run: (payload: unknown) => Promise<unknown> }) => {
        h.recorded.push(params);
        return params;
    },
    logger: h.logger,
}));
vi.mock('@ever-works/agent/tasks', () => ({}));
vi.mock('@ever-works/agent/services', () => ({
    KnowledgeBaseService: class KnowledgeBaseService {},
    chunkMarkdown: (body: string) =>
        body.trim() ? [{ index: 0, content: body, charStart: 0, charEnd: body.length }] : [],
}));
vi.mock('@ever-works/agent/database', () => ({
    WorkKnowledgeChunkRepository: class WorkKnowledgeChunkRepository {},
}));
vi.mock('@ever-works/agent/facades', () => ({
    AiFacadeService: class AiFacadeService {},
}));
vi.mock('../../../trigger/worker/services/trigger-plugin-hydrator.service', () => ({
    TriggerPluginHydratorService: class TriggerPluginHydratorService {},
}));
vi.mock('../../../trigger/worker/services/tenant-runtime-binding-resolver.service', () => ({
    TenantRuntimeBindingResolverService: class TenantRuntimeBindingResolverService {},
}));
vi.mock('../../../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (_name: string, fn: (ctx: unknown) => Promise<unknown>) => {
        const byName: Record<string, unknown> = {
            TriggerPluginHydratorService: { initialize: vi.fn().mockResolvedValue(undefined) },
            TenantRuntimeBindingResolverService: {
                resolveForWork: vi.fn().mockResolvedValue({ status: 'no-binding' }),
            },
            KnowledgeBaseService: { getDocumentBodyForEmbedding: h.getDocumentBodyForEmbedding },
            AiFacadeService: { embed: h.embed },
            WorkKnowledgeChunkRepository: { replaceForDocument: h.replaceForDocument },
        };
        return fn({ get: (token: { name: string }) => byName[token.name] });
    },
}));

import '../kb-embed-document.task';

const PAYLOAD = { workId: 'w1', documentId: 'd1' };
const run = () => h.recorded[0].run(PAYLOAD);

describe('kb-embed-document task', () => {
    beforeEach(() => {
        h.embed.mockReset();
        h.replaceForDocument.mockReset().mockResolvedValue(undefined);
        h.getDocumentBodyForEmbedding
            .mockReset()
            .mockResolvedValue({ body: '# Notes\n\nSome text', createdById: 'u1' });
    });

    it('skips and acks when embeddings are disabled in the demo, leaving chunks untouched', async () => {
        h.embed.mockRejectedValue(new DemoFeatureDisabledError('embeddings'));

        await expect(run()).resolves.toEqual({
            status: 'skipped',
            reason: 'embeddings-disabled',
            workId: 'w1',
            documentId: 'd1',
        });
        expect(h.replaceForDocument).not.toHaveBeenCalled();
    });

    it('still fails on any other embedder error so Trigger.dev retries it', async () => {
        const outage = new Error('Embedding call failed: 503');
        h.embed.mockRejectedValue(outage);

        await expect(run()).rejects.toBe(outage);
        expect(h.replaceForDocument).not.toHaveBeenCalled();
    });

    it('persists the chunks when the embedder answers', async () => {
        h.embed.mockResolvedValue({ model: 'e-model', embeddings: [[0.1, 0.2]] });

        await expect(run()).resolves.toMatchObject({ status: 'completed', chunkCount: 1 });
        expect(h.replaceForDocument).toHaveBeenCalledWith(
            'w1',
            'd1',
            expect.arrayContaining([expect.objectContaining({ embedding: [0.1, 0.2] })]),
        );
    });
});
