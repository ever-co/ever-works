import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { HttpException } from '@nestjs/common';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import { EverConnectInstallRequest, User } from '@ever-works/agent/entities';
import { EVER_INSTALL_STATE_EVENT } from '@ever-works/contracts';
import type { EverConnectIntegrationService } from '../../ever-connect-integration.service';
import type { EverConnectService } from '../../ever-connect.service';
import type { EverConnectPlatform } from '../../identity/ever-connect-identity.ports';
import { InstallApprovalService } from '../install-approval.service';
import { InstallRequestService } from '../install-request.service';
import { InstallStatusReporter } from '../install-status-reporter.service';
import type { BridgeAllowlistState, PluginInstallerBridge } from '../plugin-installer.bridge';

/** Shared fakes of the install-request specs: everything but the database and the services under test. */

export const INSTALL = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
export const LISTING = '01JZ8Q3M4N5P6R7S8T9V0W1X3A';
export const ORG = '01JZ8Q3M4N5P6R7S8T9V0W1X4B';
export const INSTANCE = '01JZ8Q3M4N5P6R7S8T9V0W1X5C';
export const LINK = '01JZ8Q3M4N5P6R7S8T9V0W1X6D';
export const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

/** The install event of a plugin request, as Ever Platform sends it to the target installation. */
export function requestEvent(extra: Record<string, unknown> = {}, id = randomUUID()) {
    return {
        id,
        type: EVER_INSTALL_STATE_EVENT,
        data: {
            install_id: INSTALL,
            listing_id: LISTING,
            org_id: ORG,
            instance_id: INSTANCE,
            mechanism: 'instance_plugin',
            state: 'requested',
            listing_slug: 'timeclock',
            edition_key: 'free',
            package: { registry: 'npm', id: '@acme/timeclock', version_range: '^1.0.0' },
            ...extra,
        },
    };
}

/** A fake of the Works parts an approval reaches: installer, allow-list, plugin rows, notices. */
export class FakeBridge {
    mode: 'dynamic' | 'bundled' = 'dynamic';
    allowlist = new Map<string, boolean>();
    plugins = new Map<string, string>([['@acme/timeclock', 'timeclock']]);
    installed = new Set<string>();
    installedIntegrity: string | null = INTEGRITY;
    installError: unknown = null;
    readonly installCalls: Array<Record<string, unknown>> = [];
    readonly allowlistAdds: Array<Record<string, unknown>> = [];
    readonly uninstalls: string[] = [];
    readonly notices: Array<{ userId: string; installId: string; kind: string }> = [];
    readonly cleared: Array<{ userId: string; installId: string }> = [];

    readonly notifications = {
        notifyEverPlatformInstallRequest: async (args: {
            userId: string;
            installId: string;
            kind: string;
        }) => {
            this.notices.push({ userId: args.userId, installId: args.installId, kind: args.kind });
        },
        clearEverPlatformInstallRequest: async (userId: string, installId: string) => {
            this.cleared.push({ userId, installId });
        },
    };

    dynamicInstallsEnabled(): boolean {
        return this.mode === 'dynamic';
    }

    async pluginIdOf(packageName: string): Promise<string | null> {
        const firstParty = /^@ever-works\/([a-z0-9-]+)-plugin$/.exec(packageName);
        return firstParty ? firstParty[1] : (this.plugins.get(packageName) ?? null);
    }

    async allowlistState(packageName: string): Promise<BridgeAllowlistState> {
        if (packageName.startsWith('@ever-works/')) return 'first_party';
        if (!this.allowlist.has(packageName)) return 'absent';
        return this.allowlist.get(packageName) ? 'allowed' : 'disabled';
    }

    async addToAllowlist(input: Record<string, unknown>): Promise<void> {
        this.allowlistAdds.push(input);
        this.allowlist.set(input.packageName as string, true);
    }

    async install(input: Record<string, unknown>) {
        this.installCalls.push(input);
        if (this.installError) throw this.installError;
        const allowed =
            String(input.packageName).startsWith('@ever-works/') ||
            this.allowlist.get(input.packageName as string) === true;
        if (!allowed) {
            throw new HttpException({ statusCode: 409, message: 'not allowlisted' }, 409);
        }
        this.installed.add(input.pluginId as string);
        return {
            pluginId: input.pluginId as string,
            version: '1.2.3',
            integrity: this.installedIntegrity,
        };
    }

    async uninstall(pluginId: string): Promise<void> {
        this.uninstalls.push(pluginId);
        this.installed.delete(pluginId);
    }

    async isInstalled(pluginId: string): Promise<boolean | null> {
        return this.installed.has(pluginId);
    }
}

/** A fake of the integration states: `marketplace_installs` per tenant link. */
export class FakeIntegrations {
    links: Array<{ linkId: string; state: string; enabled: boolean }> = [
        { linkId: LINK, state: 'enabled', enabled: true },
    ];

    async linkStates() {
        return this.links;
    }

    async enabledForAnyLink() {
        return this.links.some((link) => link.enabled);
    }
}

/** A fake Ever Platform: records every call; `answer` decides each one. */
export class FakePlatform implements EverConnectPlatform {
    connected = true;
    readonly calls: Array<{ id: string; input: Record<string, unknown> }> = [];
    answer: (id: string, input: Record<string, unknown>) => unknown = () => ({});

    async client() {
        if (!this.connected) return null;
        return {
            call: async (id: string, input: Record<string, unknown>) => {
                this.calls.push({ id, input });
                const result = this.answer(id, input);
                if (result instanceof Error) throw result;
                return result;
            },
        } as never;
    }

    reports(): Array<{
        install: string;
        state?: string;
        detail?: string;
        external_ref?: string;
        idempotencyKey?: unknown;
    }> {
        return this.calls
            .filter((call) => call.id === 'instanceReportInstallStatus')
            .map((call) => ({
                install: (call.input.path as { install: string }).install,
                ...(call.input.body as Record<string, unknown>),
                idempotencyKey: call.input.idempotencyKey,
            }));
    }
}

/** An error as the SDK throws it for a problem document. */
export function problem(status: number, code: string): Error {
    return Object.assign(new Error(code), { name: 'ProblemError', status, code });
}

/** The services under test on a real database, with the fakes above. */
export function buildInstallServices(dataSource: DataSource) {
    const bridge = new FakeBridge();
    const integrations = new FakeIntegrations();
    const platform = new FakePlatform();
    const activity = { log: jest.fn().mockResolvedValue({}) };
    const connection = {
        connection: async () => ({ platformInstanceId: INSTANCE }),
        client: async () => platform.client(),
    } as unknown as EverConnectService;
    const repository = dataSource.getRepository(EverConnectInstallRequest);
    const feed = new InstallRequestService(
        repository,
        dataSource,
        connection,
        integrations as unknown as EverConnectIntegrationService,
        bridge as unknown as PluginInstallerBridge,
    );
    const reporter = new InstallStatusReporter(
        repository,
        platform,
        integrations as unknown as EverConnectIntegrationService,
    );
    const approvals = new InstallApprovalService(
        repository,
        feed,
        reporter,
        bridge as unknown as PluginInstallerBridge,
        integrations as unknown as EverConnectIntegrationService,
        activity as unknown as ActivityLogService,
    );
    return { bridge, integrations, platform, activity, feed, reporter, approvals, repository };
}

/** Two platform admins and one other user. */
export async function seedUsers(
    dataSource: DataSource,
): Promise<{ admins: string[]; other: string }> {
    const users = dataSource.getRepository(User);
    const make = async (isPlatformAdmin: boolean) => {
        const username = `person-${randomUUID().slice(0, 8)}`;
        const user = await users.save(
            users.create({
                username,
                slug: username,
                email: `${username}@example.test`,
                password: 'not-a-real-hash',
                registrationProvider: 'local',
                emailVerified: true,
                isActive: true,
                isPlatformAdmin,
            } as never),
        );
        return (user as unknown as User).id;
    };
    return { admins: [await make(true), await make(true)], other: await make(false) };
}
