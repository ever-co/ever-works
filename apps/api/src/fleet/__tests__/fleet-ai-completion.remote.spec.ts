import type { FleetAiCompletionService } from '@ever-works/agent/fleet';
import { fleetAiCompletionRemoteFacade } from '../fleet-ai-completion.remote';

/**
 * Local AI completions over the Trigger.dev internal RPC: the worker may call
 * exactly the relay's five methods, and each argument reaches the service
 * rebuilt from the fields it reads — nothing else a caller sends.
 */

function service() {
    return {
        listModels: jest.fn(async () => []),
        submit: jest.fn(async () => ({ ok: true, jobId: 'job' })),
        awaitResult: jest.fn(async () => ({ state: 'pending', status: 'queued' })),
        cancel: jest.fn(async () => ({ cancelled: true })),
        release: jest.fn(async () => ({ released: true })),
        // Never reachable through the facade.
        servingNodes: jest.fn(),
    };
}

describe('fleetAiCompletionRemoteFacade', () => {
    it('exposes exactly the five relay calls', () => {
        const facade = fleetAiCompletionRemoteFacade(
            service() as unknown as FleetAiCompletionService,
        );
        expect(Object.keys(facade).sort()).toEqual([
            'awaitResult',
            'cancel',
            'listModels',
            'release',
            'submit',
        ]);
    });

    it('rebuilds every argument from the fields the service reads', async () => {
        const svc = service();
        const facade = fleetAiCompletionRemoteFacade(svc as unknown as FleetAiCompletionService);

        await facade.submit({
            userId: 'user-1',
            api: 'openai-chat',
            model: 'flashnext',
            body: 'H4sI',
            bodyEncoding: 'gzip-base64',
            timeoutSec: 300,
            requestId: 'req-0123456789',
            workId: 'work-1',
            organizationId: 'someone-elses-org',
            __proto__: { polluted: true },
        });
        await facade.awaitResult({ userId: 'user-1', jobId: 'job', waitMs: 15_000, extra: 1 });
        await facade.awaitResult({ userId: 'user-1', jobId: 'job', waitMs: 'forever' });
        await facade.cancel({ userId: 'user-1', jobId: 'job', force: true });
        await facade.release(null);
        await facade.listModels(42);

        expect(svc.submit).toHaveBeenCalledWith({
            userId: 'user-1',
            api: 'openai-chat',
            model: 'flashnext',
            body: 'H4sI',
            bodyEncoding: 'gzip-base64',
            timeoutSec: 300,
            requestId: 'req-0123456789',
            workId: 'work-1',
        });
        expect(svc.awaitResult).toHaveBeenNthCalledWith(1, {
            userId: 'user-1',
            jobId: 'job',
            waitMs: 15_000,
        });
        expect(svc.awaitResult).toHaveBeenNthCalledWith(2, {
            userId: 'user-1',
            jobId: 'job',
            waitMs: 0,
        });
        expect(svc.cancel).toHaveBeenCalledWith({ userId: 'user-1', jobId: 'job' });
        expect(svc.release).toHaveBeenCalledWith({ userId: '', jobId: '' });
        expect(svc.listModels).toHaveBeenCalledWith('');
    });
});
