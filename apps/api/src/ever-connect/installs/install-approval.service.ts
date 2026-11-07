import {
    ConflictException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    ActivityActionType,
    ActivityStatus,
    EverConnectInstallRequest,
} from '@ever-works/agent/entities';
import {
    EVER_INSTALLS_INTEGRATION_KEY,
    type EverInstallDetailToken,
    type EverInstallNotInstallableReason,
    type EverInstallRequestView,
    type EverInstallRequestsView,
} from '@ever-works/contracts';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { InstallRequestService } from './install-request.service';
import { InstallStatusReporter } from './install-status-reporter.service';
import { type BridgeAllowlistState, PluginInstallerBridge } from './plugin-installer.bridge';

/** Why a request cannot be installed on this installation, whatever the admin answers. */
export type NotInstallableReason = EverInstallNotInstallableReason;

/** What the operator sees of one request. */
export type InstallRequestView = EverInstallRequestView;

/** `GET /api/ever-connect/install-requests`. */
export type InstallRequestsView = EverInstallRequestsView;

/**
 * A platform admin's answer to an install request, in their own session.
 *
 * Approve runs Works' dynamic plugin installer through the same path as
 * `POST /api/plugins/:pluginId/install` (allow-list, registry integrity, then
 * registration), for the package, version and integrity the request declared
 * and nothing else:
 *
 * - refused `409 not_open` unless the request is open, and `409
 *   integration_not_enabled` unless `marketplace_installs` is still enabled for
 *   the request's tenant link;
 * - refused `422 installer_disabled` unless `PLUGIN_DISTRIBUTION_MODE=dynamic`;
 * - refused `422 not_installable` when the source is not an npm package or no
 *   plugin of this installation is known by that package;
 * - refused `422 package_not_allowlisted` when the package is not on the
 *   plugin allow-list and the admin did not tick "add it"; the request and the
 *   allow-list stay as they are. With the tick, the package is appended
 *   through the allow-list repository (pinned to the declared version and
 *   integrity) and the admin's Activity records it. A disabled allow-list
 *   entry is the operator's choice: `422 package_allowlist_disabled`.
 *
 * Then the request is `installing` (reported), the installer runs, and the
 * request is `installed` (reported with the plugin id) or `failed` with a
 * fixed token: `checksum_mismatch` (the integrity differs; what was placed is
 * taken back), `permission_denied` (the allow-list refused at install time),
 * `incompatible_version` (the package is not this plugin, or not a plugin of
 * this version of Works) or `unknown`. Free text stays in Works' logs.
 *
 * Decline reports `failed` with `permission_denied` (`installer_disabled` when
 * dynamic installs are off here, `incompatible_version` when the request
 * cannot be installed here).
 */
@Injectable()
export class InstallApprovalService {
    private readonly logger = new Logger(InstallApprovalService.name);

    constructor(
        @InjectRepository(EverConnectInstallRequest)
        private readonly requests: Repository<EverConnectInstallRequest>,
        private readonly feed: InstallRequestService,
        private readonly reporter: InstallStatusReporter,
        private readonly bridge: PluginInstallerBridge,
        private readonly integrations: EverConnectIntegrationService,
        private readonly activity: ActivityLogService,
    ) {}

    async view(): Promise<InstallRequestsView> {
        const rows = await this.feed.list();
        const requests: InstallRequestView[] = [];
        for (const row of rows) {
            const open = row.state === 'requested';
            requests.push(
                toView(row, {
                    allowlist:
                        open && row.packageName
                            ? await this.bridge.allowlistState(row.packageName)
                            : null,
                    notInstallable: open ? await this.notInstallable(row) : null,
                }),
            );
        }
        return {
            installerEnabled: this.bridge.dynamicInstallsEnabled(),
            integrationEnabled: await this.integrations.enabledForAnyLink(
                EVER_INSTALLS_INTEGRATION_KEY,
            ),
            requests,
        };
    }

    async approve(
        installId: string,
        userId: string,
        options: { addToAllowlist?: boolean },
    ): Promise<InstallRequestView> {
        const row = await this.open(installId);
        if (!(await this.linkEnabled(row.linkId))) {
            throw new ConflictException({
                code: 'integration_not_enabled',
                message:
                    'Install requests from apps.ever.co are not enabled for this installation.',
            });
        }
        if (!this.bridge.dynamicInstallsEnabled()) {
            throw new UnprocessableEntityException({
                code: 'installer_disabled',
                message: 'Dynamic plugin installs are turned off on this installation.',
            });
        }
        const reason = await this.notInstallable(row);
        const pluginId = reason ? null : await this.bridge.pluginIdOf(row.packageName as string);
        if (reason || !pluginId) {
            throw new UnprocessableEntityException({
                code: 'not_installable',
                message: 'This request cannot be installed on this installation.',
            });
        }
        const packageName = row.packageName as string;
        const allowlist = await this.bridge.allowlistState(packageName);
        let allowlistAdded = false;
        if (allowlist === 'disabled') {
            throw new UnprocessableEntityException({
                code: 'package_allowlist_disabled',
                message: 'The package is on the plugin allow-list but disabled there.',
            });
        }
        if (allowlist === 'absent') {
            if (options.addToAllowlist !== true) {
                throw new UnprocessableEntityException({
                    code: 'package_not_allowlisted',
                    message: 'The package is not on the plugin allow-list.',
                });
            }
            await this.bridge.addToAllowlist({
                packageName,
                versionRange: row.version ?? '*',
                integrity: row.integrity,
            });
            allowlistAdded = true;
            await this.record(userId, {
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action: 'ever_connect.install_request.allowlist_added',
                status: ActivityStatus.COMPLETED,
                summary: `Added ${packageName} to the plugin allow-list for an install request from apps.ever.co`,
                metadata: { installId, packageName },
            });
        }

        // Claim it: only one answer per request, whoever clicks first.
        const claimed = await this.requests.update(
            { installId, state: 'requested' },
            {
                state: 'installing',
                decidedByUserId: userId,
                decidedAt: new Date(),
                allowlistAdded,
            },
        );
        if (!claimed.affected) throw notOpen();
        await this.feed.clearNotices(installId);
        await this.reporter.owe(installId, 'installing');

        let detail: EverInstallDetailToken | null = null;
        let installed: { version: string; integrity: string | null } | null = null;
        try {
            installed = await this.bridge.install({
                pluginId,
                packageName,
                version: row.version,
                integrity: row.integrity,
            });
            if (row.integrity && installed.integrity !== row.integrity) {
                // The installer refuses a mismatch before it fetches; a mismatch
                // here means the placed package is not the declared one.
                await this.bridge.uninstall(pluginId).catch(() => undefined);
                detail = 'checksum_mismatch';
            }
        } catch (error) {
            detail = detailOf(error);
            this.logger.warn(
                `install_request.install_failed ${installId} ${detail} (${errorName(error)})`,
            );
        }

        if (detail || !installed) {
            await this.requests.update(
                { installId },
                { state: 'failed', detail: detail ?? 'unknown', pluginId },
            );
            await this.reporter.owe(installId, 'failed');
            await this.record(userId, {
                actionType: ActivityActionType.PLUGIN_INSTALL_FAILED,
                action: 'ever_connect.install_request.failed',
                status: ActivityStatus.FAILED,
                summary: `An install requested from apps.ever.co did not complete (${detail ?? 'unknown'})`,
                metadata: { installId, packageName, pluginId, detail: detail ?? 'unknown' },
            });
        } else {
            await this.requests.update(
                { installId },
                { state: 'installed', detail: null, pluginId, installedVersion: installed.version },
            );
            await this.reporter.owe(installId, 'installed');
            await this.record(userId, {
                actionType: ActivityActionType.PLUGIN_INSTALLED,
                action: 'ever_connect.install_request.installed',
                status: ActivityStatus.COMPLETED,
                summary: `Installed ${packageName}@${installed.version}, requested from apps.ever.co`,
                metadata: { installId, packageName, pluginId, version: installed.version },
            });
        }
        return this.single(installId);
    }

    async decline(installId: string, userId: string): Promise<InstallRequestView> {
        const row = await this.open(installId);
        const detail: EverInstallDetailToken = !this.bridge.dynamicInstallsEnabled()
            ? 'installer_disabled'
            : (await this.notInstallable(row))
              ? 'incompatible_version'
              : 'permission_denied';
        const declined = await this.requests.update(
            { installId, state: 'requested' },
            { state: 'declined', detail, decidedByUserId: userId, decidedAt: new Date() },
        );
        if (!declined.affected) throw notOpen();
        await this.feed.clearNotices(installId);
        await this.reporter.owe(installId, 'failed');
        await this.record(userId, {
            actionType: ActivityActionType.SETTINGS_UPDATED,
            action: 'ever_connect.install_request.declined',
            status: ActivityStatus.COMPLETED,
            summary: 'Declined an install requested from apps.ever.co',
            metadata: { installId, packageName: row.packageName, detail },
        });
        return this.single(installId);
    }

    /**
     * A plugin installed from a request was uninstalled here: the request is
     * `removed` and Ever Platform is told once. Run by the Ever Connect worker.
     */
    async reconcileRemovals(): Promise<number> {
        const installed = await this.requests.find({ where: { state: 'installed' } });
        let removed = 0;
        for (const row of installed) {
            if (!row.pluginId) continue;
            if ((await this.bridge.isInstalled(row.pluginId)) !== false) continue;
            const result = await this.requests.update(
                { installId: row.installId, state: 'installed' },
                { state: 'removed' },
            );
            if (!result.affected) continue;
            removed += 1;
            this.logger.log(`install_request.removed ${row.installId}`);
            await this.feed.clearNotices(row.installId);
            await this.reporter.owe(row.installId, 'removed');
        }
        return removed;
    }

    /** Whether `marketplace_installs` is enabled for the tenant link the request reports under. */
    private async linkEnabled(linkId: string | null): Promise<boolean> {
        if (!linkId) return false;
        const links = await this.integrations.linkStates(EVER_INSTALLS_INTEGRATION_KEY);
        return links.some((link) => link.linkId === linkId && link.enabled);
    }

    private async open(installId: string): Promise<EverConnectInstallRequest> {
        const row = await this.feed.find(installId);
        if (!row) {
            throw new NotFoundException({ code: 'not_found', message: 'No such install request.' });
        }
        if (row.state !== 'requested') throw notOpen();
        return row;
    }

    private async notInstallable(
        row: EverConnectInstallRequest,
    ): Promise<NotInstallableReason | null> {
        if (row.sourceKind !== 'registry' || row.registry !== 'npm' || !row.packageName) {
            return 'source_not_supported';
        }
        return (await this.bridge.pluginIdOf(row.packageName)) ? null : 'plugin_unknown';
    }

    private async single(installId: string): Promise<InstallRequestView> {
        const row = await this.feed.find(installId);
        if (!row) throw new NotFoundException({ code: 'not_found' });
        return toView(row, { allowlist: null, notInstallable: null });
    }

    private async record(
        userId: string,
        entry: {
            actionType: ActivityActionType;
            action: string;
            status: ActivityStatus;
            summary: string;
            metadata: Record<string, unknown>;
        },
    ): Promise<void> {
        await this.activity.log({ userId, ...entry }).catch(() => undefined);
    }
}

function notOpen(): ConflictException {
    return new ConflictException({
        code: 'not_open',
        message: 'This install request was already answered or withdrawn.',
    });
}

/** The detail token of an installer failure (its free text stays in the logs). */
export function detailOf(error: unknown): EverInstallDetailToken {
    if (error instanceof HttpException) {
        switch (error.getStatus()) {
            case 409:
                return 'permission_denied';
            case 424:
                return 'checksum_mismatch';
            case 422:
                return 'incompatible_version';
        }
    }
    if (error instanceof Error && error.name === 'PluginInstallRefusedError') {
        return 'permission_denied';
    }
    return 'unknown';
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown';
}

function toView(
    row: EverConnectInstallRequest,
    extra: { allowlist: BridgeAllowlistState | null; notInstallable: NotInstallableReason | null },
): InstallRequestView {
    const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
    return {
        installId: row.installId,
        listingSlug: row.listingSlug,
        packageName: row.packageName,
        registry: row.registry,
        sourceRepo: row.sourceRepo,
        sourceSha: row.sourceSha,
        version: row.version,
        versionIsExact: row.versionIsExact,
        integrity: row.integrity,
        editionKey: row.editionKey,
        state: row.state,
        detail: row.detail,
        pluginId: row.pluginId,
        installedVersion: row.installedVersion,
        allowlistAdded: row.allowlistAdded,
        receivedAt: iso(row.receivedAt) as string,
        decidedAt: iso(row.decidedAt),
        removalRequestedAt: iso(row.removalRequestedAt),
        allowlist: extra.allowlist,
        notInstallable: extra.notInstallable,
    };
}
