/**
 * MCP Streamable HTTP transport for the hub: stateless, one JSON response per request, the same rules as Agent Access
 * Contract v1 (spec FR-7).
 *
 * - `POST` JSON-RPC 2.0; `GET` → `405`; `OPTIONS` → `204`; CORS `*` on every response.
 * - `initialize` negotiates the protocol version; notifications and client responses → `202` with no body.
 * - `MCP-Protocol-Version` with an unsupported value → `400`; batches → `-32600`; `null` ids → `-32600`.
 * - Internal errors use a generic message: loader errors could carry upstream URLs.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from './contract';
import type { DirectoryLoader } from './loader';
import {
	HUB_TOOL_NAMES,
	ToolInputError,
	callHubTool,
	hubInstructions,
	hubToolDefinitions,
	type HubToolName
} from './tools';

type JsonRpcId = string | number | null;

export const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers':
		'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
	'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
	'Access-Control-Max-Age': '86400'
};

export interface McpOptions {
	loader: DirectoryLoader;
	/** Version reported in `serverInfo` */
	version: string;
	/** Public origin of the hub, e.g. `https://directories.ever.works` */
	hubUrl: string;
	/** One structured line per tool call (spec NFR observability) */
	log?: (entry: Record<string, unknown>) => void;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS, ...extra }
	});
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
	return json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
	return json({ jsonrpc: '2.0', id, error: { code, message } }, status);
}

function negotiateVersion(requested: unknown): string {
	return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
		? requested
		: SUPPORTED_PROTOCOL_VERSIONS[0];
}

function params(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Handle one HTTP request to `/mcp`.
 *
 * @param request - Incoming request, any method
 * @param options - Loader, version, public URL and logger
 */
export async function handleMcpRequest(request: Request, options: McpOptions): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
	if (request.method !== 'POST') {
		return json(
			{
				jsonrpc: '2.0',
				id: null,
				error: { code: -32000, message: 'Method not allowed. POST JSON-RPC messages to this endpoint.' }
			},
			405,
			{ Allow: 'POST, OPTIONS' }
		);
	}

	let message: unknown;
	try {
		message = await request.json();
	} catch {
		return rpcError(null, -32700, 'Parse error: body must be a JSON-RPC 2.0 message', 400);
	}

	const protocolHeader = request.headers.get('MCP-Protocol-Version');
	if (protocolHeader && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolHeader)) {
		return rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${protocolHeader.slice(0, 40)}`, 400);
	}
	if (Array.isArray(message)) return rpcError(null, -32600, 'Batch requests are not supported', 400);
	if (message === null || typeof message !== 'object') return rpcError(null, -32600, 'Invalid request', 400);

	const rpc = message as Record<string, unknown>;
	const hasId = typeof rpc['id'] === 'string' || typeof rpc['id'] === 'number';
	const id: JsonRpcId = hasId ? (rpc['id'] as string | number) : null;

	if (rpc['jsonrpc'] !== '2.0') return rpcError(id, -32600, 'Invalid request: jsonrpc must be "2.0"', 400);
	if (typeof rpc['method'] !== 'string') {
		if ('result' in rpc || 'error' in rpc) return new Response(null, { status: 202, headers: CORS_HEADERS });
		return rpcError(id, -32600, 'Invalid request: missing method', 400);
	}
	if ('id' in rpc && !hasId) return rpcError(null, -32600, 'Invalid request: id must be a string or number', 400);
	if (!hasId) return new Response(null, { status: 202, headers: CORS_HEADERS });

	const method = rpc['method'];
	const input = params(rpc['params']);

	try {
		switch (method) {
			case 'initialize': {
				let count = 0;
				try {
					count = (await options.loader.getRegistry()).entries.length;
				} catch {
					// The registry is not needed to initialize; the count is only informative.
				}
				return rpcResult(id, {
					protocolVersion: negotiateVersion(input['protocolVersion']),
					capabilities: { tools: { listChanged: false } },
					serverInfo: {
						name: 'ever-works-directory-hub',
						title: 'Ever Works directories',
						version: options.version,
						websiteUrl: options.hubUrl
					},
					instructions: hubInstructions(count)
				});
			}
			case 'ping':
				return rpcResult(id, {});
			case 'tools/list':
				return rpcResult(id, { tools: hubToolDefinitions() });
			case 'tools/call': {
				const name = input['name'];
				if (typeof name !== 'string' || !(HUB_TOOL_NAMES as readonly string[]).includes(name)) {
					return rpcError(id, -32602, `Unknown tool: ${String(name).slice(0, 100)}`);
				}
				const started = Date.now();
				try {
					const outcome = await callHubTool(name as HubToolName, input['arguments'], options.loader);
					options.log?.({ event: 'tool', tool: name, ms: Date.now() - started, ok: true });
					if (outcome.kind === 'passthrough') return rpcResult(id, outcome.result);
					return rpcResult(id, {
						content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
						structuredContent: outcome.value
					});
				} catch (error) {
					if (error instanceof ToolInputError) {
						options.log?.({ event: 'tool', tool: name, ms: Date.now() - started, ok: false });
						return rpcResult(id, { content: [{ type: 'text', text: error.message }], isError: true });
					}
					throw error;
				}
			}
			case 'resources/list':
				return rpcResult(id, { resources: [] });
			case 'prompts/list':
				return rpcResult(id, { prompts: [] });
			default:
				return rpcError(id, -32601, `Method not found: ${method.slice(0, 100)}`);
		}
	} catch {
		return rpcError(id, -32603, 'Internal error: the directory data could not be loaded');
	}
}
