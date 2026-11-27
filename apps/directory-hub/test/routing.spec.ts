import { describe, expect, it } from 'vitest';

import { routeServedFetch, routeServedHosts } from '../src/routing';
import { DirectoryLoader, type FetchFn } from '../src/loader';
import { directoryInfo, fakeNetwork, loaderFor, ORIGINS, REGISTRY_URL, registryDocument } from './fixtures';

const RMM = 'https://rmm.ever.works';

/** A binding that records its calls and answers like the route-served Worker. */
function binding(answer: (url: string) => Response = () => new Response('{}')) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	return {
		calls,
		fetch: async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return answer(url);
		}
	};
}

describe('route-served directories', () => {
	it('maps hosts to bindings and skips entries without a usable binding', () => {
		const rmm = binding();
		const hosts = routeServedHosts({
			ROUTE_SERVED: {
				'RMM.ever.works': 'DIR_RMM',
				'gone.ever.works': 'DIR_GONE',
				'bad.ever.works': 'NOT_A_FETCHER'
			},
			DIR_RMM: rmm,
			NOT_A_FETCHER: 'text'
		});
		expect([...hosts.keys()]).toEqual(['rmm.ever.works']);
		expect(routeServedHosts({})).toEqual(new Map());
		expect(routeServedHosts({ ROUTE_SERVED: ['rmm.ever.works'] })).toEqual(new Map());
	});

	it('also reads ROUTE_SERVED given as JSON text, and ignores text that is not a JSON object', () => {
		// wrangler passes an object `vars` value as parsed JSON, but a value set as text (dashboard, `--var`) is a string.
		const rmm = binding();
		const fromText = routeServedHosts({ ROUTE_SERVED: '{"rmm.ever.works":"DIR_RMM"}', DIR_RMM: rmm });
		expect([...fromText.keys()]).toEqual(['rmm.ever.works']);
		expect(fromText.get('rmm.ever.works')).toBe(rmm);
		for (const text of ['', 'not json', '["rmm.ever.works"]', 'null', '"DIR_RMM"', '42']) {
			expect(routeServedHosts({ ROUTE_SERVED: text, DIR_RMM: rmm })).toEqual(new Map());
		}
	});

	it('sends route-served hosts to their binding without the cf options, everything else to the fallback', async () => {
		const rmm = binding();
		const seen: string[] = [];
		const fallback: FetchFn = async (input) => {
			seen.push(input);
			return new Response('{}');
		};
		const fetchFn = routeServedFetch({ ROUTE_SERVED: { 'rmm.ever.works': 'DIR_RMM' }, DIR_RMM: rmm }, fallback);
		const signal = AbortSignal.timeout(1000);
		await fetchFn(`${RMM}/data/directory.json`, {
			headers: { Accept: 'application/json' },
			redirect: 'manual',
			signal,
			cf: { cacheEverything: true }
		});
		await fetchFn(`${ORIGINS.CRM}/data/directory.json`);
		expect(rmm.calls.map((call) => call.url)).toEqual([`${RMM}/data/directory.json`]);
		expect(rmm.calls[0]?.init).toEqual({ headers: { Accept: 'application/json' }, redirect: 'manual', signal });
		expect(seen).toEqual([`${ORIGINS.CRM}/data/directory.json`]);
	});

	it('returns the fallback itself when nothing is route-served', () => {
		const fallback: FetchFn = async () => new Response('{}');
		expect(routeServedFetch({ REGISTRY_URL }, fallback)).toBe(fallback);
	});

	it('makes a route-served directory available that a zone fetch could not reach', async () => {
		const network = fakeNetwork();
		const registry = registryDocument();
		(registry['directories'] as unknown[]).push({ id: 'rmm', url: RMM, name: 'Awesome RMM' });
		network.routes.set(REGISTRY_URL, () => Response.json(registry));
		// What the zone gives a same-zone fetch to a route-served Worker:
		network.routes.set(`${RMM}/data/directory.json`, () => new Response('error code: 522', { status: 522 }));

		const zoneOnly = loaderFor(network);
		expect((await zoneOnly.getDirectories()).unavailable.find((entry) => entry.id === 'rmm')?.reason).toBe(
			'HTTP 522'
		);

		const rmm = binding((url) =>
			url.endsWith('/data/directory.json')
				? Response.json(directoryInfo(RMM, 'Awesome RMM', 'Remote monitoring and management tools.'))
				: new Response('not found', { status: 404 })
		);
		const routed = new DirectoryLoader({
			registryUrl: REGISTRY_URL,
			fetch: routeServedFetch({ ROUTE_SERVED: { 'rmm.ever.works': 'DIR_RMM' }, DIR_RMM: rmm }, network.fetch),
			now: () => 1_000_000,
			timeoutMs: 1000
		});
		const set = await routed.getDirectories();
		expect(set.available.map((directory) => directory.entry.id)).toContain('rmm');
		expect(set.unavailable.map((entry) => entry.id)).not.toContain('rmm');
	});
});
