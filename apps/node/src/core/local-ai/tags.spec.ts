import { describe, expect, it } from 'vitest';
import { applyCapabilitySelection, describeSelf, detectCapabilities, type CommandRunner } from '../capabilities';
import { resolveLocalAiSettings, type NodeLocalAiConfig } from './config';
import { defaultLocalAiProviderRegistry } from './registry';
import {
	LOCAL_AI_MAX_MODEL_TAGS,
	LOCAL_AI_MAX_TAGS,
	localAiCapabilityFacts,
	localModelTagSlug,
	MAX_EXTRA_CAPABILITIES,
	normalizeExtraCapabilities
} from './tags';
import type { LocalAiProviderStatus } from './types';

/**
 * Local-AI capability tags and the operator's extra tags: what is emitted,
 * how it is bounded, and that a CLI bound to a provider that cannot serve it
 * loses its own tag.
 */

const registry = defaultLocalAiProviderRegistry();

function facts(stored: NodeLocalAiConfig, statuses: LocalAiProviderStatus[]) {
	const { settings } = resolveLocalAiSettings({ stored }, registry);
	return localAiCapabilityFacts(settings, statuses, registry);
}

function up(id: string, kind: string, models: string[]): LocalAiProviderStatus {
	return {
		id,
		kind,
		status: 'up',
		checkedAt: '2026-11-21T00:00:00.000Z',
		latencyMs: 5,
		models: models.map((model) => ({ id: model })),
		version: null,
		error: null,
		apis: []
	};
}

describe('localAiCapabilityFacts', () => {
	it('emits nothing for a node without local AI', () => {
		expect(localAiCapabilityFacts(null, [], registry)).toEqual({ tags: [], unavailableClis: [] });
	});

	it('emits the family tags for a healthy provider without a bound CLI', () => {
		expect(
			facts({ providers: [{ kind: 'ollama' }] }, [up('ollama', 'ollama', ['qwen3:8b', 'llama3.2:latest'])])
		).toEqual({
			tags: ['local-ai', 'local-ai:ollama', 'local-model:qwen3-8b', 'local-model:llama3.2-latest'],
			unavailableClis: []
		});
	});

	it('bounds the model tags and the whole family', () => {
		const many = Array.from({ length: 40 }, (_, index) => `model-${index}`);
		const result = facts(
			{
				providers: [
					{ id: 'a', kind: 'ollama' },
					{ id: 'b', kind: 'vllm' },
					{ id: 'c', kind: 'lm-studio' },
					{ id: 'd', kind: 'llama-swap', baseUrl: 'http://gw:8000' }
				]
			},
			[up('a', 'ollama', many), up('b', 'vllm', many), up('c', 'lm-studio', many), up('d', 'llama-swap', many)]
		);
		expect(result.tags.length).toBeLessThanOrEqual(LOCAL_AI_MAX_TAGS);
		expect(result.tags.filter((tag) => tag.startsWith('local-model:')).length).toBeLessThanOrEqual(
			LOCAL_AI_MAX_MODEL_TAGS
		);
		expect(result.tags.slice(0, 5)).toEqual([
			'local-ai',
			'local-ai:ollama',
			'local-ai:vllm',
			'local-ai:lm-studio',
			'local-ai:llama-swap'
		]);
	});

	it('puts the bound model first and only declared models when the operator declared some', () => {
		const result = facts(
			{
				providers: [{ id: 'gpu', kind: 'llama-swap', baseUrl: 'http://gw:8000', models: ['coder'] }],
				agentRuntime: { cli: 'claude-code', provider: 'gpu', model: 'flashnext' }
			},
			[up('gpu', 'llama-swap', ['other', 'coder', 'flashnext'])]
		);
		expect(result.tags).toEqual([
			'local-ai',
			'local-agent:claude-code',
			'local-ai:llama-swap',
			'local-model:flashnext',
			'local-model:coder'
		]);
	});

	it('withholds a bound CLI whose provider is down, unknown or missing', () => {
		const stored: NodeLocalAiConfig = {
			providers: [{ id: 'gpu', kind: 'llama-swap', baseUrl: 'http://gw:8000', defaultModel: 'flashnext' }],
			agentRuntime: [
				{ cli: 'claude-code', provider: 'gpu' },
				{ cli: 'codex', provider: 'nope' }
			]
		};
		expect(facts(stored, [{ ...up('gpu', 'llama-swap', []), status: 'down', error: 'HTTP 502' }])).toEqual({
			tags: [],
			unavailableClis: ['claude-code', 'codex']
		});
		expect(facts(stored, []).unavailableClis).toEqual(['claude-code', 'codex']);
	});

	it('slugs model ids into the tag grammar, and drops one that would not fit a tag', () => {
		expect(localModelTagSlug('Qwen/Qwen3-8B')).toBe('qwen-qwen3-8b');
		expect(localModelTagSlug('qwen3:8b')).toBe('qwen3-8b');
		expect(localModelTagSlug('a'.repeat(40))).toBeNull();
		expect(localModelTagSlug('::')).toBeNull();
	});
});

describe('normalizeExtraCapabilities', () => {
	it('keeps valid tags in order, de-duplicated', () => {
		expect(normalizeExtraCapabilities(['gpu', ' gpu:nvidia ', 'gpu', 'cuda-12.4'])).toEqual({
			tags: ['gpu', 'gpu:nvidia', 'cuda-12.4'],
			problems: []
		});
	});

	it('refuses identity, consent, containment and local-AI tags, which the node decides itself', () => {
		const { tags, problems } = normalizeExtraCapabilities([
			'os:linux',
			'git-push',
			'claude-code',
			'attended',
			'managed',
			'screen:desktop',
			'local-ai',
			'local-model:x',
			'local-agent:codex'
		]);
		expect(tags).toEqual([]);
		expect(problems).toHaveLength(9);
		expect(problems.every((problem) => problem.includes('decides that tag itself'))).toBe(true);
	});

	it('refuses tags outside the grammar or too long, and bounds the list', () => {
		const { tags, problems } = normalizeExtraCapabilities([
			'GPU',
			'gpu nvidia',
			'x'.repeat(33),
			...Array.from({ length: 12 }, (_, index) => `t${index}`)
		]);
		expect(tags).toHaveLength(MAX_EXTRA_CAPABILITIES);
		expect(problems).toHaveLength(3 + 12 - MAX_EXTRA_CAPABILITIES);
	});
});

describe('capability detection with local AI', () => {
	const runner: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: '' }) };
	const environment = {
		platform: 'linux',
		arch: 'x64',
		nodeVersion: 'v26.1.0',
		hasDisplay: false,
		modelCli: { 'claude-code': '/usr/local/bin/claude', codex: '/usr/local/bin/codex' }
	};

	it('appends the local-AI tags after every older tag', async () => {
		const tags = await detectCapabilities(runner, {
			...environment,
			localAi: { tags: ['local-ai', 'local-agent:claude-code'], unavailableClis: [] }
		});
		expect(tags.slice(-2)).toEqual(['local-ai', 'local-agent:claude-code']);
		expect(tags).toContain('claude-code');
	});

	it('withholds the CLI tag of a bound CLI that cannot run, like a CLI that is not installed', async () => {
		const tags = await detectCapabilities(runner, {
			...environment,
			localAi: { tags: [], unavailableClis: ['claude-code'] }
		});
		expect(tags).not.toContain('claude-code');
		expect(tags).toContain('codex');
	});

	it('keeps local-AI tags through a capability selection written before they existed', () => {
		expect(
			applyCapabilitySelection(['os:linux', 'docker', 'local-ai', 'local-model:flashnext'], ['docker'])
		).toEqual(['os:linux', 'docker', 'local-ai', 'local-model:flashnext']);
	});

	it('adds the operator’s extra tags after the selection is applied', async () => {
		const description = await describeSelf(
			runner,
			{ ...environment, extraCapabilities: ['gpu', 'gpu:nvidia'] },
			'0.2.13',
			['terminal']
		);
		expect(description.capabilities).toEqual(['os:linux', 'arch:x64', 'node:26', 'terminal', 'gpu', 'gpu:nvidia']);
	});
});
