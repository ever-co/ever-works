/**
 * The OpenAI-compatible service reaches the agent's facades, database and services barrels; the
 * facade is the double below and the rest is unused here, so they stand in as bare classes.
 */
jest.mock('@ever-works/agent/facades', () => ({ AiFacadeService: class AiFacadeService {} }));
jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class UserRepository {},
    WorkRepository: class WorkRepository {},
}));
jest.mock('@ever-works/agent/services', () => ({
    KbMentionResolverService: class KbMentionResolverService {},
    parseKbMentions: () => [],
    formatKbContext: () => '',
}));

import type { INestApplication, Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { UserRepository, WorkRepository } from '@ever-works/agent/database';
import {
    DemoModelUnavailableError,
    DemoQuotaExceededError,
    DemoRateLimitedError,
} from '@ever-works/agent/demo';
import { AiFacadeService } from '@ever-works/agent/facades';
import { KbMentionResolverService } from '@ever-works/agent/services';
import { OpenAiCompatController } from '../../ai-conversation/openai-compat.controller';
import { OpenAiCompatService } from '../../ai-conversation/openai-compat.service';
import { DemoErrorFilter } from '../demo-error.filter';
import { DemoRestrictionsGuard } from '../demo-restrictions.guard';

/**
 * Platform demo mode, R39 — the assistant chat over HTTP.
 *
 * The web's assistant chat calls `POST /api/v1/chat/completions` (`apps/web/src/lib/ai/agent.ts`,
 * `${API_URL}/v1`), so a demo visitor's chat must get past the demo's route guard, and the AI
 * facade's demo refusals (`DEMO_AI_QUOTA`, `DEMO_AI_BUSY`, `DEMO_MODEL_UNAVAILABLE`) must come back
 * with their own status and `code`: that `code` is what the web turns into a friendly message
 * (`apps/web/src/lib/demo/chat-stream-error.ts`). The real controller, service, guard and filter;
 * the facade is a double that refuses the way the real one does on a demo instance, before the
 * first chunk.
 *
 * With `DEMO` off, `DemoModule` registers neither the guard nor the filter
 * (`demo.module.spec.ts`), and every error keeps the route's own 422 / 502 envelope.
 */

const DEMO_ID = '00000000-0000-4000-8000-0000000000d1';
const OPERATOR_ID = '00000000-0000-4000-8000-0000000000a1';
const BODY = { model: 'auto', messages: [{ role: 'user', content: 'Plan my week' }] };

describe('POST /api/v1/chat/completions on a demo instance (R39)', () => {
    const savedDemo = process.env.DEMO;
    const facade = {
        createChatCompletion: jest.fn(),
        createStreamingChatCompletion: jest.fn(),
    };
    const users = {
        findById: jest.fn(async (id: string) => ({
            id,
            registrationProvider: id === DEMO_ID ? 'demo' : 'local',
        })),
    };
    let app: INestApplication | undefined;

    afterEach(async () => {
        await app?.close();
        app = undefined;
        jest.clearAllMocks();
        if (savedDemo === undefined) delete process.env.DEMO;
        else process.env.DEMO = savedDemo;
    });

    /** The API's chat route; with `demo`, the two globals `DemoModule` registers on a demo. */
    async function serve(demo: boolean): Promise<INestApplication> {
        if (demo) process.env.DEMO = 'true';
        else delete process.env.DEMO;
        const globals: Provider[] = demo
            ? [
                  { provide: APP_GUARD, useClass: DemoRestrictionsGuard },
                  { provide: APP_FILTER, useClass: DemoErrorFilter },
              ]
            : [];
        const moduleRef = await Test.createTestingModule({
            controllers: [OpenAiCompatController],
            providers: [
                OpenAiCompatService,
                { provide: AiFacadeService, useValue: facade },
                { provide: WorkRepository, useValue: { findByUser: async () => [] } },
                {
                    provide: KbMentionResolverService,
                    useValue: { resolveMentions: async () => [] },
                },
                { provide: UserRepository, useValue: users },
                ...globals,
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        // Stands in for `AuthSessionGuard`, which puts the signed-in caller on the request.
        app.use(
            (
                req: { headers: Record<string, unknown>; user?: unknown },
                _res: unknown,
                next: () => void,
            ) => {
                const userId = req.headers['x-test-user'];
                if (typeof userId === 'string') req.user = { userId };
                next();
            },
        );
        await app.init();
        return app;
    }

    function chat(server: INestApplication, userId: string, stream: boolean): request.Test {
        return request(server.getHttpServer())
            .post('/api/v1/chat/completions')
            .set('x-test-user', userId)
            .send({ ...BODY, stream });
    }

    /** A facade stream that refuses before its first chunk, as the demo quota does. */
    function refusingStream(error: Error) {
        // eslint-disable-next-line require-yield
        return (async function* () {
            throw error;
        })();
    }

    function refuseWith(error: Error): void {
        facade.createChatCompletion.mockRejectedValue(error);
        facade.createStreamingChatCompletion.mockImplementation(() => refusingStream(error));
    }

    describe('with DEMO on', () => {
        it.each([false, true])(
            "a demo sandbox's chat reaches the AI facade and gets its coded refusal back (stream: %s)",
            async (stream) => {
                const server = await serve(true);
                refuseWith(new DemoQuotaExceededError('sandbox'));

                const response = await chat(server, DEMO_ID, stream);

                // Past the guard: the facade was asked, once, with the visitor's own id.
                const called = stream
                    ? facade.createStreamingChatCompletion
                    : facade.createChatCompletion;
                expect(called).toHaveBeenCalledTimes(1);
                expect(called.mock.calls[0][1]).toMatchObject({ userId: DEMO_ID });
                expect(response.status).toBe(429);
                expect(response.headers['content-type']).toMatch(/^application\/json/);
                expect(response.body).toMatchObject({
                    statusCode: 429,
                    code: 'DEMO_AI_QUOTA',
                    message: 'This demo workspace has used all its live AI requests',
                    quotaScope: 'sandbox',
                });
            },
        );

        it('the per-minute limit answers 429 DEMO_AI_BUSY with retryAfterMs and Retry-After', async () => {
            const server = await serve(true);
            refuseWith(new DemoRateLimitedError(2_500));

            const response = await chat(server, DEMO_ID, true);

            expect(response.status).toBe(429);
            expect(response.headers['retry-after']).toBe('3');
            expect(response.body).toMatchObject({
                statusCode: 429,
                code: 'DEMO_AI_BUSY',
                retryAfterMs: 2_500,
            });
        });

        it('a free model that is down answers 503 DEMO_MODEL_UNAVAILABLE', async () => {
            const server = await serve(true);
            refuseWith(new DemoModelUnavailableError('google/gemma-4-31b-it:free'));

            const response = await chat(server, DEMO_ID, true);

            expect(response.status).toBe(503);
            expect(response.body).toMatchObject({
                statusCode: 503,
                code: 'DEMO_MODEL_UNAVAILABLE',
            });
        });

        it("an operator's chat gets the same coded refusal", async () => {
            const server = await serve(true);
            refuseWith(new DemoQuotaExceededError('day'));

            const response = await chat(server, OPERATOR_ID, false);

            expect(response.status).toBe(429);
            expect(response.body).toMatchObject({ code: 'DEMO_AI_QUOTA' });
        });

        it('any other facade error keeps the 422 / 502 envelope', async () => {
            const server = await serve(true);
            refuseWith(new Error('no provider configured'));

            const plain = await chat(server, DEMO_ID, false);
            expect(plain.status).toBe(422);
            expect(plain.body).toEqual({
                error: { message: 'no provider configured', type: 'provider_unavailable' },
            });

            const streamed = await chat(server, DEMO_ID, true);
            expect(streamed.status).toBe(502);
            expect(JSON.parse(streamed.text)).toEqual({
                error: {
                    message: 'no provider configured',
                    type: 'provider_error',
                    code: 'ai_provider_error',
                },
            });
        });
    });

    describe('with DEMO off', () => {
        it('every error keeps the 422 / 502 envelope exactly as before', async () => {
            const server = await serve(false);

            for (const error of [new DemoQuotaExceededError('day'), new Error('upstream down')]) {
                refuseWith(error);

                const plain = await chat(server, DEMO_ID, false);
                expect(plain.status).toBe(422);
                expect(plain.body).toEqual({
                    error: { message: error.message, type: 'provider_unavailable' },
                });

                const streamed = await chat(server, DEMO_ID, true);
                expect(streamed.status).toBe(502);
                expect(JSON.parse(streamed.text)).toEqual({
                    error: {
                        message: error.message,
                        type: 'provider_error',
                        code: 'ai_provider_error',
                    },
                });
            }
        });
    });
});
