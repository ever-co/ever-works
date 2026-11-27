/**
 * Route-served directories (plan §7).
 *
 * A directory Worker on a Workers **route**, rather than a Workers Custom Domain, cannot be reached by a same-zone
 * `fetch()`. The subrequest skips route Workers and goes to the zone's placeholder origin, which answers Cloudflare
 * 522. The ever.works zone is at Cloudflare's limit of 100 Custom Domains, so directories past it are route-served
 * (`rmm.ever.works` first, 2026-11-22). The hub reaches each of them through a service binding to its Worker: a direct
 * Worker-to-Worker call, without the zone's front door.
 *
 * Configuration (`wrangler.jsonc`): one `services` binding per route-served Worker, plus the `ROUTE_SERVED` var that
 * maps each host to its binding name, e.g. `{ "rmm.ever.works": "DIR_RMM" }`. Every other host is fetched as before.
 */

import type { FetchFn } from './loader';

/** A service binding as workerd passes it in `env`. */
export interface ServiceBinding {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

function isServiceBinding(value: unknown): value is ServiceBinding {
	return value !== null && typeof value === 'object' && typeof (value as { fetch?: unknown }).fetch === 'function';
}

/**
 * The route-served hosts and their bindings. Entries whose binding is missing are left out, so those hosts are fetched
 * normally (and then show as unavailable with their real reason).
 *
 * @param env - The Worker's `env`
 */
export function routeServedHosts(env: Record<string, unknown>): Map<string, ServiceBinding> {
	const hosts = new Map<string, ServiceBinding>();
	const map = env['ROUTE_SERVED'];
	if (map === null || typeof map !== 'object' || Array.isArray(map)) return hosts;
	for (const [host, name] of Object.entries(map as Record<string, unknown>)) {
		const binding = typeof name === 'string' ? env[name] : undefined;
		if (isServiceBinding(binding)) hosts.set(host.trim().toLowerCase(), binding);
	}
	return hosts;
}

/**
 * A fetch that sends requests for route-served hosts through their service binding and everything else to `fallback`.
 * The `cf` cache options apply to zone fetches only, so they are not passed to a binding.
 *
 * @param env - The Worker's `env`
 * @param fallback - The normal fetch
 */
export function routeServedFetch(env: Record<string, unknown>, fallback: FetchFn): FetchFn {
	const hosts = routeServedHosts(env);
	if (hosts.size === 0) return fallback;
	return (input, init) => {
		let host: string;
		try {
			host = new URL(input).host;
		} catch {
			return fallback(input, init);
		}
		const binding = hosts.get(host);
		if (!binding) return fallback(input, init);
		const forwarded: RequestInit = {};
		if (init?.method !== undefined) forwarded.method = init.method;
		if (init?.headers !== undefined) forwarded.headers = init.headers;
		if (init?.body !== undefined) forwarded.body = init.body;
		if (init?.signal !== undefined) forwarded.signal = init.signal;
		if (init?.redirect !== undefined) forwarded.redirect = init.redirect;
		return binding.fetch(input, forwarded);
	};
}
