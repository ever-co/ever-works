import { describe, expect, it, vi } from 'vitest';
import { APICallError, NoOutputGeneratedError, streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { consumeStreamWithLogging } from '../utils/stream-text-logging';

/**
 * When the provider refuses the call (here: OpenRouter's 402 on an account with no credits),
 * `streamText` reports it only as an `error` part of the stream. Awaiting the result afterwards
 * (`result.steps`, `result.text`, …) then rejects with the SDK's generic `NoOutputGeneratedError`
 * ("No output generated. Check the stream for errors."), which is what the Work used to show.
 * `consumeStreamWithLogging` throws the provider's own error instead, so the Work says what is wrong.
 */

const CREDITS_MESSAGE = 'Insufficient credits. Add more using https://openrouter.ai/settings/credits';

function creditsError(): APICallError {
	return new APICallError({
		message: CREDITS_MESSAGE,
		url: 'https://openrouter.ai/api/v1/chat/completions',
		requestBodyValues: {},
		statusCode: 402,
		isRetryable: false
	});
}

async function* streamOf(...parts: unknown[]): AsyncGenerator<never> {
	for (const part of parts) yield part as never;
}

const FINISHED_STEP = {
	type: 'finish-step',
	finishReason: 'stop',
	usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
};

describe('consumeStreamWithLogging: a stream that fails before any step finished', () => {
	it("throws the provider's own error, not the SDK's 'No output generated' (real streamText)", async () => {
		const refusal = creditsError();
		const model = new MockLanguageModelV3({
			doStream: async () => {
				throw refusal;
			}
		});
		const result = streamText({ model, prompt: 'Find AI robot companies', maxRetries: 0, onError: () => {} });
		const onLogEntry = vi.fn();

		await expect(
			consumeStreamWithLogging(result, { onLogEntry, scope: 'Parent agent', stepIndex: 1 })
		).rejects.toBe(refusal);

		// The realtime log line is unchanged.
		expect(onLogEntry).toHaveBeenCalledWith(
			expect.objectContaining({ level: 'error', message: `Parent agent: stream error - ${CREDITS_MESSAGE}` })
		);
		// What the pipeline used to surface: the SDK only knows that no output was generated.
		await expect(result.text).rejects.toSatisfy((error: unknown) => NoOutputGeneratedError.isInstance(error));
	});

	it('throws a non-Error stream error as an Error that carries its message', async () => {
		await expect(
			consumeStreamWithLogging(
				{
					fullStream: streamOf(
						{ type: 'start-step' },
						{ type: 'error', error: { message: CREDITS_MESSAGE, code: 402 } }
					)
				},
				{ scope: 'Parent agent', stepIndex: 1 }
			)
		).rejects.toThrow(CREDITS_MESSAGE);

		await expect(
			consumeStreamWithLogging(
				{ fullStream: streamOf({ type: 'error', error: 'upstream refused the request' }) },
				{ scope: 'URL worker', stepIndex: 1 }
			)
		).rejects.toThrow('upstream refused the request');
	});

	it('names the failure even when the stream error carries no value', async () => {
		for (const error of [undefined, null, '', {}]) {
			await expect(
				consumeStreamWithLogging(
					{ fullStream: streamOf({ type: 'error', error }) },
					{ scope: 'Parent agent', stepIndex: 1 }
				)
			).rejects.toThrow('Parent agent: the AI provider stream failed without an error message');
		}
	});

	it('logs an object error by its message, not as [object Object]', async () => {
		const onLogEntry = vi.fn();
		await consumeStreamWithLogging(
			{ fullStream: streamOf({ type: 'error', error: { message: CREDITS_MESSAGE } }) },
			{ onLogEntry, scope: 'Parent agent', stepIndex: 1 }
		).catch(() => undefined);

		expect(onLogEntry).toHaveBeenCalledWith(
			expect.objectContaining({ message: `Parent agent: stream error - ${CREDITS_MESSAGE}` })
		);
	});
});

describe('consumeStreamWithLogging: streams that keep their output', () => {
	it('does not throw when a step finished before the error (the SDK keeps that partial output)', async () => {
		await expect(
			consumeStreamWithLogging(
				{
					fullStream: streamOf({ type: 'start-step' }, FINISHED_STEP, {
						type: 'error',
						error: creditsError()
					})
				},
				{ scope: 'Parent agent', stepIndex: 1 }
			)
		).resolves.toBeUndefined();
	});

	it('does not throw for a stream without an error', async () => {
		await expect(
			consumeStreamWithLogging(
				{ fullStream: streamOf({ type: 'start-step' }, FINISHED_STEP) },
				{ scope: 'Parent agent', stepIndex: 1 }
			)
		).resolves.toBeUndefined();
	});
});
