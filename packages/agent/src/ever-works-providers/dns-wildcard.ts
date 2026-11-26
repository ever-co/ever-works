/**
 * `EVER_WORKS_DNS_WILDCARD=true` declares that the platform zone already answers every name that has no record of its
 * own: a proxied `*.<EVER_WORKS_DOMAIN>` record, plus the matching tunnel/ingress rule, routes it to the managed target.
 * The platform zone's provider then creates no new per-Work record (the zone has a record quota; Cloudflare Free allows
 * 200). Every conflict check still runs, so a name another host holds (a platform host, or a directory's Workers
 * `AAAA 100::` record) is still refused, and records that already exist are still kept in sync.
 *
 * Off unless the value is exactly `true` (case and surrounding spaces ignored), like `K8S_MANAGED_SUBDOMAIN`.
 */
export const DNS_WILDCARD_ENV_VAR = 'EVER_WORKS_DNS_WILDCARD';

export function isDnsWildcardEnabled(
    env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
    return (env[DNS_WILDCARD_ENV_VAR] ?? '').trim().toLowerCase() === 'true';
}
