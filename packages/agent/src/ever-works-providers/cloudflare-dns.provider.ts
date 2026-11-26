import { Injectable, Logger } from '@nestjs/common';
import type {
    DnsEnsureRecordInput,
    DnsRecordSnapshot as DnsRecordSnapshotContract,
    DnsRecordType,
    DnsRemoveRecordInput,
    IDnsOperations,
} from '@ever-works/plugin';
import {
    DnsRecordConflictError,
    isReservedSubdomainLabel,
    sameDnsContent,
} from './managed-subdomain-guard';

/**
 * EW-617 G5 — Cloudflare DNS provider for `*.ever.works`.
 *
 * Creates a CNAME record pointing `{slug}.ever.works` at the k8s-works
 * cluster ingress load balancer when an Ever Works pipeline deploys a
 * Work, and tears it down on Work delete. Operates against the
 * Cloudflare v4 REST API with a scoped API token (DNS:Edit on the
 * `ever.works` zone only).
 *
 * Configuration (operator runbook):
 *
 *   CLOUDFLARE_API_TOKEN          # scoped token, DNS:Edit on the zone
 *   CLOUDFLARE_ZONE_ID            # `ever.works` zone id
 *   EVER_WORKS_DOMAIN             # defaults to `ever.works`
 *   EVER_WORKS_DEPLOY_LB_HOSTNAME # CNAME target — the k8s-works ingress LB
 *
 * The provider intentionally has no @nestjs/axios dependency — it uses
 * the global `fetch` (Node 22+) so it can be tested with `fetch` mocks
 * and stays small.
 */

/**
 * Cloudflare Tunnel targets (`<tunnel-uuid>.cfargotunnel.com`) are NOT
 * real public DNS names — they only resolve through Cloudflare's proxy.
 * An unproxied ("grey cloud") CNAME at one resolves to an unroutable
 * placeholder address, so the hostname is dead on the public internet.
 *
 * Verified against the live `ever.works` zone: an unproxied CNAME to the
 * tunnel resolved to `fd10:aec2:5dae::` and every request failed to
 * connect; flipping the same record to proxied resolved to Cloudflare
 * edge IPs and reached the origin. Every working tunnel-backed record in
 * that zone is proxied.
 *
 * So proxying is derived from the target rather than configured: tunnel
 * targets MUST be proxied, and anything else (a real LB hostname or A
 * record) keeps the previous unproxied default.
 */
/** Upper bound for one Cloudflare API call (see `CloudflareDnsProvider.request`). */
export const CLOUDFLARE_REQUEST_TIMEOUT_MS = 10_000;

export function requiresProxy(targetHostname: string): boolean {
    return /(^|\.)cfargotunnel\.com$/i.test((targetHostname ?? '').trim());
}

export interface CloudflareDnsConfig {
    apiToken: string;
    zoneId: string;
    /** e.g. 'ever.works' — used to validate target names + log. */
    rootDomain: string;
    /** Hostname the CNAME points at (k8s-works ingress LB). */
    targetHostname: string;
    /** Optional base URL override (tests, staging mirror). */
    apiBaseUrl?: string;
    /**
     * Whether this provider may repoint or delete a record whose content is NOT `targetHostname`.
     *
     * `false` (the default) is for the platform zone, which also holds the platform's own hosts:
     * `ensureRecord`, `ensureWorkSubdomain`, `removeRecord` and `removeWorkSubdomain` throw
     * `DnsRecordConflictError` instead of changing a record aimed anywhere but the managed target.
     * A missing record is still created and a record already on the managed target is still
     * updated or deleted.
     *
     * **What this does NOT prove:** a record on the managed target is not necessarily a Work's.
     * Where platform hosts point at the same target (prod's Cloudflare Tunnel host fronts most of
     * them), this check cannot tell them from Work records, so it protects only records that point
     * somewhere else. The rename's zone probe (any existing name is refused) and the reserved list
     * are the protection on the claim side; marking the records the platform creates (record
     * comment/tag) so only those are touched is a follow-up.
     *
     * `true` only for a zone of its own in which every name this provider writes is a label it
     * allocated itself and whose target legitimately moves (a dedicated apps zone: each App's record
     * follows its ingress address). Never for the platform zone.
     */
    manageForeignRecords?: boolean;
    /**
     * Earlier values of `targetHostname` (the LB moved). A record still aimed at one of them is a
     * managed record left behind by the move, so it is repointed (or deleted) like one on the
     * current target. Operator-declared via `EVER_WORKS_DEPLOY_LB_PREVIOUS_HOSTNAMES`; never list
     * a target that hosts outside the managed Works also point at.
     */
    previousTargetHostnames?: readonly string[];
}

export interface DnsRecordSnapshot {
    id: string;
    /**
     * Historically `'CNAME'`-only (the original EW-617 G5 managed flow
     * only ever created CNAMEs). Widened to A/CNAME in EW-735 so the
     * new `IDnsOperations.ensureRecord` path can return the same shape
     * for k8s A-record targets without forking the snapshot type.
     */
    type: 'CNAME' | 'A';
    name: string;
    content: string;
}

/** A record of any type as the zone lists it (TXT, MX, AAAA, ... included). */
interface ZoneRecord {
    id: string;
    type: string;
    name: string;
    content: string;
}

export class CloudflareDnsError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly errors: unknown,
    ) {
        super(message);
        this.name = 'CloudflareDnsError';
    }
}

/**
 * Pure (testable) Cloudflare client. Construct with a config; tests pass
 * a custom `fetch` impl via the second arg.
 */
export class CloudflareDnsProvider implements IDnsOperations {
    private readonly logger = new Logger(CloudflareDnsProvider.name);
    private readonly baseUrl: string;

    constructor(
        private readonly config: CloudflareDnsConfig,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.baseUrl = (config.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4').replace(
            /\/$/,
            '',
        );
    }

    /**
     * Ensure a CNAME record exists pointing `<slug>.<rootDomain>` at
     * the configured target hostname. Idempotent: if a matching CNAME
     * already exists, returns it; a missing record is created. A CNAME
     * aimed anywhere else is not this Work's record (it is one of the
     * zone's other hosts), so it is never repointed: this throws
     * `DnsRecordConflictError` (see `manageForeignRecords`). A reserved
     * platform label is refused outright. Always returns a snapshot
     * for the caller to log / persist.
     */
    async ensureWorkSubdomain(slug: string): Promise<DnsRecordSnapshot> {
        this.assertSlug(slug);
        const fqdn = `${slug}.${this.config.rootDomain}`;
        const target = this.config.targetHostname;
        const proxied = requiresProxy(target);
        if (isReservedSubdomainLabel(slug)) {
            throw new Error(`Refusing to manage reserved platform subdomain ${fqdn}`);
        }

        const existing = await this.findRecord(fqdn);
        if (existing) {
            if (sameDnsContent(existing.content, target) && existing.type === 'CNAME') {
                this.logger.log(`CloudflareDns CNAME already in sync ${fqdn} -> ${target}`);
                return existing;
            }
            this.assertManagedRecord(fqdn, existing);
            // Drifted record this provider manages (manageForeignRecords). Update.
            const updated = await this.patchRecord(existing.id, {
                type: 'CNAME',
                name: fqdn,
                content: target,
                proxied,
                ttl: 1, // 1 == 'auto' per Cloudflare docs
            });
            this.logger.log(
                `CloudflareDns CNAME updated ${fqdn}: was ${existing.content} now ${target}`,
            );
            return updated;
        }

        await this.assertNoForeignRecordOfOtherType(fqdn, 'CNAME');
        const created = await this.createRecord({
            type: 'CNAME',
            name: fqdn,
            content: target,
            proxied,
            ttl: 1,
        });
        this.logger.log(`CloudflareDns CNAME created ${fqdn} -> ${target}`);
        return created;
    }

    /**
     * Remove the CNAME for a Work — no-op if it never existed. Refuses a
     * reserved platform label and a record that is not on the managed target.
     */
    async removeWorkSubdomain(slug: string): Promise<void> {
        this.assertSlug(slug);
        const fqdn = `${slug}.${this.config.rootDomain}`;
        if (isReservedSubdomainLabel(slug)) {
            throw new Error(`Refusing to remove reserved platform subdomain ${fqdn}`);
        }
        const existing = await this.findRecord(fqdn);
        if (!existing) {
            return;
        }
        // Never delete one of the zone's other hosts that shares the slug.
        this.assertManagedRecord(fqdn, existing);
        await this.deleteRecord(existing.id);
        this.logger.log(`CloudflareDns CNAME deleted ${fqdn}`);
    }

    // EW-735 — IDnsOperations contract ---------------------------------------
    //
    // Thin host-keyed surface that `SubdomainAllocator` + future code paths
    // talk to. ADDITIVE — the legacy `ensureWorkSubdomain` / `removeWorkSubdomain`
    // methods above stay unchanged and the existing call sites
    // (`EverWorksDnsService.ensureWorkSubdomain` → `applyEverWorksSubdomain`)
    // keep behaving bit-for-bit.

    /**
     * Idempotent create-or-update for any host the caller specifies.
     * Generalizes `ensureWorkSubdomain` (which is restricted to slug-shaped
     * hosts under the managed `rootDomain`) to arbitrary hosts + A/CNAME.
     * An existing record is only repointed when this provider manages it
     * (`manageForeignRecords`); otherwise this throws `DnsRecordConflictError`
     * and sends no write.
     */
    async ensureRecord(input: DnsEnsureRecordInput): Promise<DnsRecordSnapshotContract> {
        // Augment low: normalize once and use the normalized form everywhere
        // so a host that passes validation only after trim/lowercase doesn't
        // miss an existing record (lookup) or get sent verbatim to Cloudflare.
        const host = this.normalizeHost(input.host);
        this.assertNotReservedHost(host);
        const proxied = input.proxied ?? false;
        const ttl = input.ttl ?? 1;
        const existing = await this.findRecord(host, input.type);
        if (existing) {
            if (sameDnsContent(existing.content, input.target) && existing.type === input.type) {
                this.logger.log(
                    `CloudflareDns ${input.type} already in sync ${host} -> ${input.target}`,
                );
                return existing as DnsRecordSnapshotContract;
            }
            this.assertManagedRecord(host, existing);
            const updated = await this.patchAnyRecord(existing.id, {
                type: input.type,
                name: host,
                content: input.target,
                proxied,
                ttl,
            });
            this.logger.log(
                `CloudflareDns ${input.type} updated ${host}: was ${existing.content} now ${input.target}`,
            );
            return updated;
        }
        await this.assertNoForeignRecordOfOtherType(host, input.type);
        const created = await this.createAnyRecord({
            type: input.type,
            name: host,
            content: input.target,
            proxied,
            ttl,
        });
        this.logger.log(`CloudflareDns ${input.type} created ${host} -> ${input.target}`);
        return created;
    }

    /**
     * Idempotent delete for any host. No-op when the record does not exist.
     * When `input.type` is omitted, probes BOTH CNAME and A so a caller that
     * doesn't know the original record type still removes it (Augment low).
     * A record this provider does not manage is left in place and this
     * throws `DnsRecordConflictError` (see `manageForeignRecords`).
     */
    async removeRecord(input: DnsRemoveRecordInput): Promise<void> {
        const host = this.normalizeHost(input.host);
        this.assertNotReservedHost(host);
        const typesToProbe: DnsRecordType[] = input.type ? [input.type] : ['CNAME', 'A'];
        for (const type of typesToProbe) {
            const existing = await this.findRecord(host, type);
            if (existing) {
                this.assertManagedRecord(host, existing);
                await this.deleteRecord(existing.id);
                this.logger.log(
                    `CloudflareDns ${existing.type} deleted ${host} (id=${existing.id})`,
                );
            }
        }
    }

    /**
     * Uniqueness probe — `true` iff ANY record exists for `host` in the
     * managed zone (CNAME, A, the `AAAA 100::` of a Workers custom domain or
     * route, TXT, MX, HTTPS, ...), regardless of who owns it. Used by
     * `SubdomainAllocator` and the explicit rename to detect collisions
     * before persisting a claim. One exact-name lookup, so a wildcard record
     * never makes a name look taken.
     */
    async recordExists(host: string): Promise<boolean> {
        return (await this.findRecordsByName(this.normalizeHost(host))).length > 0;
    }

    /** Zone root domain managed by this provider (e.g. `'ever.works'`). */
    rootDomain(): string {
        return this.config.rootDomain;
    }

    // Internal helpers ------------------------------------------------------

    /**
     * Refuse to repoint or delete `record` unless it points at the managed
     * target (or a declared previous one), or the whole zone is managed
     * (`manageForeignRecords`). Content is the only evidence available, so a
     * platform host that shares the managed target passes: see
     * `CloudflareDnsConfig.manageForeignRecords`.
     */
    /**
     * Refuse `<reserved label>.<rootDomain>` in the host-keyed methods too, like
     * `ensureWorkSubdomain` / `removeWorkSubdomain` do for a slug.
     */
    private assertNotReservedHost(host: string): void {
        const root = this.config.rootDomain.toLowerCase();
        if (!host.endsWith(`.${root}`)) return;
        const label = host.slice(0, -(root.length + 1));
        if (!label.includes('.') && isReservedSubdomainLabel(label)) {
            throw new Error(`Refusing to manage reserved platform subdomain ${host}`);
        }
    }

    private assertManagedRecord(host: string, record: { type: string; content: string }): void {
        if (this.config.manageForeignRecords === true) return;
        const managedTargets = [
            this.config.targetHostname,
            ...(this.config.previousTargetHostnames ?? []),
        ];
        if (managedTargets.some((target) => sameDnsContent(record.content, target))) return;
        this.logger.warn(
            `CloudflareDns refused to change ${host}: it points at ${record.content}, not the managed target`,
        );
        throw new DnsRecordConflictError(host, record.type, record.content);
    }

    private assertSlug(slug: string): void {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`Invalid slug for Cloudflare DNS: ${slug}`);
        }
    }

    /**
     * EW-735 — validate + normalize an arbitrary FQDN. Stricter than
     * `assertSlug` because the host may contain dots (label.label.tld). Each
     * label follows the same slug-shaped rule as `assertSlug`. Returns the
     * trim/lowercased form so callers can use it verbatim in Cloudflare
     * API payloads and lookups (Augment low — previously the validator
     * normalized but the caller used the raw input).
     */
    private normalizeHost(host: string): string {
        const trimmed = (host ?? '').trim().toLowerCase();
        if (trimmed.length === 0 || trimmed.length > 253) {
            throw new Error(`Invalid host for Cloudflare DNS: ${host}`);
        }
        const labelRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
        for (const label of trimmed.split('.')) {
            if (!labelRe.test(label) || label.length > 63) {
                throw new Error(`Invalid host for Cloudflare DNS: ${host}`);
            }
        }
        return trimmed;
    }

    /**
     * Before creating a `type` record for `host`: a record of ANOTHER type for the same name that
     * cannot coexist with it (anything at all for a CNAME, e.g. an A, the `AAAA 100::` of a Workers
     * custom domain, a TXT or an MX; a CNAME for an A) is invisible to the same-type lookup, and
     * the create would only fail at Cloudflare as a generic error that callers treat as transient.
     * Surface it as the conflict it is. Skipped for a wholly managed zone, which keeps its previous
     * behaviour.
     */
    private async assertNoForeignRecordOfOtherType(
        host: string,
        type: DnsRecordType,
    ): Promise<void> {
        if (this.config.manageForeignRecords === true) return;
        for (const found of await this.findRecordsByName(host)) {
            if (found.type === type) continue;
            if (type === 'CNAME' || found.type === 'CNAME') this.assertManagedRecord(host, found);
        }
    }

    /** Every record named exactly `name`, of any type (no `type` filter). */
    private async findRecordsByName(name: string): Promise<ZoneRecord[]> {
        const url = new URL(`${this.baseUrl}/zones/${this.config.zoneId}/dns_records`);
        url.searchParams.set('name', name);
        const json = await this.request<{ result: ZoneRecord[] }>(url.toString(), {
            method: 'GET',
        });
        return json.result ?? [];
    }

    private async findRecord(
        name: string,
        type: DnsRecordType = 'CNAME',
    ): Promise<DnsRecordSnapshot | null> {
        const url = new URL(`${this.baseUrl}/zones/${this.config.zoneId}/dns_records`);
        url.searchParams.set('name', name);
        url.searchParams.set('type', type);
        const json = await this.request<{
            result: (DnsRecordSnapshot & { type: DnsRecordType })[];
        }>(url.toString(), { method: 'GET' });
        return (json.result[0] ?? null) as DnsRecordSnapshot | null;
    }

    private async createAnyRecord(payload: {
        type: DnsRecordType;
        name: string;
        content: string;
        proxied: boolean;
        ttl: number;
    }): Promise<DnsRecordSnapshotContract> {
        const json = await this.request<{ result: DnsRecordSnapshotContract }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records`,
            { method: 'POST', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async patchAnyRecord(
        id: string,
        payload: {
            type: DnsRecordType;
            name: string;
            content: string;
            proxied: boolean;
            ttl: number;
        },
    ): Promise<DnsRecordSnapshotContract> {
        const json = await this.request<{ result: DnsRecordSnapshotContract }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records/${id}`,
            { method: 'PUT', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async createRecord(payload: {
        type: 'CNAME';
        name: string;
        content: string;
        proxied: boolean;
        ttl: number;
    }): Promise<DnsRecordSnapshot> {
        const json = await this.request<{ result: DnsRecordSnapshot }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records`,
            { method: 'POST', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async patchRecord(
        id: string,
        payload: {
            type: 'CNAME';
            name: string;
            content: string;
            proxied: boolean;
            ttl: number;
        },
    ): Promise<DnsRecordSnapshot> {
        const json = await this.request<{ result: DnsRecordSnapshot }>(
            `${this.baseUrl}/zones/${this.config.zoneId}/dns_records/${id}`,
            { method: 'PUT', body: JSON.stringify(payload) },
        );
        return json.result;
    }

    private async deleteRecord(id: string): Promise<void> {
        await this.request(`${this.baseUrl}/zones/${this.config.zoneId}/dns_records/${id}`, {
            method: 'DELETE',
        });
    }

    private async request<T = unknown>(url: string, init: RequestInit): Promise<T> {
        const response = await this.fetchImpl(url, {
            ...init,
            // Some callers now await these calls on the deploy and rename paths,
            // so a hung request must not stall them for the runtime's default.
            signal: init.signal ?? AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
            headers: {
                Authorization: `Bearer ${this.config.apiToken}`,
                'Content-Type': 'application/json',
                ...(init.headers ?? {}),
            },
        });
        let body: any;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok || (body && body.success === false)) {
            throw new CloudflareDnsError(
                `Cloudflare API ${init.method ?? 'GET'} ${url} failed: ${response.status}`,
                response.status,
                body?.errors ?? body ?? null,
            );
        }
        return body as T;
    }
}

/**
 * Nest-injectable facade that owns the env reading + lazy-instantiation
 * of the `CloudflareDnsProvider`. Returns `null` from `getProvider()`
 * when DNS automation is not configured (env vars missing) so callers
 * can no-op cleanly in dev.
 */
@Injectable()
export class EverWorksDnsService {
    private readonly logger = new Logger(EverWorksDnsService.name);
    private cachedProvider: CloudflareDnsProvider | null | undefined;
    private cachedProbe: CloudflareDnsProvider | null | undefined;

    getProvider(): CloudflareDnsProvider | null {
        if (this.cachedProvider !== undefined) {
            return this.cachedProvider;
        }
        const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
        const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
        const targetHostname = process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME?.trim();
        const rootDomain = process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';

        if (!apiToken || !zoneId || !targetHostname) {
            this.logger.debug(
                'CloudflareDns not configured (missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID / EVER_WORKS_DEPLOY_LB_HOSTNAME) — skipping subdomain automation',
            );
            this.cachedProvider = null;
            return null;
        }

        // Comma-separated earlier LB hostnames, so records left on them are
        // repointed after the LB moves (see `previousTargetHostnames`).
        const previousTargetHostnames = (process.env.EVER_WORKS_DEPLOY_LB_PREVIOUS_HOSTNAMES ?? '')
            .split(',')
            .map((host) => host.trim())
            .filter((host) => host.length > 0);

        this.cachedProvider = new CloudflareDnsProvider({
            apiToken,
            zoneId,
            rootDomain,
            targetHostname,
            previousTargetHostnames,
        });
        return this.cachedProvider;
    }

    /**
     * Read access to the platform zone for the "is this name taken?" probe.
     * Needs only `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`: unlike
     * `getProvider()` it does not require `EVER_WORKS_DEPLOY_LB_HOSTNAME`, so
     * a check that writes no record (the Cloudflare Workers rename) still runs
     * where no LB target is configured. Only `recordExists` / `rootDomain` are
     * meant to be called on it.
     */
    getZoneProbe(): Pick<CloudflareDnsProvider, 'recordExists' | 'rootDomain'> | null {
        const provider = this.getProvider();
        if (provider) return provider;
        if (this.cachedProbe !== undefined) return this.cachedProbe;
        const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
        const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
        const rootDomain = process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';
        this.cachedProbe =
            apiToken && zoneId
                ? new CloudflareDnsProvider({ apiToken, zoneId, rootDomain, targetHostname: '' })
                : null;
        return this.cachedProbe;
    }

    /** Compute the canonical ingress host for a given Work slug. */
    ingressHostFor(slug: string): string {
        // Security: validate slug with the same rule enforced in CloudflareDnsProvider.assertSlug
        // to prevent malformed/injected values from being stored as canonical URLs.
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`Invalid slug for ingress host: ${slug}`);
        }
        const rootDomain = process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';
        return `${slug}.${rootDomain}`;
    }

    /**
     * Ensure the Work's `<slug>.<root>` CNAME. Never throws. Answers whether
     * the host may be routed to the Work: `false` when the slug is a reserved
     * platform label or the name already belongs to another host in the zone
     * (`DnsRecordConflictError`), so the caller must keep it off the Ingress.
     * Any other DNS failure answers `true`, as before: the deploy proceeds and
     * the record can be fixed afterwards.
     */
    async ensureWorkSubdomain(slug: string): Promise<boolean> {
        const provider = this.getProvider();
        if (!provider) return true;
        if (isReservedSubdomainLabel(slug)) {
            this.logger.warn(`Not managing reserved platform subdomain for slug ${slug}`);
            return false;
        }
        try {
            await provider.ensureWorkSubdomain(slug);
            return true;
        } catch (cause) {
            if (cause instanceof DnsRecordConflictError) {
                this.logger.warn(`Not routing ${cause.host}: ${cause.message}`);
                return false;
            }
            // DNS failures must not abort a deploy — the user can fix the
            // record manually and the Work is still reachable via the LB
            // hostname. Surface the error so ops can alert on it.
            this.logger.error(
                `Failed to ensure CNAME for ${slug}: ${(cause as Error).message}`,
                cause instanceof Error ? cause.stack : undefined,
            );
            return true;
        }
    }

    async removeWorkSubdomain(slug: string): Promise<void> {
        const provider = this.getProvider();
        if (!provider) return;
        try {
            await provider.removeWorkSubdomain(slug);
        } catch (cause) {
            this.logger.error(`Failed to delete CNAME for ${slug}: ${(cause as Error).message}`);
        }
    }

    /** Reset the cache — test-only hook so unit tests can re-read env. */
    resetCacheForTest(): void {
        this.cachedProvider = undefined;
        this.cachedProbe = undefined;
    }
}
