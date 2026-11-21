import { describe, expect, it, vi } from 'vitest';

const { createOpenAICompatible } = vi.hoisted(() => ({
	createOpenAICompatible: vi.fn(() => vi.fn(() => ({ specificationVersion: 'v3', provider: 'x', modelId: 'm' })))
}));
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));

import { AgentPipelinePlugin } from '../agent-pipeline.plugin';

/**
 * Local AI on the owner's computers is an AI provider with no URL: the AI
 * facade hands its transport on as `providerConfig.fetch`, and the pipeline
 * must build its model with it — every request through the transport, never
 * to the placeholder `baseUrl`. A provider without one is built exactly as
 * before.
 */

const STOP = new Error('stop after the model is built');

async function buildModelWith(providerConfig: Record<string, unknown>) {
	createOpenAICompatible.mockClear();
	const plugin = new AgentPipelinePlugin();
	const run = (plugin as unknown as { runAgentGeneration: (...args: unknown[]) => Promise<unknown> })
		.runAgentGeneration;
	const execContext = {
		aiFacade: {
			// The first call after the model is built: stop there.
			resolveModelContextLength: vi.fn().mockRejectedValue(STOP)
		}
	};
	await expect(
		run.call(
			plugin,
			{ routing: {}, defaultModel: 'flashnext', ...providerConfig },
			'/tmp/workspace',
			execContext,
			{ userId: 'user-1', workId: 'work-1' },
			{ id: 'work-1', name: 'W', slug: 'w' },
			{},
			{ items: [] },
			undefined,
			new AbortController().signal,
			{ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			{},
			undefined,
			[]
		)
	).rejects.toBe(STOP);
	return createOpenAICompatible.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('agent pipeline — the provider transport', () => {
	it('passes the provider transport as the AI SDK fetch', async () => {
		const fetch = vi.fn();
		const options = await buildModelWith({
			providerId: 'fleet-local-ai',
			providerName: 'Local AI on your computers',
			baseUrl: 'https://fleet-local-ai.invalid/v1',
			apiKey: 'fleet-local-ai',
			fetch
		});
		expect(options).toMatchObject({ name: 'fleet-local-ai', baseURL: 'https://fleet-local-ai.invalid/v1' });
		expect(options.fetch).toBe(fetch);
	});

	it('builds a URL provider exactly as before (no fetch option)', async () => {
		const options = await buildModelWith({
			providerId: 'openrouter',
			providerName: 'OpenRouter',
			baseUrl: 'https://openrouter.ai/api/v1',
			apiKey: 'sk-test-or'
		});
		expect(options).toEqual({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-test-or' });
	});
});
