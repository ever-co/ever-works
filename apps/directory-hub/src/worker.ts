/**
 * Ever Works directory hub — Cloudflare Worker entry.
 *
 * Only the default export lives here: workerd treats every named export of the entry module as an entrypoint, so the
 * router, its types and constants are in `app.ts`.
 */

import { handleRequest, jsonResponse, type Env } from './app';
import { DirectoryLoader } from './loader';
import { routeServedFetch } from './routing';

let isolateLoader: { key: string; loader: DirectoryLoader } | undefined;

function loaderFor(env: Env): DirectoryLoader {
	// One loader per isolate, so the in-memory cache survives between requests.
	if (!isolateLoader || isolateLoader.key !== env.REGISTRY_URL) {
		// Route-served directories go through their service binding; see routing.ts.
		const fetchFn = routeServedFetch(env, (input, init) => fetch(input, init));
		isolateLoader = {
			key: env.REGISTRY_URL,
			loader: new DirectoryLoader({ registryUrl: env.REGISTRY_URL, fetch: fetchFn })
		};
	}
	return isolateLoader.loader;
}

/** The part of the Workers `ExecutionContext` the hub uses. */
interface WaitUntilContext {
	waitUntil(promise: Promise<unknown>): void;
}

export default {
	async fetch(request: Request, env: Env, ctx?: WaitUntilContext): Promise<Response> {
		if (!env.REGISTRY_URL) return jsonResponse({ error: 'The hub is not configured (REGISTRY_URL).' }, 503);
		const hubUrl = (env.HUB_URL || new URL(request.url).origin).replace(/\/+$/, '');
		const loader = loaderFor(env);
		// Shared loads outlive the request that started them (a client hanging up must not fail the others).
		if (ctx) loader.keepAlive = (promise) => ctx.waitUntil(promise);
		return handleRequest(request, {
			loader,
			hubUrl,
			log: (entry) => console.log(JSON.stringify(entry))
		});
	}
};
