import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DemoFeatureDisabledError } from '@ever-works/agent/demo';

/**
 * `kb-transcribe` — what the task does when transcription is refused.
 *
 * On a demo instance (`DEMO=true`) `AiFacadeService.transcribe` throws
 * `DemoFeatureDisabledError('transcription')` (the service has already marked
 * the upload skipped): the run is skipped and acked, not failed and retried.
 * Any other error still propagates so Trigger.dev's retry/backoff applies.
 *
 * The worker / agent modules are mocked; `@ever-works/agent/demo` is the real
 * built module, so the class the task matches is the one the facade throws.
 */

const h = vi.hoisted(() => ({
    recorded: [] as Array<{ run: (payload: unknown) => Promise<unknown> }>,
    transcribeUpload: vi.fn(),
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
    KnowledgeBaseTranscribeService: class KnowledgeBaseTranscribeService {},
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
            KnowledgeBaseTranscribeService: { transcribeUpload: h.transcribeUpload },
        };
        return fn({ get: (token: { name: string }) => byName[token.name] });
    },
}));

import '../kb-transcribe.task';

const PAYLOAD = {
    workId: 'w1',
    uploadId: 'u1',
    sourceStoragePath: 'kb-originals/normalized/x.mp3',
    sourceMimeType: 'audio/mpeg',
};
const run = () => h.recorded[0].run(PAYLOAD);

describe('kb-transcribe task', () => {
    beforeEach(() => {
        h.transcribeUpload.mockReset();
    });

    it('skips and acks when transcription is disabled in the demo', async () => {
        h.transcribeUpload.mockRejectedValue(new DemoFeatureDisabledError('transcription'));

        await expect(run()).resolves.toEqual({
            status: 'skipped',
            reason: 'transcription-disabled',
            workId: 'w1',
            uploadId: 'u1',
        });
    });

    it('still fails on any other error so Trigger.dev retries it', async () => {
        const outage = new Error('provider 502');
        h.transcribeUpload.mockRejectedValue(outage);

        await expect(run()).rejects.toBe(outage);
    });

    it('completes with the transcript document', async () => {
        h.transcribeUpload.mockResolvedValue({
            documentId: 'd1',
            providerId: 'whisper-1',
            durationSeconds: 3,
            tokensUsed: 0,
        });

        await expect(run()).resolves.toMatchObject({ status: 'completed', documentId: 'd1' });
    });
});
