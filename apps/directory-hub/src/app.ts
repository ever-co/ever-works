/**
 * Ever Works directory hub — request router (everything except the Worker entry, which lives in `worker.ts`).
 *
 * One public, read-only MCP server and JSON API across every Ever Works directory
 * (`docs/specs/features/directory-hub/spec.md`). Routes:
 *
 * | Path                          | What                                                     |
 * | ----------------------------- | -------------------------------------------------------- |
 * | `POST /mcp`                   | MCP (Streamable HTTP, stateless)                         |
 * | `GET /data/search.json`       | `search_all` as REST                                     |
 * | `GET /data/directories.json`  | Every directory with live metadata                       |
 * | `GET /data/openapi.json`      | OpenAPI 3.1                                              |
 * | `GET /.well-known/mcp.json`   | MCP server card                                          |
 * | `GET /.well-known/api-catalog`| RFC 9727 API catalog                                     |
 * | `GET /llms.txt`               | llmstxt.org index with every directory                   |
 * | `GET /robots.txt`             | Allow all                                                |
 * | `GET /`                       | Redirect to `/llms.txt`                                  |
 */

import { buildApiCatalog, buildLlmsTxt, buildOpenApi, buildServerCard } from './discovery';
import { DirectoryLoader } from './loader';
import { CORS_HEADERS, handleMcpRequest } from './mcp';
import { ToolInputError, runSearchAll, summarizeDirectory } from './tools';

/** Hub version, reported in `serverInfo`, the MCP card and OpenAPI. */
export const HUB_VERSION = '1.0.0';

/** Worker bindings (`wrangler.jsonc` `vars`). */
export interface Env {
	/** URL of the Directory Registry document (spec FR-1) */
	REGISTRY_URL: string;
	/** Public origin of the hub; defaults to the request's origin */
	HUB_URL?: string;
}

export interface HandlerOptions {
	loader: DirectoryLoader;
	hubUrl: string;
	log?: (entry: Record<string, unknown>) => void;
}

const PUBLIC_CACHE = 'public, max-age=300, s-maxage=900';

function respond(body: string, contentType: string, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': contentType, 'Cache-Control': PUBLIC_CACHE, ...CORS_HEADERS, ...extra }
	});
}

export function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
	return respond(JSON.stringify(body), contentType, status, status === 200 ? {} : { 'Cache-Control': 'no-store' });
}

/**
 * Route one request. Exported so tests can drive the Worker without a runtime.
 *
 * @param request - Incoming request
 * @param options - Loader, public origin and logger
 */
export async function handleRequest(request: Request, options: HandlerOptions): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, '') || '/';
	const { loader, hubUrl } = options;

	if (path === '/mcp') {
		return handleMcpRequest(request, { loader, hubUrl, version: HUB_VERSION, log: options.log });
	}
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonResponse({ error: 'Method not allowed' }, 405);
	}

	try {
		switch (path) {
			case '/':
				return new Response(null, { status: 302, headers: { Location: '/llms.txt', ...CORS_HEADERS } });
			case '/robots.txt':
				return respond(`User-agent: *\nAllow: /\n`, 'text/plain; charset=utf-8');
			case '/llms.txt': {
				const set = await loader.getDirectories();
				return respond(
					buildLlmsTxt(hubUrl, set.available, set.unavailable.length),
					'text/plain; charset=utf-8'
				);
			}
			case '/.well-known/mcp.json':
				return jsonResponse(buildServerCard(hubUrl, HUB_VERSION));
			case '/.well-known/api-catalog': {
				const set = await loader.getDirectories();
				return jsonResponse(buildApiCatalog(hubUrl, set.available), 200, 'application/linkset+json');
			}
			case '/data/openapi.json':
				return jsonResponse(buildOpenApi(hubUrl, HUB_VERSION));
			case '/data/directories.json': {
				const set = await loader.getDirectories();
				const directories = set.available.map(summarizeDirectory).sort((a, b) => a.name.localeCompare(b.name));
				return jsonResponse({
					version: 1,
					name: set.registry.name,
					total: directories.length,
					directories,
					unavailable: set.unavailable
				});
			}
			case '/data/search.json': {
				const params = url.searchParams;
				const input: Record<string, unknown> = { query: params.get('q') ?? params.get('query') ?? '' };
				for (const key of ['directories', 'category', 'tag', 'limit', 'per_directory']) {
					const value = params.get(key);
					if (value !== null) input[key] = value;
				}
				const started = Date.now();
				try {
					const result = await runSearchAll(loader, input);
					options.log?.({ event: 'rest', path, ms: Date.now() - started, ok: true });
					return jsonResponse(result);
				} catch (error) {
					if (error instanceof ToolInputError) return jsonResponse({ error: error.message }, 400);
					throw error;
				}
			}
			default:
				return jsonResponse({ error: 'Not found', documentation: `${hubUrl}/llms.txt` }, 404);
		}
	} catch {
		// Generic message: loader errors can carry upstream URLs.
		return jsonResponse({ error: 'The directory registry could not be loaded. Try again shortly.' }, 503);
	}
}
