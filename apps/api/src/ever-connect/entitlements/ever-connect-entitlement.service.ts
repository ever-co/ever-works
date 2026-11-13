import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, type Repository } from 'typeorm';
import {
    claimsOfVerifiedJws,
    entitlementStatus,
    KeySet,
    type EverPlatformClient,
    type VerifiedEntitlement,
} from '@ever-co/connect-sdk';
import type { EverPlatformEntitlementView } from '@ever-works/contracts';
import {
    EVER_CONNECT_INSTANCE_ENTITLEMENT_SUBJECT,
    EVER_CONNECT_KEY_SET_SUBJECT,
    EverConnectEntitlement,
    EverConnectLink,
} from '@ever-works/agent/entities';
import { PluginSecretEncService } from '@ever-works/agent/plugins';
import { EverConnectConnectionChangedEvent } from '../ever-connect.events';
import {
    EverConnectExtensions,
    type EverConnectFeedEvent,
    type EverConnectFeedHandler,
    type EverConnectRoundParticipant,
} from '../ever-connect-extensions';
import { EverConnectService } from '../ever-connect.service';
import { isEntitlementsEnabled } from '../ever-connect.switches';
import { platformFailure } from '../identity/platform-answer';

/** How long a document is used before it is read again, when it does not say (6 hours). */
export const ENTITLEMENT_REFRESH_AFTER_S = 21_600;
/** A read that failed is not tried again before this (Ever Platform allows six reads an hour). */
export const ENTITLEMENT_RETRY_AFTER_MS = 15 * 60_000;

/** A tenant link id as Ever Platform issues it (a ULID). */
const LINK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The feed events that announce a new document. */
const ENTITLEMENT_EVENTS: ReadonlySet<string> = new Set([
    'ever.entitlements.entitlement.issued',
    'ever.entitlements.entitlement.revoked',
]);

/** The subject of a tenant link's row. */
export function linkEntitlementSubject(platformLinkId: string): string {
    return `link:${platformLinkId}`;
}

/** What a read came to. */
export type EntitlementRefreshOutcome =
    | 'stored'
    | 'unchanged'
    | 'refused'
    | 'failed'
    | 'not_connected';

interface Claims {
    readonly iat?: number;
    readonly exp?: number;
    readonly ever?: {
        readonly seq?: number;
        readonly handle?: string;
        readonly tier?: string;
        readonly plan?: { readonly code?: string };
        readonly features?: Record<string, unknown>;
        readonly limits?: Record<string, unknown>;
        readonly grace_s?: number;
        readonly refresh_after_s?: number;
        readonly tenant?: { readonly product_tenant_id?: string } | null;
    };
}

/**
 * Entitlement documents: the signed statements of what the installation, and
 * each linked Organization, has on Ever Platform (the plan, the tier, the
 * feature flags and limits).
 *
 * - **Fetch:** `GET /v1/instances/me/entitlement` and, for each linked
 *   Organization, `GET /v1/instances/me/tenant-links/{link}/entitlement`, with
 *   the stored sequence number so an unchanged document costs a `304`. Every
 *   document is read again when it says (six hours unless it names another
 *   period) and when the feed announces a new one, on the replica holding the
 *   Ever Connect lease.
 * - **Verify:** every document goes through the Ever Platform SDK's verifier
 *   before anything is stored (the key set under the pinned root, the
 *   signature, the issuer, this installation, the expected subject, never older
 *   than the stored one). A document that does not verify is not stored; the
 *   previous one stays and the code of the refusal is kept for the operator.
 * - **Cache:** the bytes as received, in `ever_connect_entitlements`, wrapped
 *   like a plugin secret when the installation has an encryption key.
 * - **Read-only:** {@link view} is what Settings → Ever Platform shows. Nothing
 *   in Ever Works depends on a document: its features are Ever Platform's.
 *
 * Does nothing unless `EVER_CONNECT_ENTITLEMENTS_ENABLED=true`, and nothing
 * while the installation is not connected.
 */
@Injectable()
export class EverConnectEntitlementService
    implements OnModuleInit, EverConnectRoundParticipant, EverConnectFeedHandler
{
    readonly name = 'entitlements';
    private readonly logger = new Logger(EverConnectEntitlementService.name);
    private readonly secrets: PluginSecretEncService;
    /** Set when the feed announced a new document: every one is read again on the next round. */
    private announced = false;
    /** When each subject's read last failed (this process), so it is not retried at once. */
    private readonly failedAt = new Map<string, number>();

    constructor(
        @InjectRepository(EverConnectEntitlement)
        private readonly documents: Repository<EverConnectEntitlement>,
        @InjectRepository(EverConnectLink)
        private readonly links: Repository<EverConnectLink>,
        private readonly connection: EverConnectService,
        @Optional() private readonly extensions?: EverConnectExtensions,
        @Optional() secrets?: PluginSecretEncService,
    ) {
        this.secrets = secrets ?? new PluginSecretEncService();
    }

    onModuleInit(): void {
        if (!this.isEnabled()) return;
        this.extensions?.addRoundParticipant(this);
        this.extensions?.addFeedHandler(this);
    }

    isEnabled(): boolean {
        return isEntitlementsEnabled();
    }

    // -- the feed ---------------------------------------------------------------

    handles(type: string): boolean {
        return ENTITLEMENT_EVENTS.has(type);
    }

    async handle(_event: EverConnectFeedEvent): Promise<void> {
        this.announced = true;
    }

    // -- the worker's round -------------------------------------------------------

    /** Read every document that is due (or all of them, after an announcement). */
    async round(now: Date = new Date()): Promise<void> {
        if (!this.isEnabled()) return;
        const row = await this.connection.connection();
        if (row.status !== 'active' || !row.platformInstanceId) return;
        const all = this.announced;
        this.announced = false;

        if (all || (await this.due(EVER_CONNECT_INSTANCE_ENTITLEMENT_SUBJECT, now))) {
            await this.refreshInstance(now);
        }
        const linked = await this.links.find({ where: { status: 'active' } });
        for (const link of linked) {
            if (!link.platformLinkId || !LINK_ID.test(link.platformLinkId)) continue;
            if (all || (await this.due(linkEntitlementSubject(link.platformLinkId), now))) {
                await this.refreshLink(link, now);
            }
        }
    }

    // -- reads ------------------------------------------------------------------

    /** Read, verify and keep the installation's document. Never throws. */
    async refreshInstance(now: Date = new Date()): Promise<EntitlementRefreshOutcome> {
        return this.refresh(EVER_CONNECT_INSTANCE_ENTITLEMENT_SUBJECT, null, now);
    }

    /**
     * Read, verify and keep one linked Organization's document; its handle is
     * copied to the link. Never throws.
     */
    async refreshLink(
        link: EverConnectLink,
        now: Date = new Date(),
    ): Promise<EntitlementRefreshOutcome> {
        if (!link.platformLinkId || !LINK_ID.test(link.platformLinkId)) return 'failed';
        return this.refresh(linkEntitlementSubject(link.platformLinkId), link, now);
    }

    /** What the stored document of `subject` says, or `null` when none is stored. */
    async view(
        subject: string,
        now: Date = new Date(),
    ): Promise<EverPlatformEntitlementView | null> {
        if (!this.isEnabled()) return null;
        const row = await this.documents.findOne({ where: { subject } });
        if (!row || subject === EVER_CONNECT_KEY_SET_SUBJECT) return null;
        const claims = this.claimsOf(row);
        if (!claims && !row.lastError) return null;
        const seconds = (value: number | undefined) =>
            typeof value === 'number' ? new Date(value * 1000).toISOString() : null;
        const status = entitlementStatus(
            claims && typeof claims.exp === 'number'
                ? { exp: claims.exp, ever: { grace_s: claims.ever?.grace_s as number } }
                : null,
            Math.floor(now.getTime() / 1000),
        );
        return {
            status: status === 'stale' ? 'grace' : status,
            handle: claims?.ever?.handle ?? null,
            tier: claims?.ever?.tier ?? null,
            plan: claims?.ever?.plan?.code ?? null,
            features: flags(claims?.ever?.features),
            limits: numbers(claims?.ever?.limits),
            seq: claims?.ever?.seq ?? (row.seq === null ? null : Number(row.seq)),
            issuedAt: seconds(claims?.iat),
            expiresAt: seconds(claims?.exp),
            fetchedAt: row.fetchedAt ? new Date(row.fetchedAt).toISOString() : null,
            lastError: row.lastError,
        };
    }

    /** The installation's document, as {@link view} answers it. */
    instanceView(now: Date = new Date()): Promise<EverPlatformEntitlementView | null> {
        return this.view(EVER_CONNECT_INSTANCE_ENTITLEMENT_SUBJECT, now);
    }

    /** A link ended: its document goes with it. */
    async forgetLink(platformLinkId: string | null): Promise<void> {
        if (!platformLinkId) return;
        await this.documents.delete({ subject: linkEntitlementSubject(platformLinkId) });
    }

    /** The connection ended: the documents were this connection's. The key set stays (public keys). */
    @OnEvent(EverConnectConnectionChangedEvent.EVENT_NAME, { async: true })
    async onConnectionChanged(event: EverConnectConnectionChangedEvent): Promise<void> {
        if (event.status !== 'disconnected' && event.status !== 'revoked') return;
        await this.documents
            .delete({ subject: Not(EVER_CONNECT_KEY_SET_SUBJECT) })
            .catch(() => undefined);
        this.failedAt.clear();
    }

    // -- internals --------------------------------------------------------------

    private async due(subject: string, now: Date): Promise<boolean> {
        const failed = this.failedAt.get(subject);
        if (failed !== undefined && now.getTime() - failed < ENTITLEMENT_RETRY_AFTER_MS) {
            return false;
        }
        const row = await this.documents.findOne({ where: { subject } });
        if (!row?.fetchedAt) return true;
        const after = this.claimsOf(row)?.ever?.refresh_after_s;
        const waitS =
            typeof after === 'number' && after >= 600 ? after : ENTITLEMENT_REFRESH_AFTER_S;
        return now.getTime() - new Date(row.fetchedAt).getTime() >= waitS * 1000;
    }

    private async refresh(
        subject: string,
        link: EverConnectLink | null,
        now: Date,
    ): Promise<EntitlementRefreshOutcome> {
        if (!this.isEnabled()) return 'not_connected';
        const connection = await this.connection.connection();
        const client = await this.connection.client();
        if (!client || connection.status !== 'active' || !connection.platformInstanceId) {
            return 'not_connected';
        }
        const stored = await this.documents.findOne({ where: { subject } });
        const cached =
            stored?.seq !== null && stored?.seq !== undefined
                ? { seq: Number(stored.seq), iat: Number(stored.issuedAt ?? 0) }
                : null;
        // Only a document that can still be read is worth a `304`.
        const readable = stored ? this.claimsOf(stored) !== null : false;

        let answer: Awaited<ReturnType<EverPlatformClient['instances']['entitlement']>>;
        try {
            const ifNoneMatch = readable ? cached?.seq : undefined;
            answer = link
                ? await client.instances.linkEntitlement(link.platformLinkId as string, ifNoneMatch)
                : await client.instances.entitlement(ifNoneMatch);
        } catch (error) {
            const failure = platformFailure(error);
            if (failure.kind === 'problem' && failure.code === 'credential_revoked') {
                await this.connection.ended('revoked');
                return 'not_connected';
            }
            const code =
                failure.kind === 'problem'
                    ? failure.code
                    : failure.kind === 'rate_limited'
                      ? 'rate_limited'
                      : failure.code;
            await this.failed(subject, code, now);
            return 'failed';
        }

        if ('notModified' in answer) {
            await this.documents.update({ subject }, { fetchedAt: now, lastError: null });
            this.failedAt.delete(subject);
            return 'unchanged';
        }

        let verified: VerifiedEntitlement;
        try {
            verified = await this.verify(
                client,
                answer.document,
                link ? subject : `instance:${connection.platformInstanceId}`,
                // A stored document that cannot be read any more is replaced by
                // the one Ever Platform serves now.
                readable ? cached : null,
                now,
            );
            if (link) assertBoundTo(verified, link);
        } catch (error) {
            const code = codeOf(error);
            // The same document again is not a refusal: it is what is stored.
            if (code === 'entitlement_stale' && cached && answer.seq === cached.seq) {
                await this.documents.update({ subject }, { fetchedAt: now, lastError: null });
                this.failedAt.delete(subject);
                return 'unchanged';
            }
            await this.failed(subject, code, now);
            this.logger.warn(`An entitlement document was not kept (${code})`);
            return 'refused';
        }

        const values = {
            document: this.secrets.encryptValue(verified.jws),
            seq: String(verified.seq),
            issuedAt: String(verified.claims.iat),
            expiresAt: String(verified.claims.exp),
            fetchedAt: now,
            lastError: null,
        };
        if (stored) await this.documents.update({ subject }, values);
        else {
            await this.documents
                .createQueryBuilder()
                .insert()
                .into(EverConnectEntitlement)
                .values({ subject, ...values })
                .orIgnore()
                .execute();
        }
        this.failedAt.delete(subject);
        const handle = verified.claims.ever.handle;
        if (link && handle && handle !== link.handle) {
            await this.links.update({ id: link.id }, { handle: handle.slice(0, 64) });
        }
        return 'stored';
    }

    /** Keep why a read was refused or failed; the stored document stays. */
    private async failed(subject: string, code: string, now: Date): Promise<void> {
        this.failedAt.set(subject, now.getTime());
        const lastError = code.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
        const existing = await this.documents.findOne({ where: { subject } });
        if (existing) {
            await this.documents.update({ subject }, { lastError });
            return;
        }
        await this.documents
            .createQueryBuilder()
            .insert()
            .into(EverConnectEntitlement)
            .values({ subject, lastError })
            .orIgnore()
            .execute();
    }

    /**
     * Verify a document with the SDK's verifier, which owns the rules of
     * refreshing the key set (an unknown key id, an expired manifest).
     */
    private async verify(
        client: EverPlatformClient,
        jws: string,
        subject: string,
        cached: { seq: number; iat: number } | null,
        now: Date,
    ): Promise<VerifiedEntitlement> {
        const nowS = Math.floor(now.getTime() / 1000);
        let keySet = await this.storedKeySet(client);
        if (!keySet || keySet.needsRefresh(nowS)) {
            const update = await client.keys.refresh(keySet ?? undefined);
            if (update.replaced || !keySet) await this.saveKeySet(update.keySet);
            keySet = update.keySet;
        }
        const result = await client.verifyEntitlementRefreshing(jws, {
            keySet,
            subject,
            cached,
            now: nowS,
        });
        if (result.keySet !== keySet) await this.saveKeySet(result.keySet);
        return result.verified;
    }

    /** The key set kept from an earlier read, verified again under the roots the client trusts. */
    private async storedKeySet(client: EverPlatformClient): Promise<KeySet | null> {
        const row = await this.documents.findOne({
            where: { subject: EVER_CONNECT_KEY_SET_SUBJECT },
        });
        if (!row?.document) return null;
        try {
            return KeySet.restore(JSON.parse(row.document), {
                issuer: client.issuer,
                unsafeRootKeys: client.keys.rootKeys(),
            });
        } catch {
            // Another issuer's, another root's or an unreadable one: read it again.
            return null;
        }
    }

    private async saveKeySet(keySet: KeySet): Promise<void> {
        const document = JSON.stringify(keySet.toJSON());
        const subject = EVER_CONNECT_KEY_SET_SUBJECT;
        const fetchedAt = new Date(keySet.fetchedAt * 1000);
        const updated = await this.documents.update({ subject }, { document, fetchedAt });
        if ((updated.affected ?? 0) > 0) return;
        await this.documents
            .createQueryBuilder()
            .insert()
            .into(EverConnectEntitlement)
            .values({ subject, document, fetchedAt })
            .orIgnore()
            .execute();
    }

    /** The claims of a stored document (verified before it was stored), or `null`. */
    private claimsOf(row: EverConnectEntitlement): Claims | null {
        if (!row.document) return null;
        try {
            return claimsOfVerifiedJws(this.secrets.decryptValue(row.document)) as Claims | null;
        } catch {
            return null;
        }
    }
}

/** A link's document must name the tenant the link belongs to here, when it names one. */
function assertBoundTo(verified: VerifiedEntitlement, link: EverConnectLink): void {
    const tenant = (verified.claims as unknown as Claims).ever?.tenant;
    if (tenant?.product_tenant_id && tenant.product_tenant_id !== link.tenantId) {
        throw Object.assign(new Error('The document names another tenant'), {
            code: 'tenant_mismatch',
        });
    }
}

function codeOf(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code) return code;
    const failure = platformFailure(error);
    return failure.kind === 'problem' || failure.kind === 'refused' || failure.kind === 'transient'
        ? failure.code
        : 'rate_limited';
}

function flags(value: Record<string, unknown> | undefined): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [key, flag] of Object.entries(value ?? {})) {
        if (typeof flag === 'boolean') out[key] = flag;
    }
    return out;
}

function numbers(value: Record<string, unknown> | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, limit] of Object.entries(value ?? {})) {
        if (typeof limit === 'number' && Number.isFinite(limit)) out[key] = limit;
    }
    return out;
}
