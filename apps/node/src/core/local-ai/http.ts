import type { FetchLike } from '../fleet-client';

/**
 * The ONE way local-AI code talks HTTP: bounded in time and in size, and
 * incapable of putting the key anywhere but the provider's own request.
 *
 * Errors carry a short, fixed-shape reason (`HTTP 401 from /v1/models`,
 * `timed out after 5 s`, `connection refused`) — never a response body, which
 * a misconfigured proxy could fill with anything, and never a header.
 */

/** Largest response body a probe or a test reads (a model list of a few hundred entries is far below it). */
export const LOCAL_AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type LocalAiHttpFailure = 'timeout' | 'network' | 'http' | 'body' | 'aborted';

export class LocalAiHttpError extends Error {
	readonly failure: LocalAiHttpFailure;
	readonly status: number | null;

	constructor(failure: LocalAiHttpFailure, message: string, status: number | null = null) {
		super(message);
		this.name = 'LocalAiHttpError';
		this.failure = failure;
		this.status = status;
	}
}

export interface LocalAiRequest {
	method: 'GET' | 'POST';
	/** Absolute URL. Built by the caller from validated settings. */
	url: string;
	/** The path as shown in error messages (`/v1/models`) — never the whole URL. */
	label: string;
	headers?: Record<string, string>;
	/** JSON body for a POST. */
	body?: unknown;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Authorization header for a provider key, or none for a keyless server. */
export function bearerHeaders(apiKey: string | null): Record<string, string> {
	return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Send one request and parse a 2xx JSON answer.
 *
 * Throws {@link LocalAiHttpError} for a timeout, a transport failure, a
 * non-2xx status, an oversized body or a body that is not JSON. The timer is
 * unref'd: a probe can never hold the process open.
 */
export async function localAiRequestJson(
	fetchFn: FetchLike,
	request: LocalAiRequest
): Promise<{ status: number; json: unknown }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs));
	(timer as { unref?: () => void }).unref?.();
	const onOuterAbort = (): void => controller.abort();
	if (request.signal) {
		if (request.signal.aborted) controller.abort();
		else request.signal.addEventListener('abort', onOuterAbort, { once: true });
	}
	const outerAborted = (): boolean => request.signal?.aborted === true;
	try {
		let response: Awaited<ReturnType<FetchLike>>;
		try {
			response = await fetchFn(request.url, {
				method: request.method,
				headers: {
					Accept: 'application/json',
					...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
					...(request.headers ?? {})
				},
				body: request.body !== undefined ? JSON.stringify(request.body) : '',
				signal: controller.signal
			});
		} catch (error) {
			if (outerAborted()) throw new LocalAiHttpError('aborted', `${request.label}: cancelled`);
			if (controller.signal.aborted) {
				throw new LocalAiHttpError(
					'timeout',
					`${request.label}: timed out after ${describeMs(request.timeoutMs)}`
				);
			}
			throw new LocalAiHttpError('network', `${request.label}: ${describeTransportError(error)}`);
		}
		let text: string;
		try {
			text = await response.text();
		} catch {
			if (controller.signal.aborted) {
				throw new LocalAiHttpError(
					'timeout',
					`${request.label}: timed out after ${describeMs(request.timeoutMs)}`
				);
			}
			throw new LocalAiHttpError(
				'body',
				`${request.label}: the response body could not be read`,
				response.status
			);
		}
		if (!response.ok) {
			throw new LocalAiHttpError('http', `${request.label}: HTTP ${response.status}`, response.status);
		}
		if (text.length > LOCAL_AI_MAX_RESPONSE_BYTES) {
			throw new LocalAiHttpError(
				'body',
				`${request.label}: the response is larger than the probe reads`,
				response.status
			);
		}
		try {
			return { status: response.status, json: JSON.parse(text) as unknown };
		} catch {
			throw new LocalAiHttpError('body', `${request.label}: the response is not JSON`, response.status);
		}
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener('abort', onOuterAbort);
	}
}

function describeMs(ms: number): string {
	return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * A transport error as one short phrase. Node's fetch wraps the real reason
 * in `cause` (`ECONNREFUSED`, `ENOTFOUND`, …); only its CODE is read, so a
 * message that happened to echo a header could never reach a log.
 */
function describeTransportError(error: unknown): string {
	const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
	const code =
		(cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined) ??
		(error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined);
	switch (code) {
		case 'ECONNREFUSED':
			return 'connection refused';
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
			return 'host not found';
		case 'EHOSTUNREACH':
		case 'ENETUNREACH':
			return 'host unreachable';
		case 'ECONNRESET':
			return 'connection reset';
		case 'ETIMEDOUT':
		case 'UND_ERR_CONNECT_TIMEOUT':
			return 'connection timed out';
		default:
			return typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code)
				? `network error (${code})`
				: 'network error';
	}
}
