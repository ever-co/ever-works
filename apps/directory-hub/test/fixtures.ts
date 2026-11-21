/**
 * Fixture directories behind a fake `fetch` that records every URL it is asked for.
 */

import type { DirectoryInfo, ItemSummary } from '../src/contract';
import { DirectoryLoader, type FetchFn } from '../src/loader';

export const REGISTRY_URL = 'https://registry.test/registry.json';
export const HUB_URL = 'https://directories.ever.works';

export function item(
	origin: string,
	slug: string,
	name: string,
	description: string,
	categories: string[] = [],
	tags: string[] = [],
	featured = false
): ItemSummary {
	return {
		slug,
		name,
		description,
		url: `${origin}/items/${slug}`,
		website: `https://${slug}.example.com`,
		categories,
		category_ids: categories.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
		tags,
		tag_ids: tags.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
		featured,
		logo: null,
		updated_at: '2026-11-20'
	};
}

export function directoryInfo(origin: string, name: string, description: string, mcp = true): DirectoryInfo {
	return {
		version: 1,
		name,
		description,
		url: origin,
		item_name: 'Tool',
		items_name: 'Tools',
		counts: { items: 0, categories: 0, tags: 0, collections: 0, comparisons: 0 },
		updated_at: '2026-11-20',
		data_repository: null,
		submit_url: `${origin}/submit`,
		endpoints: {
			items: `${origin}/data/items.json`,
			item: `${origin}/data/items/{slug}.json`,
			categories: `${origin}/data/categories.json`,
			tags: `${origin}/data/tags.json`,
			openapi: `${origin}/data/openapi.json`,
			llms: `${origin}/llms.txt`,
			llms_full: `${origin}/llms-full.txt`,
			sitemap: `${origin}/sitemap-index.xml`,
			mcp: mcp ? `${origin}/mcp` : null
		},
		generator: 'ever-works-minimal'
	};
}

const TIME = 'https://timetrack.ever.works';
const CRM = 'https://crm.ever.works';
const MCP = 'https://mcp-servers.ever.works';
const DB = 'https://managed-databases.ever.works';

export const ORIGINS = { TIME, CRM, MCP, DB };

export const ITEMS: Record<string, ItemSummary[]> = {
	[TIME]: [
		item(TIME, 'toggl-track', 'Toggl Track', 'Simple time tracker for teams.', ['Timers'], ['Freelancers'], true),
		item(TIME, 'clockify', 'Clockify', 'Free timesheet app.', ['Timesheets'], ['Free']),
		item(TIME, 'kimai', 'Kimai', 'Open source timesheets, self-hosted.', ['Timesheets'], ['Open source'])
	],
	[CRM]: [
		item(CRM, 'hubspot', 'HubSpot', 'All-in-one CRM suite.', ['Sales CRM'], ['Freemium'], true),
		item(CRM, 'zoho-crm', 'Zoho CRM', 'CRM with built-in time tracking for sales reps.', ['Sales CRM'], [])
	],
	[MCP]: [
		item(MCP, 'postgres-mcp', 'Postgres MCP', 'MCP server for Postgres databases.', ['Databases'], ['Official']),
		item(MCP, 'mysql-mcp', 'MySQL MCP Server', 'Query MySQL from an agent.', ['Databases'], []),
		item(MCP, 'github-mcp', 'GitHub MCP', 'Issues and pull requests for agents.', ['Developer tools'], [], true)
	],
	[DB]: [item(DB, 'neon', 'Neon', 'Serverless Postgres with an MCP server.', ['Postgres'], ['MCP'])]
};

export function registryDocument(): Record<string, unknown> {
	return {
		version: 1,
		name: 'Test directories',
		directories: [
			{ id: 'timetrack', url: TIME, topics: ['time tracking'] },
			{ url: `${CRM}/some/path`, aliases: ['customer relationship management'] },
			{ id: 'mcp-servers', url: MCP },
			{ id: 'managed-databases', url: DB },
			{ id: 'old', url: 'https://old.ever.works', name: 'Old Directory' },
			{ id: 'down', url: 'https://down.ever.works' },
			{ id: 'mismatch', url: 'https://mismatch.ever.works' },
			{ id: 'insecure', url: 'http://insecure.ever.works' },
			{ id: 'hidden', url: 'https://hidden.ever.works', listed: false },
			{ id: 'timetrack', url: 'https://duplicate.ever.works' }
		]
	};
}

export interface FakeNetwork {
	fetch: FetchFn;
	calls: string[];
	/** Override one URL's response */
	routes: Map<string, () => Response | Promise<Response>>;
	upstreamBodies: unknown[];
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/**
 * A fake network serving the fixture directories.
 */
export function fakeNetwork(): FakeNetwork {
	const calls: string[] = [];
	const upstreamBodies: unknown[] = [];
	const routes = new Map<string, () => Response | Promise<Response>>();
	const infos: Record<string, DirectoryInfo> = {
		[TIME]: directoryInfo(TIME, 'Awesome Time Tracking', 'A curated list of time tracking software.'),
		[CRM]: directoryInfo(CRM, 'Awesome CRM', 'A curated directory of CRM software.', false),
		[MCP]: directoryInfo(MCP, 'Awesome MCP Servers', 'A curated list of Model Context Protocol servers.'),
		[DB]: directoryInfo(DB, 'Awesome Managed Databases', 'Hosted databases and serverless data platforms.')
	};
	for (const [origin, info] of Object.entries(infos)) {
		info.counts.items = ITEMS[origin]?.length ?? 0;
		routes.set(`${origin}/data/directory.json`, () => jsonResponse(info));
		routes.set(`${origin}/data/items.json`, () =>
			jsonResponse({ version: 1, total: ITEMS[origin]?.length ?? 0, items: ITEMS[origin] ?? [] })
		);
		for (const entry of ITEMS[origin] ?? []) {
			routes.set(`${origin}/data/items/${entry.slug}.json`, () =>
				jsonResponse({
					...entry,
					markdown: `# ${entry.name}`,
					markdown_url: `${entry.url}.md`,
					images: [],
					brand: null,
					publisher: null,
					related: []
				})
			);
		}
		routes.set(`${origin}/data/categories.json`, () =>
			jsonResponse({ version: 1, total: 1, categories: [{ id: 'sales-crm', name: 'Sales CRM', count: 2 }] })
		);
		routes.set(`${origin}/data/tags.json`, () =>
			jsonResponse({
				version: 1,
				total: 2,
				tags: [
					{ id: 'freemium', name: 'Freemium', count: 1 },
					{ id: 'x', name: 'X', count: 1 }
				]
			})
		);
	}
	routes.set(REGISTRY_URL, () => jsonResponse(registryDocument()));
	routes.set(
		'https://old.ever.works/data/directory.json',
		() => new Response('<html>Not found</html>', { status: 404 })
	);
	routes.set('https://down.ever.works/data/directory.json', () => {
		throw new TypeError('fetch failed');
	});
	routes.set('https://mismatch.ever.works/data/directory.json', () =>
		jsonResponse(directoryInfo('https://somewhere-else.example.com', 'Mismatch', 'Wrong origin'))
	);
	routes.set(`${MCP}/mcp`, () =>
		jsonResponse({
			jsonrpc: '2.0',
			id: 1,
			result: {
				content: [{ type: 'text', text: '{"total":1}' }],
				structuredContent: { total: 1, categories: [{ id: 'databases', name: 'Databases', count: 2 }] }
			}
		})
	);

	const fetch: FetchFn = async (input, init) => {
		calls.push(input);
		if (init?.method === 'POST' && typeof init.body === 'string') upstreamBodies.push(JSON.parse(init.body));
		const route = routes.get(input);
		if (!route) return new Response('not found', { status: 404 });
		return route();
	};
	return { fetch, calls, routes, upstreamBodies };
}

export function loaderFor(network: FakeNetwork, now: () => number = () => 1_000_000): DirectoryLoader {
	return new DirectoryLoader({ registryUrl: REGISTRY_URL, fetch: network.fetch, now, timeoutMs: 1000 });
}
