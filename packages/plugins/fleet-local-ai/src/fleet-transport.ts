import { fleetAiWireApiForPath, type FleetAiCompletionFailure } from '@ever-works/contracts';
import type { AiProviderFetch, LocalAiRelayServiceRef } from '@ever-works/plugin';
import { SSE_SYNTHESISERS } from './sse';

/**
 * The fleet local AI TRANSPORT: a `fetch` an OpenAI-compatible client (the AI
 * SDK's, LangChain's OpenAI client) is configured with, that carries each
 * request to the caller's own machines through the platform's local AI relay
 * — and nowhere else.
 *
 * The client is pointed at a placeholder origin ({@link FLEET_LOCAL_AI_BASE_URL},
 * `.invalid` by RFC 6761: it can never resolve, so a client that ignored the
 * transport fails instead of reaching anything) and keeps doing everything it
 * normally does: tools, JSON mode, structured output, retries. The transport:
 *
 *   - answers `GET …/models` from the models the caller's nodes advertise;
 *   - turns `POST …/chat/completions` (`…/responses`, `…/messages`) into ONE
 *     relay request and answers with the provider's own status and body;
 *   - for a request that asked to stream, asks the node for the whole answer
 *     and answers with the event stream rebuilt from it (`sse.ts`);
 *   - maps a relay failure to the HTTP status a client already knows how to
 *     treat (503 no node / stopped, 504 timeout, 413 too large, 400 refused,
 *     502 node failure) with an OpenAI-shaped error body, and a cancel to the
 *     `AbortError` a fetch rejects with.
 *
 * It never logs a prompt or an answer, and it never calls the network.
 */

/** The placeholder origin clients are pointed at. Never resolvable. */
export const FLEET_LOCAL_AI_ORIGIN = 'https://fleet-local-ai.invalid';
export const FLEET_LOCAL_AI_BASE_URL = `${FLEET_LOCAL_AI_ORIGIN}/v1`;
/** The token clients are configured with. Not a secret: the transport never sends it anywhere. */
export const FLEET_LOCAL_AI_API_KEY = 'fleet-local-ai';

export interface FleetLocalAiFetchOptions {
	/** The platform's relay (`PluginContext.services.localAi`); absent where the process cannot reach the fleet. */
	relay: LocalAiRelayServiceRef | undefined;
	/** Whose machines. */
	scope: { userId?: string; workId?: string };
	/** The whole wait for one answer, queueing included. */
	timeoutMs: number;
}

const FAILURE_STATUS: Readonly<Record<FleetAiCompletionFailure, number>> = {
	'no-node': 503,
	stopped: 503,
	'invalid-request': 400,
	'too-large': 413,
	timeout: 504,
	cancelled: 499,
	failed: 502
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function errorResponse(status: number, code: string, message: string): Response {
	return json(status, { error: { message, type: 'fleet_local_ai_error', code } });
}

function abortError(): Error {
	const error = new Error('The operation was aborted.');
	error.name = 'AbortError';
	return error;
}

async function readBody(input: string | URL | Request, init: RequestInit | undefined): Promise<string | null> {
	const body = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
	if (body === null || body === undefined) return null;
	if (typeof body === 'string') return body;
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBufferView);
	if (body instanceof Blob) return body.text();
	if (body instanceof URLSearchParams) return body.toString();
	// A stream or form body: read it the way a server would.
	return new Response(body as BodyInit).text();
}

/** The `fetch` that carries an OpenAI-compatible client's requests to the caller's machines. */
export function createFleetLocalAiFetch(options: FleetLocalAiFetchOptions): AiProviderFetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== FLEET_LOCAL_AI_ORIGIN) {
			// Never a network call: this transport only understands its own origin.
			throw new TypeError(`The fleet local AI transport does not send requests to ${url.origin}`);
		}
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
		if (signal?.aborted) throw abortError();
		const relay = options.relay;
		const userId = options.scope.userId;
		if (!relay) {
			return errorResponse(
				503,
				'unavailable',
				'This process cannot reach your computers (the platform did not provide the local AI relay)'
			);
		}
		if (!userId) {
			return errorResponse(400, 'invalid-request', 'A local AI request needs the user it is made for');
		}

		if (method === 'GET' && url.pathname.replace(/\/+$/, '').endsWith('/models')) {
			const models = await relay.listModels({ userId });
			return json(200, {
				object: 'list',
				data: models.map((model) => ({
					id: model.id,
					object: 'model',
					owned_by: 'fleet-local-ai',
					nodes: model.nodes
				}))
			});
		}

		const api = method === 'POST' ? fleetAiWireApiForPath(url.pathname) : null;
		if (!api) {
			return errorResponse(404, 'not-found', `The fleet local AI transport serves no ${method} ${url.pathname}`);
		}
		const text = await readBody(input, init);
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			return errorResponse(400, 'invalid-request', 'The request body is not JSON');
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return errorResponse(400, 'invalid-request', 'The request body is not a JSON object');
		}
		const request = body as Record<string, unknown>;
		if (typeof request.model !== 'string' || !request.model) {
			return errorResponse(400, 'invalid-request', 'The request names no model');
		}
		const stream = request.stream === true;
		const synthesise = SSE_SYNTHESISERS[api];
		if (stream && !synthesise) {
			return errorResponse(
				400,
				'invalid-request',
				`Streaming is not available for ${api} over local AI on your computers — send the request without "stream"`
			);
		}

		const outcome = await relay.complete({
			userId,
			...(options.scope.workId ? { workId: options.scope.workId } : {}),
			api,
			model: request.model,
			body: request,
			timeoutMs: options.timeoutMs,
			...(signal ? { signal } : {})
		});
		if (outcome.ok === false) {
			if (outcome.code === 'cancelled' || signal?.aborted) throw abortError();
			return errorResponse(FAILURE_STATUS[outcome.code] ?? 502, outcome.code, outcome.message);
		}
		const headers = { 'x-fleet-local-ai-provider': outcome.providerKind, 'x-fleet-local-ai-model': outcome.model };
		if (stream && synthesise && outcome.status >= 200 && outcome.status < 300) {
			return new Response(synthesise(outcome.body), {
				status: outcome.status,
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers }
			});
		}
		return json(outcome.status, outcome.body, headers);
	};
}
