/**
 * Discovery documents (spec FR-18): `llms.txt`, the MCP server card, the RFC 9727 API catalog and OpenAPI 3.1.
 * Same shapes as a directory's own documents, so an agent that knows one Ever Works directory knows the hub.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from './contract';
import type { LoadedDirectory } from './loader';
import { HUB_TOOL_NAMES } from './tools';

export const HUB_TITLE = 'Ever Works directories';
export const HUB_DESCRIPTION =
	'One entry point to every Ever Works directory: curated lists of software, services and tools by topic. Search all of them at once, list them, or query one.';

/**
 * `llms.txt` (llmstxt.org) for the hub, with a link to every available directory.
 *
 * @param hubUrl - Public origin of the hub
 * @param directories - Available directories
 * @param unavailableCount - Directories that cannot be read right now
 */
export function buildLlmsTxt(
	hubUrl: string,
	directories: readonly LoadedDirectory[],
	unavailableCount: number
): string {
	const lines = [
		`# ${HUB_TITLE}`,
		'',
		`> ${HUB_DESCRIPTION}`,
		'',
		'Read-only, public, no account or API key. CORS is open. Our logs keep the text of a search that matches nothing, to learn which directories are missing; they hold no IP address or other detail about the caller.',
		'',
		'## How to query',
		'',
		`- [MCP server](${hubUrl}/mcp): Streamable HTTP, stateless. Tools: ${HUB_TOOL_NAMES.join(', ')}. Add it to an agent, e.g. \`claude mcp add --transport http ever-works ${hubUrl}/mcp\`.`,
		`- [Search API](${hubUrl}/data/search.json?q=time%20tracking): \`GET /data/search.json?q=…\` with optional \`directories\`, \`category\`, \`tag\`, \`limit\`, \`per_directory\`; same result as the search_all tool.`,
		`- [Directory list](${hubUrl}/data/directories.json): every directory with its item count, MCP URL and llms.txt.`,
		`- [OpenAPI](${hubUrl}/data/openapi.json): OpenAPI 3.1 description of the endpoints above.`,
		`- [MCP server card](${hubUrl}/.well-known/mcp.json) and [API catalog](${hubUrl}/.well-known/api-catalog) (RFC 9727).`,
		'',
		'Each directory also has its own read API (`/data/*.json`), MCP server (`/mcp`) and `llms.txt`; the hub links them below.',
		'',
		`## Directories (${directories.length})`,
		''
	];
	for (const directory of [...directories].sort((a, b) => a.info.name.localeCompare(b.info.name))) {
		const { info } = directory;
		const description = info.description.replace(/\s+/g, ' ').trim();
		lines.push(
			`- [${info.name}](${info.endpoints.llms}): ${description ? `${description} ` : ''}${info.counts.items} ${info.items_name.toLowerCase()}. MCP: ${info.endpoints.mcp ?? 'none'}`
		);
	}
	if (unavailableCount > 0) {
		lines.push(
			'',
			`${unavailableCount} more directories are being updated and will appear here once they publish the agent API.`
		);
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * MCP server card for `/.well-known/mcp.json` (same shape as a directory's card).
 *
 * @param hubUrl - Public origin of the hub
 * @param version - Hub version
 */
export function buildServerCard(hubUrl: string, version: string): Record<string, unknown> {
	return {
		name: 'ever-works-directory-hub',
		title: HUB_TITLE,
		description: HUB_DESCRIPTION,
		version,
		url: `${hubUrl}/mcp`,
		transport: 'streamable-http',
		protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
		authentication: 'none',
		tools: [...HUB_TOOL_NAMES],
		documentation: `${hubUrl}/llms.txt`,
		openapi: `${hubUrl}/data/openapi.json`
	};
}

/**
 * RFC 9727 API catalog: the hub's API plus every available directory's read API.
 *
 * @param hubUrl - Public origin of the hub
 * @param directories - Available directories
 */
export function buildApiCatalog(hubUrl: string, directories: readonly LoadedDirectory[]): Record<string, unknown> {
	return {
		linkset: [
			{
				anchor: `${hubUrl}/data/`,
				'service-desc': [{ href: `${hubUrl}/data/openapi.json`, type: 'application/openapi+json' }],
				'service-doc': [{ href: `${hubUrl}/llms.txt`, type: 'text/plain' }]
			},
			...directories.map((directory) => ({
				anchor: `${directory.info.url}/data/`,
				'service-desc': [{ href: directory.info.endpoints.openapi, type: 'application/openapi+json' }],
				'service-doc': [{ href: directory.info.endpoints.llms, type: 'text/plain' }]
			}))
		]
	};
}

const hubItemSchema = {
	type: 'object',
	required: ['slug', 'name', 'description', 'url', 'directory'],
	properties: {
		slug: { type: 'string' },
		name: { type: 'string' },
		description: { type: 'string' },
		url: { type: 'string', format: 'uri', description: 'Item page on its directory; cite this' },
		website: { type: ['string', 'null'], format: 'uri', description: "The item's own website" },
		categories: { type: 'array', items: { type: 'string' } },
		tags: { type: 'array', items: { type: 'string' } },
		featured: { type: 'boolean' },
		logo: { type: ['string', 'null'] },
		updated_at: { type: ['string', 'null'] },
		score: { type: 'number' },
		directory: {
			type: 'object',
			required: ['id', 'name', 'url'],
			properties: { id: { type: 'string' }, name: { type: 'string' }, url: { type: 'string', format: 'uri' } }
		}
	}
} as const;

const directorySummarySchema = {
	type: 'object',
	required: ['id', 'name', 'description', 'url', 'items'],
	properties: {
		id: { type: 'string' },
		name: { type: 'string' },
		description: { type: 'string' },
		url: { type: 'string', format: 'uri' },
		mcp: { type: ['string', 'null'], format: 'uri' },
		llms: { type: 'string', format: 'uri' },
		item_name: { type: 'string' },
		items_name: { type: 'string' },
		items: { type: 'integer' },
		categories: { type: 'integer' },
		updated_at: { type: ['string', 'null'] },
		topics: { type: 'array', items: { type: 'string' } },
		stale: { type: 'boolean' }
	}
} as const;

/**
 * OpenAPI 3.1 document for `/data/openapi.json`.
 *
 * @param hubUrl - Public origin of the hub
 * @param version - Hub version
 */
export function buildOpenApi(hubUrl: string, version: string): Record<string, unknown> {
	const query = (name: string, description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
		name,
		in: 'query',
		required: name === 'q',
		description,
		schema
	});
	return {
		openapi: '3.1.0',
		info: {
			title: `${HUB_TITLE} — Hub API`,
			version,
			description: `${HUB_DESCRIPTION}\n\nRead-only, no authentication, CORS enabled. Agent guide: ${hubUrl}/llms.txt`
		},
		servers: [{ url: hubUrl }],
		externalDocs: { description: 'llms.txt', url: `${hubUrl}/llms.txt` },
		paths: {
			'/data/search.json': {
				get: {
					operationId: 'searchAll',
					summary: 'Search the items of every directory at once',
					parameters: [
						query('q', 'What to look for, e.g. "time tracking tools".'),
						query('directories', 'Comma-separated directory ids to search instead of all.'),
						query('category', 'Category id, name or slug.'),
						query('tag', 'Tag id, name or slug.'),
						query('limit', 'Maximum results (1-50, default 20).', {
							type: 'integer',
							minimum: 1,
							maximum: 50
						}),
						query('per_directory', 'Maximum results per directory (1-50, default 10).', {
							type: 'integer',
							minimum: 1,
							maximum: 50
						})
					],
					responses: {
						'200': {
							description: 'Ranked results',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											query: { type: 'string' },
											total: { type: 'integer' },
											directories_searched: { type: 'integer' },
											items: { type: 'array', items: hubItemSchema },
											unavailable: { type: 'array', items: { type: 'string' } },
											hint: { type: 'string' }
										}
									}
								}
							}
						},
						'400': { description: 'Missing or invalid parameters' }
					}
				}
			},
			'/data/directories.json': {
				get: {
					operationId: 'listDirectories',
					summary: 'Every directory with its metadata and endpoints',
					responses: {
						'200': {
							description: 'Directories',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											version: { type: 'integer', const: 1 },
											total: { type: 'integer' },
											directories: { type: 'array', items: directorySummarySchema },
											unavailable: { type: 'array', items: { type: 'object' } }
										}
									}
								}
							}
						}
					}
				}
			},
			'/mcp': {
				post: {
					operationId: 'mcp',
					summary: 'Model Context Protocol endpoint (Streamable HTTP, JSON-RPC 2.0)',
					description: `Tools: ${HUB_TOOL_NAMES.join(', ')}. Protocol versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
					responses: {
						'200': {
							description: 'JSON-RPC response',
							content: { 'application/json': { schema: { type: 'object' } } }
						},
						'202': { description: 'Notification accepted' }
					}
				}
			}
		}
	};
}
