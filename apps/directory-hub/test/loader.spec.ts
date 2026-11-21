import { describe, expect, it } from 'vitest';

import { DirectoryLoader, RETRY_AFTER_MS, toDirectoryInfo } from '../src/loader';
import { parseRegistry } from '../src/registry';
import { directoryInfo, fakeNetwork, loaderFor, ORIGINS, REGISTRY_URL, registryDocument } from './fixtures';

describe('DirectoryLoader', () => {
	it('splits the registry into available and unavailable directories with reasons', async () => {
		const set = await loaderFor(fakeNetwork()).getDirectories();
		expect(set.available.map((directory) => directory.entry.id).sort()).toEqual([
			'crm',
			'managed-databases',
			'mcp-servers',
			'timetrack'
		]);
		const reasons = Object.fromEntries(set.unavailable.map((entry) => [entry.id, entry.reason]));
		expect(reasons).toEqual({
			old: 'not found (HTTP 404)',
			down: 'network error',
			mismatch: 'directory.json url does not match the registry'
		});
		expect(set.unavailable.find((entry) => entry.id === 'old')?.name).toBe('Old Directory');
	});

	it('serves from memory within the TTL and fetches each document once under concurrency', async () => {
		const network = fakeNetwork();
		const loader = loaderFor(network);
		await Promise.all([loader.getDirectories(), loader.getDirectories(), loader.getDirectories()]);
		await loader.getDirectories();
		expect(network.calls.filter((url) => url === REGISTRY_URL)).toHaveLength(1);
		expect(network.calls.filter((url) => url === `${ORIGINS.CRM}/data/directory.json`)).toHaveLength(1);
	});

	it('remembers a failure instead of refetching on every call, and retries later', async () => {
		let now = 1_000_000;
		const network = fakeNetwork();
		const loader = loaderFor(network, () => now);
		await loader.getDirectories();
		await loader.getDirectories();
		const oldCalls = () => network.calls.filter((url) => url.startsWith('https://old.ever.works')).length;
		expect(oldCalls()).toBe(1);
		now += RETRY_AFTER_MS + 1;
		await loader.getDirectories();
		expect(oldCalls()).toBe(2);
	});

	it('serves the last good copy, marked stale, when a refresh fails', async () => {
		let now = 1_000_000;
		const network = fakeNetwork();
		const loader = loaderFor(network, () => now);
		await loader.getDirectories();
		network.routes.set(`${ORIGINS.CRM}/data/directory.json`, () => new Response('boom', { status: 500 }));
		now += 11 * 60_000;
		const set = await loader.getDirectories();
		const crm = set.available.find((directory) => directory.entry.id === 'crm');
		expect(crm?.stale).toBe(true);
		expect(crm?.info.name).toBe('Awesome CRM');
	});

	it('keeps the last good registry when the registry fetch fails', async () => {
		let now = 1_000_000;
		const network = fakeNetwork();
		const loader = loaderFor(network, () => now);
		await loader.getRegistry();
		network.routes.set(REGISTRY_URL, () => new Response('down', { status: 503 }));
		now += 11 * 60_000;
		expect((await loader.getRegistry()).entries.length).toBe(7);
	});

	it('rejects documents over the byte cap', async () => {
		const network = fakeNetwork();
		const loader = new DirectoryLoader({
			registryUrl: REGISTRY_URL,
			fetch: network.fetch,
			limits: { items: 200 }
		});
		const { available } = await loader.getDirectories();
		const { loaded, failed } = await loader.getItemsFor(available);
		expect(loaded).toHaveLength(0);
		expect(new Set(failed.map((entry) => entry.reason))).toEqual(new Set(['document too large']));
	});

	it('reports timeouts', async () => {
		const network = fakeNetwork();
		network.routes.set(`${ORIGINS.TIME}/data/directory.json`, () => {
			throw new DOMException('The operation timed out.', 'TimeoutError');
		});
		const set = await loaderFor(network).getDirectories();
		expect(set.unavailable.find((entry) => entry.id === 'timetrack')?.reason).toBe('timed out');
	});

	it('does not follow redirects', async () => {
		const network = fakeNetwork();
		network.routes.set(
			`${ORIGINS.TIME}/data/directory.json`,
			() => new Response(null, { status: 302, headers: { Location: 'https://attacker.example.com/x.json' } })
		);
		const set = await loaderFor(network).getDirectories();
		expect(set.unavailable.find((entry) => entry.id === 'timetrack')?.reason).toBe('HTTP 302');
		expect(network.calls.some((url) => url.includes('attacker'))).toBe(false);
	});

	it('keeps only same-origin endpoints from a directory.json', () => {
		const entry = parseRegistry(registryDocument()).entries[0]!;
		const info = directoryInfo(entry.url, 'Awesome Time Tracking', 'x');
		info.endpoints.items = 'https://attacker.example.com/items.json';
		info.endpoints.mcp = 'https://attacker.example.com/mcp';
		const normalized = toDirectoryInfo(info, entry);
		if (typeof normalized === 'string') throw new Error(normalized);
		expect(normalized.endpoints.items).toBe(`${entry.url}/data/items.json`);
		expect(normalized.endpoints.mcp).toBeNull();
		expect(normalized.endpoints.item).toBe(`${entry.url}/data/items/{slug}.json`);
	});
});
