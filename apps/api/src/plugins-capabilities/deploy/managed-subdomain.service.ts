import {
    BadRequestException,
    ConflictException,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { WorkRepository } from '@ever-works/agent/database';
import {
    DnsRecordConflictError,
    EverWorksDnsService,
    isReservedSubdomainLabel,
    type CloudflareDnsProvider,
} from '@ever-works/agent/ever-works-providers';
import type { Work } from '@ever-works/agent/entities';

/**
 * EW-739 — service backing the managed-subdomain API.
 *
 * Single source of truth for "read or change the managed subdomain attached
 * to a Work" so the new `GET/PUT /api/deploy/works/:id/subdomain` endpoints,
 * the future Deploy-tab UI server actions, and any background reconciler
 * (EW-741) all flow through the same validation + DNS + persistence chain.
 *
 * Stays out of `DeployService` deliberately — that service drives the deploy
 * pipeline (workflow dispatch, secret pushes). Renaming a subdomain is
 * orthogonal to a deploy: it touches DNS + the Work row, then either patches
 * the live Ingress directly (k8s, future EW-740 follow-up) or surfaces a
 * "redeploy required" hint to the caller. Keeping it separate also lets the
 * tests stub a much smaller dependency surface than `DeployService`'s.
 */
export interface SubdomainState {
    /** Leftmost label persisted on `work.managedSubdomain`. */
    readonly subdomain: string | null;
    /** `${subdomain}.${rootDomain}`. */
    readonly fqdn: string | null;
    /** `https://${fqdn}`. */
    readonly url: string | null;
    /** `true` iff the DNS provider has a record for `fqdn`. */
    readonly recordOk: boolean;
    /**
     * `true` iff the caller can re-allocate via `PUT`. Gated on
     * `work.deployProvider ∈ {'ever-works','k8s','cloudflare'}` AND, for
     * k8s, the `K8S_MANAGED_SUBDOMAIN` env flag being active so operator
     * opt-in is respected.
     */
    readonly editable: boolean;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

@Injectable()
export class ManagedSubdomainService {
    private readonly logger = new Logger(ManagedSubdomainService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly dnsService: EverWorksDnsService,
    ) {}

    /**
     * Resolve current state for the UI. Never mutates. Always returns a
     * snapshot — when no managed subdomain is allocated yet, all url-shaped
     * fields are `null` and `recordOk` is `false`, but `editable` may still
     * be `true` so the UI can offer a first-time allocation flow.
     */
    async getState(workId: string): Promise<SubdomainState> {
        const work = await this.requireWork(workId);
        const provider = this.dnsService.getProvider();
        const rootDomain = provider?.rootDomain() ?? this.fallbackRootDomain();
        const subdomain = (work.managedSubdomain ?? '').trim().toLowerCase() || null;
        const fqdn = subdomain ? `${subdomain}.${rootDomain}` : null;
        const url = fqdn ? `https://${fqdn}` : null;

        let recordOk = false;
        if (subdomain && fqdn && provider) {
            try {
                recordOk = await provider.recordExists(fqdn);
            } catch (cause) {
                // A probe failure is a transient health signal, not a hard
                // error — log + fall through so the UI still renders.
                this.logger.warn(
                    `recordExists probe failed for ${fqdn}: ${(cause as Error).message}`,
                );
            }
        }

        return {
            subdomain,
            fqdn,
            url,
            recordOk,
            editable: this.isEditable(work),
        };
    }

    /**
     * Re-allocate the managed subdomain to `requested` for `workId`. Steps:
     *   1. Format guard (defence-in-depth — controller DTO already validated).
     *   2. Blocklist guard (spec §7, `RESERVED_SUBDOMAIN_LABELS`, shared with
     *      `SubdomainAllocator`).
     *   3. No-op when `requested` already matches `work.managedSubdomain`.
     *   4. Global uniqueness via `WorkRepository.findByManagedSubdomain`.
     *   4b. Zone uniqueness: the hostname must not already exist in the DNS
     *      zone (the zone also holds the platform's own hosts). Same probe
     *      `SubdomainAllocator` runs before it allocates. The Work's own
     *      current record never reaches it (step 3).
     *   5. Persist `work.managedSubdomain = requested`. The partial unique
     *      index is the DB-level backstop against concurrent renames.
     *   6. Ensure the new DNS record. Failure is hard-error: a successful
     *      persist without a working CNAME would leave the UI showing a
     *      claim that doesn't resolve. We try to roll back the persisted
     *      claim so the caller can retry — and the old record is still in
     *      place, because it is only removed after this succeeds.
     *   7. Remove the old DNS record (best-effort) — keeps the zone tidy and
     *      releases the old label so a sibling Work can re-claim it.
     *
     * Returns the post-update `SubdomainState` for the caller.
     */
    async update(workId: string, requested: string): Promise<SubdomainState> {
        const normalized = (requested ?? '').trim().toLowerCase();
        if (!LABEL_RE.test(normalized) || normalized.length > 63) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'Invalid subdomain format. Must be lowercase letters, digits, and dashes (no leading/trailing dash), 1-63 characters.',
            });
        }
        if (isReservedSubdomainLabel(normalized)) {
            throw new BadRequestException({
                status: 'error',
                message: `Subdomain "${normalized}" is reserved by the platform and cannot be claimed.`,
            });
        }

        const work = await this.requireWork(workId);
        if (!this.isEditable(work)) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'Managed subdomain is not editable for this work (requires the ever-works or cloudflare provider, or k8s with managed mode active).',
            });
        }

        const currentSubdomain = (work.managedSubdomain ?? '').trim().toLowerCase();
        if (currentSubdomain === normalized) {
            // Idempotent — short-circuit so we don't re-touch DNS unnecessarily.
            return this.getState(workId);
        }

        const claimedBy = await this.workRepository.findByManagedSubdomain(normalized);
        if (claimedBy && claimedBy.id !== work.id) {
            throw new ConflictException({
                status: 'error',
                message: `Subdomain "${normalized}" is already claimed by another work.`,
            });
        }

        const provider = this.dnsService.getProvider();
        const lbTarget = process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME?.trim() ?? '';

        // Cloudflare Workers: the label is the Worker's hostname label, and
        // the Workers Custom Domain that `wrangler deploy` attaches brings its
        // own DNS record (a CNAME to the k8s LB here would even block it).
        // So a rename only re-claims the label; the next deploy publishes the
        // site at the new hostname, on a new `ew-<label>` Worker. That deploy
        // takes over whatever record holds the name, so the zone check matters
        // just as much here. The probe only reads the platform zone, so it does
        // not need the LB target; with no zone configured at all there is
        // nothing to probe, as for `SubdomainAllocator`. (A Work publishing to
        // a member's own Cloudflare zone is still probed in the platform zone:
        // a name taken there is refused, which fails safe.)
        if (this.isCloudflare(work)) {
            const probe = this.dnsService.getZoneProbe();
            if (probe) {
                await this.assertHostnameFree(work, normalized, probe);
            }
            return this.renameWithoutDns(work, currentSubdomain, normalized);
        }

        if (!provider) {
            throw new InternalServerErrorException({
                status: 'error',
                message:
                    'Managed DNS is not configured on this environment (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID / EVER_WORKS_DEPLOY_LB_HOSTNAME missing).',
            });
        }
        if (!lbTarget) {
            throw new InternalServerErrorException({
                status: 'error',
                message:
                    'Managed DNS target (EVER_WORKS_DEPLOY_LB_HOSTNAME) is not configured on this environment.',
            });
        }

        const rootDomain = provider.rootDomain();
        const newFqdn = `${normalized}.${rootDomain}`;
        const oldFqdn = currentSubdomain ? `${currentSubdomain}.${rootDomain}` : null;

        // Step 4b: before any write (DB claim, new record, old-record cleanup).
        await this.assertHostnameFree(work, normalized, provider);

        // Step 5: persist. A concurrent rename racing to the same label will
        // surface as a unique-index violation here; we map it to 409 so the
        // UI shows a friendly retry message instead of a generic 500.
        try {
            await this.workRepository.update(work.id, { managedSubdomain: normalized });
        } catch (cause) {
            if (this.isUniqueViolation(cause)) {
                throw new ConflictException({
                    status: 'error',
                    message: `Subdomain "${normalized}" was just claimed by another work. Please pick a different one.`,
                });
            }
            throw cause;
        }

        // Step 6: ensure the new record. On failure, try to roll back the
        // persisted claim so the user isn't stuck with a half-applied rename;
        // the old record has not been touched yet.
        try {
            await provider.ensureRecord({
                host: newFqdn,
                type: 'CNAME',
                target: lbTarget,
                proxied: false,
                ttl: 1,
            });
        } catch (cause) {
            this.logger.error(
                `ensureRecord failed for ${newFqdn} on work ${work.id}: ${(cause as Error).message}; rolling back persisted claim`,
            );
            try {
                await this.workRepository.update(work.id, {
                    managedSubdomain: currentSubdomain || null,
                });
            } catch (rollbackErr) {
                this.logger.error(
                    `Failed to roll back managedSubdomain for work ${work.id}: ${(rollbackErr as Error).message}`,
                );
            }
            // The provider refused to repoint a record created for something
            // else between the probe above and this write.
            if (cause instanceof DnsRecordConflictError) {
                throw this.hostnameInUse(normalized, rootDomain);
            }
            throw new InternalServerErrorException({
                status: 'error',
                message: `Failed to create DNS record for ${newFqdn}. The rename was not applied.`,
            });
        }

        // Step 7: best-effort old-record cleanup, only once the new record is
        // in place. A failure here doesn't undo the rename but is logged so an
        // operator can clean up a dangling CNAME. A reserved platform label is
        // never deleted, and the provider itself refuses to delete a record
        // that is not on the managed target.
        if (oldFqdn && !isReservedSubdomainLabel(currentSubdomain)) {
            try {
                await provider.removeRecord({ host: oldFqdn });
            } catch (cause) {
                this.logger.warn(
                    `Failed to remove stale DNS record for ${oldFqdn} during rename of work ${work.id}: ${(cause as Error).message}`,
                );
            }
        }

        this.logger.log(
            `Managed subdomain for work ${work.id} updated: ${currentSubdomain || '(unset)'} -> ${normalized}`,
        );

        // Re-read so the response reflects the persisted state (including
        // `recordOk` after the freshly ensured record).
        return this.getState(work.id);
    }

    /**
     * 409 unless `<label>.<rootDomain>` is free in the DNS zone. Any existing
     * record of any type counts, even one aimed at the managed LB: the zone also
     * holds the platform's own hosts, which may share that target, so its
     * content cannot prove which Work (if any) the record belongs to. Fails
     * closed: when the zone cannot be read the rename is refused (503) rather
     * than risk taking over a host that exists.
     */
    private async assertHostnameFree(
        work: Work,
        label: string,
        provider: Pick<CloudflareDnsProvider, 'recordExists' | 'rootDomain'>,
    ): Promise<void> {
        const rootDomain = provider.rootDomain();
        const fqdn = `${label}.${rootDomain}`;
        let exists: boolean;
        try {
            exists = await provider.recordExists(fqdn);
        } catch (cause) {
            this.logger.warn(
                `Zone probe failed for ${fqdn} during rename of work ${work.id}: ${(cause as Error).message}`,
            );
            throw new ServiceUnavailableException({
                status: 'error',
                message: `Could not check whether ${fqdn} is free. Please try again.`,
            });
        }
        if (exists) {
            this.logger.warn(
                `Refused managed subdomain ${fqdn} for work ${work.id}: the hostname already exists in the zone`,
            );
            throw this.hostnameInUse(label, rootDomain);
        }
    }

    private hostnameInUse(label: string, rootDomain: string): ConflictException {
        return new ConflictException({
            status: 'error',
            message: `Subdomain "${label}" is already in use on ${rootDomain}. Please pick a different one.`,
        });
    }

    /**
     * For callers that don't have the Work in hand yet — keeps the
     * controller thin and centralises the 404 message.
     */
    private async requireWork(workId: string): Promise<Work> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException({
                status: 'error',
                message: `Work ${workId} not found`,
            });
        }
        return work;
    }

    /**
     * Editable iff the deploy provider is one that runs through
     * `applyManagedSubdomain`. For `'k8s'` we additionally require the
     * `K8S_MANAGED_SUBDOMAIN` flag so operators opt-in per env —
     * matches the gate in `DeployService.isManagedSubdomainForK8sEnabled`.
     * `'ever-works'` and `'cloudflare'` are always managed.
     */
    private isEditable(work: Work): boolean {
        const provider = (work.deployProvider ?? '').trim().toLowerCase();
        if (provider === 'ever-works') {
            return true;
        }
        if (provider === 'k8s') {
            return process.env.K8S_MANAGED_SUBDOMAIN === 'true';
        }
        // The Cloudflare Workers provider always deploys on the managed
        // subdomain (`DeployService.applyCloudflareSubdomain`); no flag.
        return this.isCloudflare(work);
    }

    private isCloudflare(work: Work): boolean {
        return (work.deployProvider ?? '').trim().toLowerCase() === 'cloudflare';
    }

    /**
     * Rename for a provider whose hosting owns the DNS record (Cloudflare
     * Workers Custom Domains): persist the new label — the partial unique
     * index stays the race backstop — and touch no DNS.
     */
    private async renameWithoutDns(
        work: Work,
        currentSubdomain: string,
        normalized: string,
    ): Promise<SubdomainState> {
        try {
            await this.workRepository.update(work.id, { managedSubdomain: normalized });
        } catch (cause) {
            if (this.isUniqueViolation(cause)) {
                throw new ConflictException({
                    status: 'error',
                    message: `Subdomain "${normalized}" was just claimed by another work. Please pick a different one.`,
                });
            }
            throw cause;
        }
        this.logger.log(
            `Managed subdomain for work ${work.id} updated: ${currentSubdomain || '(unset)'} -> ${normalized} (no DNS change; takes effect on the next deploy)`,
        );
        return this.getState(work.id);
    }

    private fallbackRootDomain(): string {
        return process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';
    }

    /**
     * Mirrors `SubdomainAllocator.isUniqueViolation`. Kept duplicated rather
     * than re-exported because the allocator's helper is `private` and
     * widening visibility for one cross-module caller would be worse than a
     * 10-line copy.
     */
    private isUniqueViolation(cause: unknown): boolean {
        if (!cause || typeof cause !== 'object') return false;
        const err = cause as { code?: string; driverError?: { code?: string }; message?: string };
        if (err.code === '23505') return true;
        if (err.driverError?.code === '23505') return true;
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
        const msg = (err.message ?? '').toLowerCase();
        return msg.includes('unique constraint') || msg.includes('uq_works_managedsubdomain');
    }
}
