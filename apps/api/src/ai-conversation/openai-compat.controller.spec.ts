jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));
// EW-641 Phase 2/c row 34c — `OpenAiCompatService` now imports the
// agent/services barrel for KB mention injection. Stub it here to
// keep the controller spec free of agent transitive deps.
jest.mock('@ever-works/agent/services', () => ({
    KbMentionResolverService: class {},
    parseKbMentions: jest.fn().mockReturnValue([]),
    formatKbContext: jest.fn().mockReturnValue('<kb>\n</kb>'),
}));

import {
    DemoError,
    DemoModelNotAllowedError,
    DemoModelUnavailableError,
    DemoQuotaExceededError,
    DemoRateLimitedError,
} from '@ever-works/agent/demo';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe('OpenAiCompatController', () => {
    let controller: OpenAiCompatController;
    let service: jest.Mocked<
        Pick<OpenAiCompatService, 'handleCompletion' | 'handleStreamingCompletion'>
    >;
    let res: jest.Mocked<{
        setHeader: (name: string, value: string) => void;
        json: (body: unknown) => void;
        write: (chunk: string) => void;
        end: (payload?: string) => void;
        headersSent: boolean;
        destroyed: boolean;
        writableEnded: boolean;
        status: (code: number) => void;
        destroy: (error?: Error) => void;
    }>;
    const auth: AuthenticatedUser = { userId: 'user-1' } as AuthenticatedUser;

    beforeEach(() => {
        service = {
            handleCompletion: jest.fn(),
            handleStreamingCompletion: jest.fn().mockResolvedValue(undefined),
        } as any;
        res = {
            setHeader: jest.fn(),
            json: jest.fn(),
            write: jest.fn(),
            end: jest.fn(),
            status: jest.fn(),
            destroy: jest.fn(),
            headersSent: false,
            destroyed: false,
            writableEnded: false,
        };
        controller = new OpenAiCompatController(service as unknown as OpenAiCompatService);
    });

    it('streaming branch sets SSE headers and delegates to handleStreamingCompletion', async () => {
        const body = { stream: true, messages: [], model: 'auto' } as any;

        await controller.chatCompletions(auth, 'p-override', 'w-1', body, res);

        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
        expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
        expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
        expect(service.handleStreamingCompletion).toHaveBeenCalledWith(
            body,
            { userId: 'user-1', workId: 'w-1', providerOverride: 'p-override' },
            res,
        );
        expect(service.handleCompletion).not.toHaveBeenCalled();
    });

    it('non-streaming branch returns JSON via res.json', async () => {
        const body = { stream: false, messages: [] } as any;
        const result = { id: 'r-1' } as any;
        service.handleCompletion.mockResolvedValue(result);

        await controller.chatCompletions(auth, undefined, undefined, body, res);

        expect(service.handleCompletion).toHaveBeenCalledWith(body, {
            userId: 'user-1',
            workId: undefined,
            providerOverride: undefined,
        });
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        expect(res.json).toHaveBeenCalledWith(result);
        expect(service.handleStreamingCompletion).not.toHaveBeenCalled();
    });

    it('treats missing stream flag as non-streaming', async () => {
        const body = { messages: [] } as any;
        service.handleCompletion.mockResolvedValue({} as any);

        await controller.chatCompletions(auth, undefined, undefined, body, res);

        expect(service.handleCompletion).toHaveBeenCalled();
        expect(service.handleStreamingCompletion).not.toHaveBeenCalled();
    });

    it('forwards optional headers through facadeOptions', async () => {
        const body = { stream: false, messages: [] } as any;
        service.handleCompletion.mockResolvedValue({} as any);

        await controller.chatCompletions(auth, 'override-x', 'work-99', body, res);

        expect(service.handleCompletion).toHaveBeenCalledWith(body, {
            userId: 'user-1',
            workId: 'work-99',
            providerOverride: 'override-x',
        });
    });

    /**
     * Platform demo mode (R39): the web's assistant chat calls this route, and the AI facade
     * refuses a demo call with a `DemoError` (`DEMO_AI_QUOTA`, `DEMO_AI_BUSY`,
     * `DEMO_MODEL_UNAVAILABLE`, …). Before a byte is written it goes on to the global
     * `DemoErrorFilter`, which answers with the error's own status and `code`. Every other error
     * keeps the 422 envelope, and with `DEMO` unset nothing changes at all.
     */
    describe('errors', () => {
        const savedDemo = process.env.DEMO;
        afterEach(() => {
            if (savedDemo === undefined) delete process.env.DEMO;
            else process.env.DEMO = savedDemo;
        });

        const refusals = (): DemoError[] => [
            new DemoQuotaExceededError('sandbox'),
            new DemoQuotaExceededError('day'),
            new DemoRateLimitedError(4_000),
            new DemoModelNotAllowedError('openai/gpt-4o'),
            new DemoModelUnavailableError('google/gemma-4-31b-it:free'),
        ];

        it.each([false, true])(
            'with DEMO on, hands a demo refusal to DemoErrorFilter (stream: %s)',
            async (stream) => {
                process.env.DEMO = 'true';
                for (const refusal of refusals()) {
                    jest.clearAllMocks();
                    service.handleCompletion.mockRejectedValue(refusal);
                    service.handleStreamingCompletion.mockRejectedValue(refusal);

                    await expect(
                        controller.chatCompletions(
                            auth,
                            undefined,
                            undefined,
                            { stream, messages: [] } as any,
                            res,
                        ),
                    ).rejects.toBe(refusal);

                    // The filter's JSON answer, not the event stream a streaming call set up.
                    expect(res.setHeader).toHaveBeenLastCalledWith(
                        'Content-Type',
                        'application/json',
                    );
                    expect(res.status).not.toHaveBeenCalled();
                    expect(res.json).not.toHaveBeenCalled();
                    expect(res.destroy).not.toHaveBeenCalled();
                }
            },
        );

        it('with DEMO on, keeps the 422 envelope for any other error', async () => {
            process.env.DEMO = 'true';
            service.handleCompletion.mockRejectedValue(new Error('no provider configured'));

            await controller.chatCompletions(
                auth,
                undefined,
                undefined,
                { messages: [] } as any,
                res,
            );

            expect(res.status).toHaveBeenCalledWith(422);
            expect(res.json).toHaveBeenCalledWith({
                error: { message: 'no provider configured', type: 'provider_unavailable' },
            });
        });

        it('with DEMO on, a refusal after the stream started still aborts it, as before', async () => {
            process.env.DEMO = 'true';
            const refusal = new DemoModelUnavailableError('m:free');
            service.handleStreamingCompletion.mockImplementation(async () => {
                res.headersSent = true;
                throw refusal;
            });

            await controller.chatCompletions(
                auth,
                undefined,
                undefined,
                { stream: true, messages: [] } as any,
                res,
            );

            expect(res.destroy).toHaveBeenCalledWith(refusal);
            expect(res.status).not.toHaveBeenCalled();
        });

        it.each([undefined, 'false', ''])(
            'with DEMO unset (%s), every error keeps the 422 envelope exactly as before',
            async (demo) => {
                if (demo === undefined) delete process.env.DEMO;
                else process.env.DEMO = demo;
                for (const error of [...refusals(), new Error('upstream down')]) {
                    jest.clearAllMocks();
                    service.handleCompletion.mockRejectedValue(error);

                    await controller.chatCompletions(
                        auth,
                        undefined,
                        undefined,
                        { messages: [] } as any,
                        res,
                    );

                    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
                    expect(res.status).toHaveBeenCalledWith(422);
                    expect(res.json).toHaveBeenCalledWith({
                        error: { message: error.message, type: 'provider_unavailable' },
                    });
                }
            },
        );
    });
});
