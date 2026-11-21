import type { FetchLike, FetchRequestInit } from '../fleet-client';
import { createLogger, type LogEntry, type Logger } from '../logger';

/**
 * Test kit for the local-AI specs: a routing fake `fetch` and a capturing
 * logger. Not used by production code.
 */

export interface FakeRoute {
	status?: number;
	body?: unknown;
	/** Raw text instead of JSON. */
	text?: string;
	/** Reject like a transport failure, with this `cause.code`. */
	networkError?: string;
	/** Never answer (until the request is aborted). */
	hang?: boolean;
}

export interface FakeFetch {
	fetchFn: FetchLike;
	calls: Array<{ url: string; init: FetchRequestInit }>;
}

/** A fake fetch answering by exact URL (`METHOD url` keys win over plain `url` keys); unknown URLs 404. */
export function fakeFetch(routes: Record<string, FakeRoute | ((init: FetchRequestInit) => FakeRoute)>): FakeFetch {
	const calls: FakeFetch['calls'] = [];
	const fetchFn: FetchLike = async (url, init) => {
		calls.push({ url, init });
		const entry = routes[`${init.method} ${url}`] ?? routes[url];
		const route: FakeRoute =
			typeof entry === 'function' ? entry(init) : (entry ?? { status: 404, text: 'not found' });
		if (route.hang) {
			await new Promise<never>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () =>
					reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
				);
			});
		}
		if (route.networkError) {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code: route.networkError } });
		}
		const status = route.status ?? 200;
		const text = route.text ?? JSON.stringify(route.body ?? {});
		return { ok: status >= 200 && status < 300, status, text: async () => text };
	};
	return { fetchFn, calls };
}

/** A real redacting logger whose output is kept in memory. */
export function capturingLogger(): { logger: Logger; entries: LogEntry[]; text: () => string } {
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	return { logger, entries, text: () => entries.map((entry) => entry.message).join('\n') };
}
