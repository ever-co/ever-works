import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, type Repository } from 'typeorm';
import type { EverPlatformAppSyncStatusView } from '@ever-works/contracts';
import {
    EVER_CONNECT_CONNECTION_ROW_ID,
    EverConnectConnection,
    EverConnectIntegration,
    EverConnectLink,
    EverConnectOutbox,
    Organization,
    Work,
    WorkDeployment,
} from '@ever-works/agent/entities';
import { PluginSettingsService } from '@ever-works/agent/plugins';
import {
    EverConnectIntegrationChangedEvent,
    EverConnectLinkChangedEvent,
} from '../ever-connect.events';
import {
    EverConnectExtensions,
    type EverConnectRoundParticipant,
} from '../ever-connect-extensions';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { EverConnectService } from '../ever-connect.service';
import { isAppSyncEnabled } from '../ever-connect.switches';
import { describeFailure, platformFailure } from '../identity/platform-answer';
import {
    type IntegrationHandler,
    IntegrationHandlerRegistry,
} from '../integrations/integration-handler.registry';
import {
    APP_SYNC_KEY,
    APP_SYNC_MIN_SCOPE_VERSION,
    APP_SYNC_OUTBOX_EVENT,
    appDelete,
    appUpsert,
    deploymentUpsert,
    isExternalId,
    type AppSyncOp,
} from './app-sync.mapping';

/** How many Works one pass sends (at most three operations each, under the batch limit of 500). */
export const APP_SYNC_PASS_WORKS = 150;
/** Between two full sends of the identifier set. */
export const APP_SYNC_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
/** After a reconciliation that could not finish, the next try waits this long. */
export const APP_SYNC_RECONCILE_RETRY_MS = 60 * 60_000;
/** The waits after a batch Ever Platform did not take: 30 seconds, 5 minutes, then an hour. */
export const APP_SYNC_RETRY_MS = [30_000, 5 * 60_000, 60 * 60_000] as const;
/** A Work whose report keeps failing is given up (shown to the operator) after this many tries. */
export const APP_SYNC_MAX_ATTEMPTS = 50;
/** Inventory pages read in one reconciliation (100 rows each). */
const INVENTORY_MAX_PAGES = 500;
const INVENTORY_PAGE = 100;
/** Rows written or read per statement. */
const CHUNK = 200;

/** A link the mirror runs for. */
interface EnabledLink {
    readonly organizationId: string;
    readonly tenantId: string;
    readonly platformLinkId: string;
    readonly productOrgRef: string;
}

/** One result of a batch, as Ever Platform answers it. */
interface OpResult {
    readonly outcome?: string;
    readonly code?: string | null;
}

let seqCounter = 0;
/** The write order of an outbox row (milliseconds × 1000 plus a counter). */
function nextSeq(): string {
    seqCounter = (seqCounter + 1) % 1000;
    return String(Date.now() * 1000 + seqCounter);
}

/**
 * The apps mirror: for an Organization linked to an Ever organization, with the
 * `app_sync` integration enabled for that link in app.ever.co, the identifiers
 * and status of its Works and of their current deployments are sent to Ever
 * Platform (`POST /v1/instances/me/mirror/apps`), which lists them on the
 * organization's Apps page. Ever Works stays the source of truth: Ever Platform
 * never writes back.
 *
 * - **Outbox.** A change to a Work or to one of its deployments writes one row
 *   to `ever_connect_outbox` (`app_sync:<work id>`): the Work's id, nothing of
 *   it. A second change before the row is sent moves the same row.
 * - **Worker.** Each round of the Ever Connect worker (the replica holding the
 *   lease) reads the rows that are due, builds each Work's operations from its
 *   row as it is NOW ({@link app-sync.mapping}), and sends one batch. Every
 *   operation carries a version that only grows, so sending one again changes
 *   nothing. A Work that no longer exists is sent as a delete.
 * - **Reconciliation.** Once a day, and when the integration turns on for a
 *   link, every Work of every enabled link is queued again, and what Ever
 *   Platform holds (`GET /v1/instances/me/mirror/apps`) is read: a row it holds
 *   for a Work that is gone is deleted there. Nothing is ever deleted here.
 *
 * Nothing is queued or sent unless `EVER_CONNECT_APP_SYNC_ENABLED=true`, the
 * installation is connected, and the link's consent is at the scope version
 * that lists what the mirror sends ({@link APP_SYNC_MIN_SCOPE_VERSION}).
 */
@Injectable()
export class AppSyncService
    implements OnModuleInit, EverConnectRoundParticipant, IntegrationHandler
{
    readonly key = APP_SYNC_KEY;
    readonly name = 'apps mirror';
    private readonly logger = new Logger(AppSyncService.name);
    private lastVersion = 0;
    private reconcileRetryAt = 0;
    /** The lowest consent scope version a link must have (a parameter for tests only). */
    minScopeVersion = APP_SYNC_MIN_SCOPE_VERSION;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly connection: EverConnectService,
        private readonly integrations: EverConnectIntegrationService,
        @Optional() private readonly registry?: IntegrationHandlerRegistry,
        @Optional() private readonly extensions?: EverConnectExtensions,
        @Optional() private readonly moduleRef?: ModuleRef,
    ) {}

    onModuleInit(): void {
        if (!isAppSyncEnabled()) return;
        // With a handler, the integration's state is kept for each tenant link.
        this.registry?.register(this);
        this.extensions?.addRoundParticipant(this);
        this.extensions?.provideAppSyncStatus(() => this.status());
    }

    private get outbox(): Repository<EverConnectOutbox> {
        return this.dataSource.getRepository(EverConnectOutbox);
    }

    // -- which links -----------------------------------------------------------

    /**
     * The links the mirror runs for, by Organization: an active link Ever
     * Platform knows, with `app_sync` enabled at a current scope. Empty while
     * the switch is off or the installation is not connected.
     */
    async enabledLinks(): Promise<Map<string, EnabledLink>> {
        const out = new Map<string, EnabledLink>();
        if (!isAppSyncEnabled()) return out;
        const connection = await this.connection.connection();
        if (connection.status !== 'active' || !connection.platformInstanceId) return out;

        const states = await this.dataSource
            .getRepository(EverConnectIntegration)
            .find({ where: { integrationKey: APP_SYNC_KEY, enabled: true } });
        const consented = new Set(
            states
                .filter(
                    (state) =>
                        state.linkId !== '' && (state.scopeVersion ?? 0) >= this.minScopeVersion,
                )
                .map((state) => state.linkId),
        );
        if (consented.size === 0) return out;

        const links = await this.dataSource
            .getRepository(EverConnectLink)
            .find({ where: { status: 'active', platformLinkId: In([...consented]) } });
        const withoutRef = links.filter((link) => !link.productOrgRef).map((l) => l.organizationId);
        const slugs = new Map<string, string>();
        for (let at = 0; at < withoutRef.length; at += CHUNK) {
            const rows = await this.dataSource
                .getRepository(Organization)
                .createQueryBuilder('organization')
                .select(['organization.id', 'organization.slug'])
                .where('organization.id IN (:...ids)', { ids: withoutRef.slice(at, at + CHUNK) })
                .getMany();
            for (const row of rows) slugs.set(row.id, row.slug);
        }
        for (const link of links) {
            const productOrgRef = link.productOrgRef ?? slugs.get(link.organizationId);
            if (!link.platformLinkId || !productOrgRef) continue;
            out.set(link.organizationId, {
                organizationId: link.organizationId,
                tenantId: link.tenantId,
                platformLinkId: link.platformLinkId,
                productOrgRef,
            });
        }
        return out;
    }

    // -- the outbox ------------------------------------------------------------

    /**
     * A Work changed (or was removed): queue its mirror row, when its
     * Organization is one the mirror runs for. `organizationId` is needed only
     * for a Work that no longer exists. Never throws.
     */
    async workChanged(workId: string, organizationId?: string | null): Promise<void> {
        try {
            if (!isAppSyncEnabled() || !isExternalId(workId)) return;
            let organization = organizationId ?? null;
            if (!organization) {
                const work = await this.dataSource
                    .getRepository(Work)
                    .createQueryBuilder('work')
                    .select(['work.id', 'work.organizationId'])
                    .where('work.id = :id', { id: workId })
                    .getOne();
                organization = work?.organizationId ?? null;
            }
            if (!organization) return;
            if (!(await this.enabledLinks()).has(organization)) return;
            await this.enqueue([workId], organization);
        } catch (error) {
            this.logger.warn(
                `A Work's mirror row was not queued (${error instanceof Error ? error.name : 'unknown'}); the next reconciliation sends it.`,
            );
        }
    }

    /** Queue rows for Works of one Organization (`null`: Works that no longer exist). */
    private async enqueue(
        workIds: readonly string[],
        organizationId: string | null,
    ): Promise<void> {
        const now = new Date();
        for (let at = 0; at < workIds.length; at += CHUNK) {
            const ids = workIds.slice(at, at + CHUNK).filter(isExternalId);
            if (ids.length === 0) continue;
            await this.outbox
                .createQueryBuilder()
                .insert()
                .into(EverConnectOutbox)
                .values(
                    ids.map((workId) => ({
                        event: APP_SYNC_OUTBOX_EVENT,
                        payload: { workId } as Record<string, unknown>,
                        dedupeKey: dedupeKey(workId),
                        seq: nextSeq(),
                        accountRef: organizationId,
                        state: 'pending' as const,
                        attempts: 0,
                        nextAttemptAt: now,
                    })),
                )
                .orIgnore()
                .execute();
            // A row that existed is moved: a pass that read it before this change
            // does not remove it, and a row given up is tried again.
            await this.outbox.update(
                { event: APP_SYNC_OUTBOX_EVENT, dedupeKey: In(ids.map(dedupeKey)) },
                {
                    seq: nextSeq(),
                    state: 'pending',
                    attempts: 0,
                    nextAttemptAt: now,
                    lastError: null,
                    accountRef: organizationId,
                },
            );
        }
    }

    // -- the worker's round ------------------------------------------------------

    async round(now: Date = new Date()): Promise<void> {
        if (!isAppSyncEnabled()) return;
        const connection = await this.connection.connection();
        if (connection.status !== 'active' || !connection.platformInstanceId) return;
        await this.reconcileIfDue(now);
        await this.drainOnce(now);
    }

    /**
     * One pass: the rows that are due, as one batch. Returns how many Works were
     * reported (applied, or already current).
     */
    async drainOnce(now: Date = new Date()): Promise<number> {
        if (!isAppSyncEnabled()) return 0;
        const rows = await this.outbox.find({
            where: {
                event: APP_SYNC_OUTBOX_EVENT,
                state: 'pending',
                nextAttemptAt: LessThanOrEqual(now),
            },
            order: { seq: 'ASC', createdAt: 'ASC' },
            take: APP_SYNC_PASS_WORKS,
        });
        if (rows.length === 0) return 0;
        const client = await this.connection.client();
        if (!client) return 0;
        const links = await this.enabledLinks();

        const workIds = rows.map((row) => String(row.payload?.workId ?? ''));
        const works = await this.readWorks(workIds);
        const deployments = await this.currentDeployments([...works.keys()]);

        const ops: AppSyncOp[] = [];
        /** For each row: the indexes of its operations, or why it has none. */
        const plan: Array<{ row: EverConnectOutbox; indexes: number[] }> = [];
        for (const row of rows) {
            const workId = String(row.payload?.workId ?? '');
            const work = works.get(workId);
            const built: AppSyncOp[] = [];
            if (!work) {
                // Gone here: deleted there, while its Organization's link still runs
                // (a row queued by a reconciliation names no Organization).
                const allowed =
                    links.size > 0 && (row.accountRef === null || links.has(row.accountRef));
                const op = allowed ? appDelete(workId, this.nextVersion(now), now) : null;
                if (op) built.push(op);
            } else {
                const link = work.organizationId ? links.get(work.organizationId) : undefined;
                const app = link ? appUpsert(work, link, this.nextVersion(now), now) : null;
                if (app) {
                    built.push(app);
                    for (const deployment of deployments.get(work.id) ?? []) {
                        const clusterSource =
                            deployment.provider === 'k8s' && !deployment.appTarget
                                ? await this.clusterSource(work)
                                : null;
                        const op = deploymentUpsert(
                            deployment,
                            this.nextVersion(now),
                            now,
                            clusterSource,
                        );
                        if (op) built.push(op);
                    }
                }
            }
            if (built.length === 0) {
                // Nothing of it may move (its link ended, or it cannot be told in
                // the contract's words): the row is not owed any more.
                await this.outbox.delete({ id: row.id, seq: row.seq });
                continue;
            }
            plan.push({ row, indexes: built.map((_, i) => ops.length + i) });
            ops.push(...built);
        }
        if (ops.length === 0) return 0;

        let results: readonly OpResult[];
        try {
            const answer = await client.instances.mirrorApps.push({ ops } as Parameters<
                typeof client.instances.mirrorApps.push
            >[0]);
            results = answer.results as readonly OpResult[];
        } catch (error) {
            await this.batchFailed(
                plan.map((entry) => entry.row),
                error,
                now,
            );
            return 0;
        }

        let reported = 0;
        let refresh = false;
        for (const { row, indexes } of plan) {
            const outcomes = indexes.map((index) => results[index] ?? {});
            const rejected = outcomes.filter((result) => result.outcome === 'rejected');
            if (outcomes.some((result) => !result.outcome)) {
                // An answer without this operation: sent again.
                await this.retry(row, 'no_result', now);
            } else if (rejected.length === 0) {
                reported += 1;
                await this.outbox.delete({ id: row.id, seq: row.seq });
            } else {
                const code = rejected[0].code ?? 'rejected';
                if (code === 'unlinked_org' || code === 'integration_disabled') {
                    // Ever Platform ended the link or the consent: nothing is owed,
                    // and the states are read again.
                    refresh = true;
                    await this.outbox.delete({ id: row.id, seq: row.seq });
                } else if (code === 'unknown_app') {
                    await this.retry(row, code, now);
                } else {
                    await this.giveUp(row, code);
                }
            }
        }
        if (refresh) await this.integrations.refresh().catch(() => undefined);
        if (reported > 0) this.logger.debug(`Reported ${reported} Work(s) to the apps mirror`);
        return reported;
    }

    /** A batch Ever Platform did not take: every row of it waits, or is given up. */
    private async batchFailed(
        rows: readonly EverConnectOutbox[],
        error: unknown,
        now: Date,
    ): Promise<void> {
        const failure = platformFailure(error);
        this.logger.warn(`An apps mirror batch was not taken: ${describeFailure(failure)}`);
        if (failure.kind === 'problem' && failure.code === 'credential_revoked') {
            await this.connection.ended('revoked');
            return;
        }
        if (failure.kind === 'problem' && failure.status === 403) {
            // No link has the integration any more: read the states again; the
            // next pass drops what is not owed.
            await this.integrations.refresh().catch(() => undefined);
        }
        const final =
            failure.kind === 'refused' ||
            (failure.kind === 'problem' && (failure.status === 422 || failure.status === 413));
        const code =
            failure.kind === 'rate_limited'
                ? 'rate_limited'
                : failure.kind === 'problem'
                  ? failure.code
                  : failure.code;
        const waitMs = failure.kind === 'rate_limited' ? failure.retryAfterS * 1000 : undefined;
        for (const row of rows) {
            if (final) await this.giveUp(row, code);
            else await this.retry(row, code, now, waitMs);
        }
    }

    private async retry(
        row: EverConnectOutbox,
        code: string,
        now: Date,
        waitMs?: number,
    ): Promise<void> {
        const attempts = row.attempts + 1;
        if (attempts >= APP_SYNC_MAX_ATTEMPTS) {
            await this.giveUp(row, code);
            return;
        }
        const wait = waitMs ?? APP_SYNC_RETRY_MS[Math.min(attempts, APP_SYNC_RETRY_MS.length) - 1];
        // Only while the row is as it was read: a change meanwhile is due now.
        await this.outbox.update(
            { id: row.id, seq: row.seq },
            {
                attempts,
                nextAttemptAt: new Date(now.getTime() + Math.max(wait, APP_SYNC_RETRY_MS[0])),
                lastError: errorCode(code),
            },
        );
    }

    /** Refused for good: kept as `failed` for the operator; the next change of the Work tries again. */
    private async giveUp(row: EverConnectOutbox, code: string): Promise<void> {
        await this.outbox.update(
            { id: row.id, seq: row.seq },
            { state: 'failed', attempts: row.attempts + 1, lastError: errorCode(code) },
        );
    }

    // -- reconciliation ----------------------------------------------------------

    /** Send the full identifier set again when a day has passed (or it was asked for). */
    async reconcileIfDue(now: Date = new Date()): Promise<boolean> {
        if (!isAppSyncEnabled()) return false;
        if (now.getTime() < this.reconcileRetryAt) return false;
        const connection = await this.connection.connection();
        const last = connection.appSyncReconciledAt
            ? new Date(connection.appSyncReconciledAt).getTime()
            : null;
        if (last !== null && now.getTime() - last < APP_SYNC_RECONCILE_INTERVAL_MS) return false;
        return this.reconcile(now);
    }

    /**
     * Queue every Work of every enabled link, and a delete for every app Ever
     * Platform holds whose Work is gone here. `true` when it finished.
     */
    async reconcile(now: Date = new Date()): Promise<boolean> {
        if (!isAppSyncEnabled()) return false;
        const client = await this.connection.client();
        const links = await this.enabledLinks();
        if (!client || links.size === 0) {
            // Nothing runs: nothing to send again. Looked at again tomorrow, or as
            // soon as the integration turns on for a link.
            await this.markReconciled(now);
            return true;
        }
        try {
            const works = this.dataSource.getRepository(Work);
            for (const link of links.values()) {
                const rows = await works
                    .createQueryBuilder('work')
                    .select(['work.id'])
                    .where('work.organizationId = :organizationId', {
                        organizationId: link.organizationId,
                    })
                    .getMany();
                await this.enqueue(
                    rows.map((row) => row.id),
                    link.organizationId,
                );
            }

            const byLink = new Map([...links.values()].map((l) => [l.platformLinkId, l]));
            let cursor: string | undefined;
            for (let page = 0; page < INVENTORY_MAX_PAGES; page += 1) {
                const answer = (await client.instances.mirrorApps.list(cursor, INVENTORY_PAGE)) as {
                    items?: ReadonlyArray<{
                        external_id: string;
                        kind: string;
                        org_link_id?: string | null;
                    }>;
                    next_cursor?: string | null;
                };
                const apps = (answer.items ?? []).filter(
                    (item) => item.kind === 'app' && isExternalId(item.external_id),
                );
                const existing = await this.readWorks(apps.map((item) => item.external_id));
                for (const item of apps) {
                    if (existing.has(item.external_id)) continue;
                    const link = item.org_link_id ? byLink.get(item.org_link_id) : undefined;
                    // Held under a link the mirror no longer runs for: Ever Platform
                    // ends those rows itself.
                    if (item.org_link_id && !link) continue;
                    await this.enqueue([item.external_id], link?.organizationId ?? null);
                }
                if (!answer.next_cursor) break;
                cursor = answer.next_cursor;
            }
        } catch (error) {
            const failure = platformFailure(error);
            if (failure.kind === 'problem' && failure.code === 'credential_revoked') {
                await this.connection.ended('revoked');
                return false;
            }
            this.reconcileRetryAt = now.getTime() + APP_SYNC_RECONCILE_RETRY_MS;
            this.logger.warn(
                `The apps mirror could not be reconciled: ${describeFailure(failure)}`,
            );
            return false;
        }
        await this.markReconciled(now);
        return true;
    }

    private async markReconciled(now: Date | null): Promise<void> {
        await this.dataSource
            .getRepository(EverConnectConnection)
            .update({ id: EVER_CONNECT_CONNECTION_ROW_ID }, { appSyncReconciledAt: now });
    }

    // -- what turns it on and off ---------------------------------------------

    /** The integration turned on for a link: its Works are sent now. Off: nothing is owed. */
    @OnEvent(EverConnectIntegrationChangedEvent.EVENT_NAME, { async: true })
    async onIntegrationChanged(event: EverConnectIntegrationChangedEvent): Promise<void> {
        if (event.integrationKey !== APP_SYNC_KEY || !event.linkId || !isAppSyncEnabled()) return;
        try {
            if (event.enabled) {
                this.reconcileRetryAt = 0;
                await this.markReconciled(null);
                return;
            }
            const link = await this.dataSource
                .getRepository(EverConnectLink)
                .findOne({ where: { platformLinkId: event.linkId } });
            if (link) await this.dropOwed(link.organizationId);
        } catch (error) {
            this.logger.warn(
                `app_sync change not handled (${error instanceof Error ? error.name : 'unknown'})`,
            );
        }
    }

    /** A link ended: what was owed for its Organization is dropped. */
    @OnEvent(EverConnectLinkChangedEvent.EVENT_NAME, { async: true })
    async onLinkChanged(event: EverConnectLinkChangedEvent): Promise<void> {
        if (event.change !== 'unlinked' || !isAppSyncEnabled()) return;
        await this.dropOwed(event.organizationId).catch(() => undefined);
    }

    /** `IntegrationHandler`: the integration is off; nothing may move. */
    async onDisabled(): Promise<void> {
        await this.outbox
            .delete({ event: APP_SYNC_OUTBOX_EVENT, state: In(['pending', 'failed']) })
            .catch(() => undefined);
    }

    private async dropOwed(organizationId: string): Promise<void> {
        await this.outbox.delete({
            event: APP_SYNC_OUTBOX_EVENT,
            accountRef: organizationId,
            state: In(['pending', 'failed']),
        });
    }

    // -- for the operator --------------------------------------------------------

    async status(): Promise<EverPlatformAppSyncStatusView | null> {
        if (!isAppSyncEnabled()) return null;
        const pending = await this.outbox.count({
            where: { event: APP_SYNC_OUTBOX_EVENT, state: 'pending' },
        });
        const failed = await this.outbox.count({
            where: { event: APP_SYNC_OUTBOX_EVENT, state: 'failed' },
        });
        const last = await this.outbox.findOne({
            where: { event: APP_SYNC_OUTBOX_EVENT, state: In(['pending', 'failed']) },
            order: { updatedAt: 'DESC' },
        });
        const connection = await this.connection.connection();
        return {
            linksEnabled: (await this.enabledLinks()).size,
            pending,
            failed,
            lastError: last?.lastError ?? null,
            reconciledAt: connection.appSyncReconciledAt
                ? new Date(connection.appSyncReconciledAt).toISOString()
                : null,
        };
    }

    // -- reads -------------------------------------------------------------------

    /** The columns the mirror reads of the Works that exist, by id. */
    private async readWorks(ids: readonly string[]): Promise<Map<string, Work>> {
        const out = new Map<string, Work>();
        const wanted = [...new Set(ids.filter(isUuid))];
        for (let at = 0; at < wanted.length; at += CHUNK) {
            const rows = await this.dataSource
                .getRepository(Work)
                .createQueryBuilder('work')
                .select([
                    'work.id',
                    'work.name',
                    'work.slug',
                    'work.kind',
                    'work.status',
                    'work.userId',
                    'work.organizationId',
                    'work.updatedAt',
                ])
                .where('work.id IN (:...ids)', { ids: wanted.slice(at, at + CHUNK) })
                .getMany();
            for (const row of rows) out.set(row.id, row);
        }
        return out;
    }

    /** Each Work's current deployment per environment: its newest row. */
    private async currentDeployments(
        workIds: readonly string[],
    ): Promise<Map<string, WorkDeployment[]>> {
        const out = new Map<string, WorkDeployment[]>();
        for (let at = 0; at < workIds.length; at += CHUNK) {
            const rows = await this.dataSource
                .getRepository(WorkDeployment)
                .createQueryBuilder('deployment')
                .select([
                    'deployment.id',
                    'deployment.workId',
                    'deployment.environment',
                    'deployment.provider',
                    'deployment.appTarget',
                    'deployment.state',
                    'deployment.website',
                    'deployment.createdAt',
                    'deployment.updatedAt',
                ])
                .where('deployment.workId IN (:...ids)', { ids: workIds.slice(at, at + CHUNK) })
                .orderBy('deployment.createdAt', 'DESC')
                .addOrderBy('deployment.id', 'DESC')
                .getMany();
            const seen = new Set<string>();
            for (const row of rows) {
                const environment = row.environment === 'preview' ? 'preview' : 'production';
                const slot = `${row.workId}:${environment}`;
                if (seen.has(slot)) continue;
                seen.add(slot);
                out.set(row.workId, [...(out.get(row.workId) ?? []), row]);
            }
        }
        return out;
    }

    /**
     * Which cluster a site on Kubernetes deploys to: the Kubernetes plugin's
     * setting for the Work (a word, never a kubeconfig: secrets are not read).
     * `null` when it cannot be read here.
     */
    private async clusterSource(work: Pick<Work, 'id' | 'userId'>): Promise<string | null> {
        try {
            const settings = this.moduleRef?.get(PluginSettingsService, { strict: false });
            if (!settings) return null;
            const resolved = (await settings.getResolvedSettings('k8s', {
                userId: work.userId,
                workId: work.id,
                includeSecrets: false,
            })) as Record<string, { value?: unknown } | undefined>;
            const value = resolved.clusterSource?.value;
            return typeof value === 'string' ? value : null;
        } catch {
            return null;
        }
    }

    /** A version that only grows: the clock, or one more than the last one given. */
    private nextVersion(now: Date): number {
        this.lastVersion = Math.max(now.getTime(), Date.now(), this.lastVersion + 1);
        return this.lastVersion;
    }
}

function dedupeKey(workId: string): string {
    return `${APP_SYNC_OUTBOX_EVENT}:${workId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Work id: anything else never reaches a `uuid` column comparison. */
function isUuid(value: string): boolean {
    return UUID.test(value);
}

function errorCode(code: string): string {
    return code.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'unknown';
}
