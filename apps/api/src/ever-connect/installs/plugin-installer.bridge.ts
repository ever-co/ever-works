import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
    PluginAllowlistRepository,
    PluginInstallerService,
    PluginOperationsService,
    PluginRepository,
} from '@ever-works/agent/plugins';
import { NotificationService } from '@ever-works/agent/notifications';
import { getOptionalProvider } from '@ever-works/agent/utils';

/** What the installer answered for one install (as `POST /api/plugins/:id/install`). */
export interface BridgeInstallResult {
    readonly pluginId: string;
    readonly version: string;
    readonly integrity: string | null;
}

/** Whether a package may be installed, as the plugin installer decides it. */
export type BridgeAllowlistState = 'first_party' | 'allowed' | 'disabled' | 'absent';

/**
 * The parts of Works an approved install request uses, reached as they are:
 * the dynamic plugin installer, the plugin allow-list, the plugin rows, the
 * registration of an installed plugin, and the in-app notifications.
 *
 * They are looked up in the running application rather than imported as
 * modules, so the Ever Connect module stays loadable on its own (it is imported
 * only with `EVER_CONNECT_ENABLED=true`) and an installation without the
 * installer wired answers "installs are off" instead of failing to boot.
 *
 * {@link install} calls the installer exactly as the dynamic install route
 * (`POST /api/plugins/:pluginId/install`) does — allow-list first, then the
 * registry integrity check, then the registration — and passes the package
 * name the request declared, so nothing else can be installed for it.
 */
@Injectable()
export class PluginInstallerBridge {
    constructor(private readonly moduleRef: ModuleRef) {}

    private get installer(): PluginInstallerService | undefined {
        return getOptionalProvider<PluginInstallerService>(this.moduleRef, PluginInstallerService);
    }

    private get allowlist(): PluginAllowlistRepository | undefined {
        return getOptionalProvider<PluginAllowlistRepository>(
            this.moduleRef,
            PluginAllowlistRepository,
        );
    }

    private get plugins(): PluginRepository | undefined {
        return getOptionalProvider<PluginRepository>(this.moduleRef, PluginRepository);
    }

    private get operations(): PluginOperationsService | undefined {
        return getOptionalProvider<PluginOperationsService>(
            this.moduleRef,
            PluginOperationsService,
        );
    }

    get notifications(): NotificationService | undefined {
        return getOptionalProvider<NotificationService>(this.moduleRef, NotificationService);
    }

    /** Whether dynamic plugin installs run here (`PLUGIN_DISTRIBUTION_MODE=dynamic`, installer wired). */
    dynamicInstallsEnabled(): boolean {
        const installer = this.installer;
        return !!installer && !!this.operations && installer.getDistributionMode() === 'dynamic';
    }

    /**
     * The plugin id of a package: `@ever-works/<id>-plugin` (the installer's
     * own naming), or the id of a plugin row whose recorded package is this
     * one. `null`: no plugin of this installation is known by that package.
     */
    async pluginIdOf(packageName: string): Promise<string | null> {
        const firstParty = /^@ever-works\/([a-z0-9][a-z0-9-]*)-plugin$/.exec(packageName);
        if (firstParty) return firstParty[1];
        const rows = (await this.plugins?.findAll()) ?? [];
        for (const row of rows) {
            const spec = row.registrySpec ?? '';
            const at = spec.lastIndexOf('@');
            if (at > 0 && spec.slice(0, at) === packageName) return row.pluginId;
        }
        return null;
    }

    /** The package's allow-list state, as the installer reads it (first-party is always allowed). */
    async allowlistState(packageName: string): Promise<BridgeAllowlistState> {
        if (packageName.startsWith('@ever-works/')) return 'first_party';
        const row = await this.allowlist?.findByPackageName(packageName);
        if (!row) return 'absent';
        return row.enabled ? 'allowed' : 'disabled';
    }

    /**
     * Append the package to the plugin allow-list through its repository (as
     * the allow-list admin route does), pinned to the declared version and
     * integrity. Only on an approving admin's explicit consent.
     */
    async addToAllowlist(input: {
        packageName: string;
        versionRange: string;
        integrity: string | null;
    }): Promise<void> {
        const allowlist = this.allowlist;
        if (!allowlist) throw new Error('The plugin allow-list is not available');
        await allowlist.create({
            packageName: input.packageName,
            versionRange: input.versionRange,
            integrity: input.integrity,
            source: 'npm',
            enabled: true,
        });
    }

    /** Install and register, as `POST /api/plugins/:pluginId/install`. Throws what they throw. */
    async install(input: {
        pluginId: string;
        packageName: string;
        version: string | null;
        integrity: string | null;
    }): Promise<BridgeInstallResult> {
        const installer = this.installer;
        const operations = this.operations;
        if (!installer || !operations) throw new Error('Dynamic plugin installs are not wired');
        const installed = await installer.install({
            pluginId: input.pluginId,
            packageName: input.packageName,
            version: input.version ?? undefined,
            integrity: input.integrity ?? undefined,
        });
        await operations.registerInstalledPlugin(input.pluginId, installed.installPath);
        return {
            pluginId: input.pluginId,
            version: installed.version,
            integrity: installed.integrity ?? null,
        };
    }

    /** Take back what an install placed (an integrity that does not match). */
    async uninstall(pluginId: string): Promise<void> {
        await this.installer?.uninstall(pluginId);
    }

    /** Whether the plugin is still installed (its row says so). `null`: the rows are not reachable. */
    async isInstalled(pluginId: string): Promise<boolean | null> {
        const plugins = this.plugins;
        if (!plugins) return null;
        const row = await plugins.findByPluginId(pluginId);
        return row?.installState === 'installed';
    }
}
