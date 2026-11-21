import { describe, expect, it } from 'vitest';
import { resolveLocalAiSettings } from './config';
import { LocalAiMonitor } from './monitor';
import { BUILT_IN_LOCAL_AI_PROVIDERS, openAiCompatibleProvider, probeOpenAiModels } from './providers';
import { defaultLocalAiProviderRegistry, LocalAiProviderRegistry } from './registry';
import { fakeFetch } from './local-ai-test-kit';
import { LocalAiConfigError, type LocalAiProviderDefinition } from './types';

/**
 * The provider registry — the extension point. A new kind is one definition
 * object plus one registration; these specs prove both halves, including that
 * a kind the node did not ship with is configured, validated and probed with
 * no other change.
 */

describe('LocalAiProviderRegistry', () => {
	it('registers the built-in kinds, matching the platform plugin ids where one exists', () => {
		expect(defaultLocalAiProviderRegistry().kinds()).toEqual([
			'openai-compatible',
			'llama-swap',
			'ollama',
			'lm-studio',
			'vllm'
		]);
	});

	it('answers an unknown kind with an error naming the kinds it knows', () => {
		expect(() => defaultLocalAiProviderRegistry().get('koboldcpp')).toThrow(LocalAiConfigError);
		expect(() => defaultLocalAiProviderRegistry().get('koboldcpp')).toThrow(
			/Unknown local AI provider kind "koboldcpp" — this node knows: openai-compatible, llama-swap, ollama, lm-studio, vllm/
		);
	});

	it('refuses a definition with an invalid kind id, no probe, an unknown wire API, or a duplicate kind', () => {
		const registry = new LocalAiProviderRegistry([]);
		expect(() => registry.register({ ...openAiCompatibleProvider, kind: 'Bad Kind' })).toThrow(
			/not a valid kind id/
		);
		expect(() =>
			registry.register({ ...openAiCompatibleProvider, kind: 'noprobe', probe: undefined as never })
		).toThrow(/has no probe/);
		expect(() =>
			registry.register({ ...openAiCompatibleProvider, kind: 'grpc', defaultApis: ['grpc' as never] })
		).toThrow(/unknown wire API/);
		registry.register(openAiCompatibleProvider);
		expect(() => registry.register(openAiCompatibleProvider)).toThrow(/registered twice/);
	});

	it('does no work at import time: the default registry is built on first use', () => {
		expect(BUILT_IN_LOCAL_AI_PROVIDERS.every((definition) => typeof definition.probe === 'function')).toBe(true);
		expect(defaultLocalAiProviderRegistry()).toBe(defaultLocalAiProviderRegistry());
	});

	it('runs a kind registered by an embedder end to end: config, validation, probe, custom endpoint', async () => {
		const tabby: LocalAiProviderDefinition = {
			kind: 'tabby',
			displayName: 'TabbyAPI',
			description: 'A kind this node did not ship with.',
			defaultBaseUrl: 'http://127.0.0.1:5000',
			defaultApis: ['openai-chat', 'anthropic-messages'],
			probe: async (context) => ({ models: await probeOpenAiModels(context), version: 'tabby-1' }),
			endpoint: (provider, api) =>
				api === 'anthropic-messages' ? `${provider.baseUrl}/anthropic` : `${provider.baseUrl}/v1`
		};
		const registry = new LocalAiProviderRegistry([...BUILT_IN_LOCAL_AI_PROVIDERS, tabby]);
		const { settings, problems } = resolveLocalAiSettings(
			{
				stored: {
					providers: [{ kind: 'tabby', defaultModel: 'exl2-coder' }],
					agentRuntime: { cli: 'claude-code', provider: 'tabby' }
				}
			},
			registry
		);
		expect(problems).toEqual([]);
		expect(settings!.providers[0]).toMatchObject({
			id: 'tabby',
			kind: 'tabby',
			baseUrl: 'http://127.0.0.1:5000',
			apis: ['openai-chat', 'anthropic-messages']
		});
		const fetch = fakeFetch({ 'http://127.0.0.1:5000/v1/models': { body: { data: [{ id: 'exl2-coder' }] } } });
		const monitor = new LocalAiMonitor({
			settings: settings!,
			registry,
			fetchFn: fetch.fetchFn,
			secrets: { readKeyFile: async () => null, env: {} }
		});
		const binding = await monitor.bindingFor('claude-code');
		expect(binding).toMatchObject({
			kind: 'bound',
			providerKind: 'tabby',
			model: 'exl2-coder',
			endpoint: 'http://127.0.0.1:5000/anthropic'
		});
		expect(monitor.snapshot()[0]).toMatchObject({ status: 'up', version: 'tabby-1' });
	});
});
