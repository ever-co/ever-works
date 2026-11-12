import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubApiService } from '../github-api.service.js';

/**
 * Against the REAL `octokit` client (no mock) and a local server that never
 * answers: a caller that aborts with an `AbortError`-named reason gets the
 * request cancelled at once, and `plugin-retry` does not retry it.
 *
 * Why the name matters: `@octokit/request` rethrows only `name === 'AbortError'`
 * as is. Any other abort reason (a plain `Error`) comes back as a
 * `RequestError` 500, which `plugin-retry` retries three times (1 s / 4 s /
 * 9 s) — a cancelled ownership check would then still hold its rate-limiter
 * slot for ~14 s. The Work ownership check aborts with
 * `new DOMException(message, 'AbortError')` for exactly this reason.
 */
describe('a cancelled GitHub read stops at once (real Octokit)', () => {
	let server: Server;
	let baseUrl = '';
	let requests = 0;
	let firstRequest: () => void = () => undefined;

	beforeAll(async () => {
		server = createServer(() => {
			requests += 1;
			firstRequest();
			// Never answer.
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it('aborting with an AbortError settles quickly, after one request, without a retry', async () => {
		const controller = new AbortController();
		const arrived = new Promise<void>((resolve) => {
			firstRequest = resolve;
		});

		const call = new GitHubApiService()
			.getRepository('acme', 'app', 'tok', baseUrl, { signal: controller.signal })
			.then(
				() => 'resolved' as const,
				(error: unknown) => error
			);

		// Abort once the request is really in flight at the server.
		await arrived;
		const abortedAt = Date.now();
		controller.abort(new DOMException('gave up', 'AbortError'));
		const outcome = await call;
		const settledIn = Date.now() - abortedAt;

		expect(outcome).not.toBe('resolved');
		expect((outcome as Error).name).toBe('AbortError');
		// Well under plugin-retry's first 1 s back-off.
		expect(settledIn).toBeLessThan(500);
		// Give a would-be retry the time to arrive, then count.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(requests).toBe(1);
	}, 10_000);
});
