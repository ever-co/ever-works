import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';
import pkg from '../../package.json';
import { FleetLocalAiPlugin } from '../fleet-local-ai.plugin';
import { FLEET_LOCAL_AI_API_KEY, FLEET_LOCAL_AI_BASE_URL } from '../fleet-transport';
import { answered, fakeRelay } from './fake-relay';

/**
 * The plugin as the platform sees it: its identity, its models (the caller's
 * nodes', always free), its availability answers, and the transport it hands
 * to a pipeline.
 */

const SCOPE = { userId: 'user-1' };

async function loaded(relay?: ReturnType<typeof fakeRelay>) {
	const plugin = new FleetLocalAiPlugin();
	await plugin.onLoad({
		pluginId: 'fleet-local-ai',
		logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
		services: relay ? { localAi: relay } : {}
	} as unknown as PluginContext);
	return plugin;
}

describe('FleetLocalAiPlugin — identity', () => {
	it('is an AI provider whose manifest matches its package metadata', () => {
		const plugin = new FleetLocalAiPlugin();
		expect(plugin.id).toBe(pkg.everworks.plugin.id);
		expect(plugin.category).toBe('ai-provider');
		expect(plugin.capabilities).toEqual(['ai-provider']);
		expect(plugin.getManifest()).toMatchObject({
			id: 'fleet-local-ai',
			category: 'ai-provider',
			distribution: pkg.everworks.plugin.distribution,
			builtIn: true,
			autoEnable: false
		});
		expect(plugin.settingsSchema.required).toEqual(['defaultModel']);
		expect(JSON.stringify(plugin.settingsSchema)).not.toMatch(/apiKey|baseUrl|x-secret/);
	});
});

describe('FleetLocalAiPlugin — models', () => {
	it("lists the caller's served models, free, with the configured context window", async () => {
		const relay = fakeRelay(() => answered({}), [{ id: 'flashnext', nodes: 2 }]);
		const plugin = await loaded(relay);

		const models = await plugin.listModels({ contextLength: 65_536 }, SCOPE);

		expect(models).toEqual([
			expect.objectContaining({
				id: 'flashnext',
				name: 'flashnext — on 2 of your computers',
				inputCostPer1k: 0,
				outputCostPer1k: 0,
				capabilities: expect.objectContaining({ maxContextLength: 65_536, supportsToolCalling: true })
			})
		]);
		expect(relay.listModels).toHaveBeenCalledWith({ userId: 'user-1' });
	});

	it('lists nothing without the caller or the relay', async () => {
		expect(await (await loaded(fakeRelay(() => answered({})))).listModels({})).toEqual([]);
		expect(await (await loaded()).listModels({}, SCOPE)).toEqual([]);
	});

	it('describes any model as free without a network round trip (cost and context lookups)', async () => {
		const relay = fakeRelay(() => answered({}));
		const plugin = await loaded(relay);
		await expect(plugin.getModel('flashnext', {})).resolves.toMatchObject({
			id: 'flashnext',
			inputCostPer1k: 0,
			outputCostPer1k: 0,
			capabilities: { maxContextLength: 32_768 }
		});
		expect(relay.listModels).not.toHaveBeenCalled();
	});
});

describe('FleetLocalAiPlugin — availability', () => {
	it('says which of your computers serve the chosen model', async () => {
		const plugin = await loaded(fakeRelay(() => answered({}), [{ id: 'flashnext', nodes: 3 }]));
		await expect(plugin.validateConnection({ defaultModel: 'flashnext' }, SCOPE)).resolves.toEqual({
			success: true,
			message: 'flashnext is served by 3 of your computers.'
		});
		await expect(plugin.isAvailable({ defaultModel: 'flashnext' }, SCOPE)).resolves.toBe(true);
	});

	it('matches a model id against the tag value the nodes advertise', async () => {
		const plugin = await loaded(fakeRelay(() => answered({}), [{ id: 'qwen3-8b', nodes: 1 }]));
		await expect(plugin.isAvailable({ defaultModel: 'qwen3:8b' }, SCOPE)).resolves.toBe(true);
	});

	it.each([
		[
			'no computer serves anything',
			[],
			{ defaultModel: 'flashnext' },
			/None of your computers serves a local model/
		],
		[
			'the chosen model is not served',
			[{ id: 'other', nodes: 1 }],
			{ defaultModel: 'flashnext' },
			/serves "flashnext"/
		]
	])('fails when %s, naming the fix', async (_label, models, settings, message) => {
		const plugin = await loaded(fakeRelay(() => answered({}), models));
		const result = await plugin.validateConnection(settings, SCOPE);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(message);
	});

	it('fails without the caller, or in a process without the relay', async () => {
		await expect((await loaded(fakeRelay(() => answered({})))).isAvailable({})).resolves.toBe(false);
		await expect((await loaded()).validateConnection({}, SCOPE)).resolves.toMatchObject({
			success: false,
			message: expect.stringContaining('cannot reach your computers')
		});
		await expect((await loaded()).healthCheck()).resolves.toMatchObject({ status: 'degraded' });
	});
});

describe('FleetLocalAiPlugin — the transport for pipelines', () => {
	it('hands a placeholder origin, a non-secret token and the relay fetch', async () => {
		const relay = fakeRelay(() => answered({ ok: true }));
		const transport = (await loaded(relay)).createTransport(
			{ userId: 'user-1', workId: 'w' },
			{ requestTimeoutSec: 30 }
		);

		expect(transport.baseUrl).toBe(FLEET_LOCAL_AI_BASE_URL);
		expect(transport.baseUrl).toMatch(/\.invalid\//);
		expect(transport.apiKey).toBe(FLEET_LOCAL_AI_API_KEY);
		await transport.fetch(`${FLEET_LOCAL_AI_BASE_URL}/chat/completions`, {
			method: 'POST',
			body: JSON.stringify({ model: 'flashnext', messages: [{ role: 'user', content: 'hi' }] })
		});
		expect(relay.requests[0]).toMatchObject({ userId: 'user-1', workId: 'w', timeoutMs: 30_000 });
	});
});
