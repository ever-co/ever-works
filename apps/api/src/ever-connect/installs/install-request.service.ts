import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, type Repository } from 'typeorm';
import { EverConnectInstallRequest, User } from '@ever-works/agent/entities';
import {
    EVER_INSTALLS_INTEGRATION_KEY,
    isInstallFeedEventType,
    parseInstallFeedMessage,
    type EverPluginInstallRequest,
} from '@ever-works/contracts';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { EverConnectService } from '../ever-connect.service';
import { PluginInstallerBridge } from './plugin-installer.bridge';

/** One event of the installation's feed. */
export interface InstallFeedEvent {
    readonly id: string;
    readonly type: string;
    readonly data: unknown;
}

/** What one install message did here (for the feed's log and the specs). */
export type InstallFeedOutcome =
    | 'requested'
    | 'repeated'
    | 'withdrawn'
    | 'remove_noticed'
    | 'ignored'
    | 'rejected'
    | 'integration_not_enabled';

/** A tenant link id as Ever Platform issues it (a ULID). */
const LINK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Install requests from apps.ever.co, as the installation's feed delivers
 * them (`marketplace_installs`). It keeps the request and tells the platform
 * admins; it installs nothing, calls no installer and never touches the plugin
 * allow-list: a platform admin answers in the product
 * ({@link InstallApprovalService}).
 *
 * - A plugin request: one row per install id (a request delivered again is a
 *   no-op), and one in-app notice per platform admin.
 * - A request withdrawn before it was answered: the row is `withdrawn` and the
 *   notices are taken back; nothing is reported.
 * - A removal asked for: a notice only; nothing is uninstalled here.
 * - Any other state of an install is an echo of a report, or a step on Ever
 *   Platform's side: nothing to do.
 *
 * A message that is not well formed is refused with the path of the field at
 * fault and nothing of it is kept. While `marketplace_installs` is not enabled
 * for one of the installation's tenant links, every message is ignored.
 * Logged lines carry ids and fixed codes only.
 */
@Injectable()
export class InstallRequestService {
    private readonly logger = new Logger(InstallRequestService.name);

    constructor(
        @InjectRepository(EverConnectInstallRequest)
        private readonly requests: Repository<EverConnectInstallRequest>,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly connection: EverConnectService,
        private readonly integrations: EverConnectIntegrationService,
        private readonly bridge: PluginInstallerBridge,
    ) {}

    /** Whether an event of this type is an install message. */
    handles(type: string): boolean {
        return isInstallFeedEventType(type);
    }

    /** Handle one install message of the feed. Throws only when the database fails (the event is read again). */
    async handle(event: InstallFeedEvent): Promise<InstallFeedOutcome> {
        if (!(await this.integrations.enabledForAnyLink(EVER_INSTALLS_INTEGRATION_KEY))) {
            this.logger.warn(`install_request.ignored ${event.id} (integration_not_enabled)`);
            return 'integration_not_enabled';
        }
        const message = parseInstallFeedMessage(event.type, event.data);
        switch (message.kind) {
            case 'rejected':
                this.logger.warn(
                    `install_request.rejected ${event.id} ${message.path} (${message.code})`,
                );
                return 'rejected';
            case 'other_mechanism':
                // A blueprint or a product install: another handler's, none here yet.
                return 'ignored';
            case 'state':
                return 'ignored';
            case 'requested':
                return this.received(message.request);
            case 'withdrawn':
                return this.withdrawn(message.installId);
            case 'remove_requested':
                return this.removeRequested(message.installId);
        }
    }

    private async received(request: EverPluginInstallRequest): Promise<InstallFeedOutcome> {
        const self = (await this.connection.connection()).platformInstanceId;
        if (request.instanceId && self && request.instanceId !== self) {
            this.logger.warn(`install_request.ignored ${request.installId} (another_installation)`);
            return 'ignored';
        }
        if (await this.requests.findOne({ where: { installId: request.installId } })) {
            return 'repeated';
        }
        const linkId = await this.linkFor(request.orgId);
        const source = request.source;
        try {
            await this.requests.insert({
                installId: request.installId,
                listingSlug: request.listingSlug,
                sourceKind: source.kind,
                registry: source.kind === 'registry' ? source.registry : null,
                packageName: source.kind === 'registry' ? source.packageName : null,
                sourceRepo: source.kind === 'repo' ? source.repo : null,
                sourceSha: source.kind === 'repo' ? source.sha : null,
                version: request.version,
                versionIsExact: request.versionIsExact,
                integrity: request.integrity,
                editionKey: request.editionKey,
                everOrgId: request.orgId,
                linkId,
                state: 'requested',
                receivedAt: new Date(),
            });
        } catch (error) {
            // Another replica stored it first: its notices stand.
            if (
                error instanceof QueryFailedError &&
                (await this.requests.findOne({ where: { installId: request.installId } }))
            ) {
                return 'repeated';
            }
            throw error;
        }
        this.logger.log(`install_request.received ${request.installId}`);
        await this.notifyAdmins(request.installId, request.listingSlug, 'install');
        return 'requested';
    }

    private async withdrawn(installId: string): Promise<InstallFeedOutcome> {
        const result = await this.requests.update(
            { installId, state: 'requested' },
            { state: 'withdrawn', reportState: null, nextReportAt: null },
        );
        if (!result.affected) return 'ignored';
        this.logger.log(`install_request.withdrawn ${installId}`);
        await this.clearNotices(installId);
        return 'withdrawn';
    }

    private async removeRequested(installId: string): Promise<InstallFeedOutcome> {
        const row = await this.requests.findOne({ where: { installId } });
        // Only an install that went through here; `removed` is our own report's echo.
        if (!row || !['installing', 'installed'].includes(row.state) || row.removalRequestedAt) {
            return 'ignored';
        }
        await this.requests.update({ installId }, { removalRequestedAt: new Date() });
        this.logger.log(`install_request.remove_requested ${installId}`);
        await this.notifyAdmins(installId, row.listingSlug, 'remove');
        return 'remove_noticed';
    }

    /**
     * The tenant link the request's reports go under: the one link with
     * `marketplace_installs` enabled, or, with several, the one of the Ever
     * organization that asked (read from Ever Platform's view of this
     * installation).
     */
    private async linkFor(orgId: string | null): Promise<string | null> {
        const enabled = (await this.integrations.linkStates(EVER_INSTALLS_INTEGRATION_KEY))
            .filter((link) => link.enabled)
            .map((link) => link.linkId);
        if (enabled.length <= 1 || !orgId) return enabled[0] ?? null;
        try {
            const client = await this.connection.client();
            const self = client ? await client.instances.self() : null;
            const match = (self?.tenant_links ?? []).find(
                (link) =>
                    link.org_id === orgId &&
                    enabled.includes(link.id) &&
                    !link.unlinked_at &&
                    LINK_ID.test(link.id),
            );
            return match?.id ?? enabled[0];
        } catch {
            return enabled[0];
        }
    }

    /** One in-app notice per platform admin (deduplicated per request and kind). */
    async notifyAdmins(
        installId: string,
        listingSlug: string,
        kind: 'install' | 'remove',
    ): Promise<void> {
        const notifications = this.bridge.notifications;
        if (!notifications) return;
        for (const userId of await this.platformAdmins()) {
            await notifications
                .notifyEverPlatformInstallRequest({ userId, installId, listingSlug, kind })
                .catch(() => this.logger.warn(`install_request.notice_failed ${installId}`));
        }
    }

    /** Take back the notices of a request (withdrawn or answered). */
    async clearNotices(installId: string): Promise<void> {
        const notifications = this.bridge.notifications;
        if (!notifications) return;
        for (const userId of await this.platformAdmins()) {
            await notifications
                .clearEverPlatformInstallRequest(userId, installId)
                .catch(() => undefined);
        }
    }

    private async platformAdmins(): Promise<string[]> {
        const admins = await this.dataSource.getRepository(User).find({
            select: { id: true },
            where: { isPlatformAdmin: true },
        });
        return admins.map((admin) => admin.id);
    }

    /** The open requests first (newest first), then the recent answered ones. */
    async list(limit = 50): Promise<EverConnectInstallRequest[]> {
        const open = await this.requests.find({
            where: { state: In(['requested', 'installing']) },
            order: { receivedAt: 'DESC' },
        });
        const answered = await this.requests.find({
            where: { state: In(['installed', 'failed', 'declined', 'withdrawn', 'removed']) },
            order: { updatedAt: 'DESC' },
            take: limit,
        });
        return [...open, ...answered];
    }

    find(installId: string): Promise<EverConnectInstallRequest | null> {
        return this.requests.findOne({ where: { installId } });
    }
}
