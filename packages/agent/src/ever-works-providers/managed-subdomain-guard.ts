/**
 * Shared rules for the managed subdomains under the platform's root domain (`<label>.ever.works`).
 *
 * Dependency-free on purpose: `SubdomainAllocator` (automatic allocation), the Cloudflare DNS
 * provider and `ManagedSubdomainService` (explicit rename in the API) all read the same list, and
 * API unit tests can load this file without the rest of the providers barrel.
 */

/**
 * Platform services that also run per environment, as `<name>-dev` / `<name>-stage` and the
 * dashless `<name>dev` / `<name>stage`. Each base name and every variant is reserved.
 */
const PLATFORM_SERVICE_LABELS = [
    'www',
    'api',
    'app',
    'admin',
    'auth',
    'docs',
    'mcp',
    'status',
    'platform',
    'dashboard',
] as const;

/** Per-environment suffixes the platform's own hosts use. */
const ENVIRONMENT_SUFFIXES = ['-dev', '-stage', 'dev', 'stage'] as const;

/** Infrastructure names that have no per-environment copies. */
const INFRASTRUCTURE_LABELS = [
    'mail',
    'cdn',
    'static',
    'root',
    'mx',
    'ns',
    'ns1',
    'ns2',
    'lb',
] as const;

/**
 * Labels a tenant can never claim, whether through `SubdomainAllocator` or an explicit
 * `PUT /api/deploy/works/:id/subdomain`. The zone probe (`recordExists`) already refuses any
 * hostname that exists; this list also keeps the platform's names while no record exists for
 * them (a host being moved, an environment not created yet).
 */
export const RESERVED_SUBDOMAIN_LABELS: ReadonlySet<string> = new Set<string>([
    ...PLATFORM_SERVICE_LABELS,
    ...PLATFORM_SERVICE_LABELS.flatMap((name) =>
        ENVIRONMENT_SUFFIXES.map((suffix) => `${name}${suffix}`),
    ),
    ...INFRASTRUCTURE_LABELS,
]);

/** `true` iff `label` (any case, surrounding spaces ignored) is reserved for the platform. */
export function isReservedSubdomainLabel(label: string | null | undefined): boolean {
    return RESERVED_SUBDOMAIN_LABELS.has((label ?? '').trim().toLowerCase());
}

/**
 * Compare two DNS record contents (CNAME targets or IPs) the way DNS does: case-insensitive and
 * ignoring a trailing root dot. Empty values never match.
 */
export function sameDnsContent(
    a: string | null | undefined,
    b: string | null | undefined,
): boolean {
    const normalize = (value: string | null | undefined) =>
        (value ?? '').trim().toLowerCase().replace(/\.$/, '');
    const left = normalize(a);
    return left.length > 0 && left === normalize(b);
}

/**
 * Thrown when a DNS write would repoint or delete a record that is not the platform's managed
 * record: the hostname already exists in the zone and points somewhere other than the managed
 * target. Callers map it to 409 (rename) or skip the host (deploy).
 */
export class DnsRecordConflictError extends Error {
    constructor(
        readonly host: string,
        readonly existingType: string,
        readonly existingContent: string,
    ) {
        super(
            `DNS record ${host} already exists (${existingType} -> ${existingContent}) and is not managed by this provider; refusing to change it`,
        );
        this.name = 'DnsRecordConflictError';
    }
}
