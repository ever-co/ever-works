import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    EverConnectConnection,
    EverConnectInstallRequest,
    EverConnectIntegration,
    EverInstance,
} from '@ever-works/agent/entities';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
import { EVER_INSTALL_STATE_EVENT } from '@ever-works/contracts';
import { readEverConnectConfig } from '../ever-connect.config';
import { EverConnectIntegrationChangedEvent } from '../ever-connect.events';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { EverConnectKeyService } from '../ever-connect-key.service';
import { EverConnectService } from '../ever-connect.service';
import { createIdentityDataSource } from '../identity/__tests__/db.helper-spec';
import { InstallApprovalService } from '../installs/install-approval.service';
import { InstallRequestService } from '../installs/install-request.service';
import { InstallRequestsIntegration } from '../installs/install-requests.integration';
import { InstallStatusReporter, idempotencyKey } from '../installs/install-status-reporter.service';
import type { PluginInstallerBridge } from '../installs/plugin-installer.bridge';
import { IntegrationHandlerRegistry } from '../integrations/integration-handler.registry';
import { FakeBridge, seedUsers } from '../installs/__tests__/install-requests.helper-spec';

/**
 * Install requests end to end against the MOCK PLATFORM of the Ever Platform
 * SDK (`ever-mock-platform` from the `@ever-co/connect-tools` pinned in
 * `tools/egress-audit`): the module's own services on a real database, the
 * SDK client over real HTTP through the mock's integration gate (which needs
 * `Ever-Link-Id` and `marketplace_installs` enabled for that tenant link), and
 * its call record. The plugin installer is a fake that records its calls and
 * answers a configurable integrity.
 *
 * The pinned mock has no install message on its feed (the install event is not
 * in its feed catalogue), so the message is handed to the feed handler as the
 * feed would; the install itself is the mock's (`/__mock/install`), so the
 * status reports move a real install through the mock's transitions.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const MOCK_BIN = join(
    REPO_ROOT,
    'tools/egress-audit/node_modules/@ever-co/connect-tools/dist/mock-platform/bin/ever-mock-platform.mjs',
);
const MOCK_ISSUER = 'https://mock-platform.test';
const CONNECT_CODE = 'EVC-WRKS-PKGS-0001';
const LINK_CODE = 'EVL-WRKS-PKGS-0002';
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

const describeMock =
    process.env.EVER_CONNECT_MOCK_URL || existsSync(MOCK_BIN) ? describe : describe.skip;

interface CallRecord {
    method: string;
    path_template: string;
    row: number | null;
    status: number;
    idempotency_key: string | null;
}

async function startMock(): Promise<{ url: string; process: ChildProcess | null }> {
    if (process.env.EVER_CONNECT_MOCK_URL) {
        return { url: process.env.EVER_CONNECT_MOCK_URL.replace(/\/+$/, ''), process: null };
    }
    const child = spawn(process.execPath, [MOCK_BIN, '--host', '127.0.0.1', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(
            () => reject(new Error(`mock platform did not start: ${out}`)),
            20_000,
        );
        child.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            const match = /listening on (http:\/\/[^\s]+)/.exec(out);
            if (match) {
                clearTimeout(timer);
                resolve(match[1].replace(/\/+$/, ''));
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`mock platform exited (${code}): ${out}`));
        });
    });
    return { url, process: child };
}

describeMock('install requests — against the mock platform', () => {
    jest.setTimeout(90_000);

    let mock: { url: string; process: ChildProcess | null };
    let dataSource: DataSource;
    let connection: EverConnectService;
    let integrations: EverConnectIntegrationService;
    let feed: InstallRequestService;
    let reporter: InstallStatusReporter;
    let approvals: InstallApprovalService;
    let handler: InstallRequestsIntegration;
    let bridge: FakeBridge;
    let admin: string;
    let instanceId: string;
    let linkId: string;
    let orgId: string;
    const lines: string[] = [];

    const control = async (path: string, body: unknown = {}) => {
        const res = await fetch(`${mock.url}/__mock/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.status >= 300) throw new Error(`mock ${path}: ${res.status} ${await res.text()}`);
        return res.json();
    };
    const record = async (): Promise<CallRecord[]> =>
        (await fetch(`${mock.url}/__mock/requests`)).json() as Promise<CallRecord[]>;
    const statusCalls = async () =>
        (await record()).filter((entry) => entry.path_template === '/v1/installs/{install}/status');
    const requestEvent = (installId: string, extra: Record<string, unknown> = {}) => ({
        id: `event-${installId}`,
        type: EVER_INSTALL_STATE_EVENT,
        data: {
            install_id: installId,
            listing_id: '01JZ8Q3M4N5P6R7S8T9V0W1X3A',
            org_id: orgId,
            instance_id: instanceId,
            mechanism: 'instance_plugin',
            state: 'requested',
            listing_slug: 'timeclock',
            package: { registry: 'npm', id: '@acme/timeclock', version_range: '^1.0.0' },
            ...extra,
        },
    });
    const row = (installId: string) =>
        dataSource.getRepository(EverConnectInstallRequest).findOne({ where: { installId } });

    beforeAll(async () => {
        mock = await startMock();
        for (const method of ['log', 'warn', 'error'] as const) {
            jest.spyOn(Logger.prototype, method).mockImplementation((message: unknown) => {
                lines.push(String(message));
            });
        }
        dataSource = await createIdentityDataSource();
        const events = new EventEmitter2();
        const config = readEverConnectConfig({
            EVER_PLATFORM_API_URL: mock.url,
            EVER_PLATFORM_ISSUER: MOCK_ISSUER,
        });
        const instances = dataSource.getRepository(EverInstance);
        const keys = new EverConnectKeyService(instances, new EverInstanceService(instances));
        connection = new EverConnectService(
            dataSource.getRepository(EverConnectConnection),
            keys,
            config,
            events,
        );
        const registry = new IntegrationHandlerRegistry();
        integrations = new EverConnectIntegrationService(
            dataSource.getRepository(EverConnectIntegration),
            connection,
            events,
            undefined,
            registry,
        );
        bridge = new FakeBridge();
        const requests = dataSource.getRepository(EverConnectInstallRequest);
        feed = new InstallRequestService(
            requests,
            dataSource,
            connection,
            integrations,
            bridge as unknown as PluginInstallerBridge,
        );
        reporter = new InstallStatusReporter(requests, connection, integrations);
        approvals = new InstallApprovalService(
            requests,
            feed,
            reporter,
            bridge as unknown as PluginInstallerBridge,
            integrations,
            { log: jest.fn().mockResolvedValue({}) } as unknown as ActivityLogService,
        );
        handler = new InstallRequestsIntegration(registry, integrations, reporter, approvals);
        handler.onModuleInit();
        events.on(EverConnectIntegrationChangedEvent.EVENT_NAME, (event) =>
            handler.onIntegrationChanged(event),
        );
        admin = (await seedUsers(dataSource)).admins[0];

        await control('codes', { code: CONNECT_CODE, product: 'works' });
        await control('codes', { code: LINK_CODE, kind: 'link', product: 'works' });
    });

    afterAll(async () => {
        jest.restoreAllMocks();
        await dataSource?.destroy();
        mock?.process?.kill();
    });

    it('connects and links a tenant; with marketplace_installs not enabled a request is ignored, nothing is called', async () => {
        const status = await connection.connect(CONNECT_CODE);
        instanceId = status.platformInstanceId as string;
        const client = await connection.client();
        const link = (await client!.call('instanceCreateTenantLink', {
            body: { link_code: LINK_CODE, product: 'works', product_tenant_id: 'tenant-1' },
            idempotencyKey: 'link-tenant-1',
        })) as { id: string; org_id: string };
        linkId = link.id;
        orgId = link.org_id;
        await integrations.refresh();
        // Off for the link (Ever Platform labels it `coming_soon` or `available`).
        expect(await integrations.linkStates('marketplace_installs')).toEqual([
            { linkId, state: expect.any(String), enabled: false },
        ]);

        const { install_id: installId } = await control('install', { instance_id: instanceId });
        expect(await feed.handle(requestEvent(installId))).toBe('integration_not_enabled');
        expect(await row(installId)).toBeNull();
        expect(await statusCalls()).toEqual([]);
        expect(bridge.installCalls).toEqual([]);
    });

    it('feed_to_installed_end_to_end: request, notice, approval, installing then installed on Ever Platform', async () => {
        await control('consent', {
            instance_id: instanceId,
            integration: 'marketplace_installs',
            link: linkId,
        });
        await integrations.refresh();
        expect(await integrations.enabledForAnyLink('marketplace_installs')).toBe(true);

        const { install_id: installId } = await control('install', { instance_id: instanceId });
        expect(await feed.handle(requestEvent(installId))).toBe('requested');
        expect(await feed.handle(requestEvent(installId))).toBe('repeated');
        expect(bridge.notices).toHaveLength(2);
        expect(await row(installId)).toMatchObject({ state: 'requested', linkId });
        // The request alone sends nothing and installs nothing.
        expect(await statusCalls()).toEqual([]);
        expect(bridge.installCalls).toEqual([]);

        bridge.allowlist.set('@acme/timeclock', true);
        const view = await approvals.approve(installId, admin, {});
        expect(view).toMatchObject({ state: 'installed', pluginId: 'timeclock' });
        const calls = await statusCalls();
        expect(calls.map((call) => [call.method, call.row, call.status])).toEqual([
            ['POST', 28, 200],
            ['POST', 28, 200],
        ]);
        expect(calls.map((call) => call.idempotency_key)).toEqual([
            idempotencyKey(installId, 'installing'),
            idempotencyKey(installId, 'installed'),
        ]);
        expect(await row(installId)).toMatchObject({
            reportedState: 'installed',
            reportState: null,
        });
    });

    it('not_allowlisted_without_consent_control: 422, allow-list unchanged, no installer call, nothing sent', async () => {
        const { install_id: installId } = await control('install', { instance_id: instanceId });
        await feed.handle(
            requestEvent(installId, {
                package: { registry: 'npm', id: '@acme/payroll', version_range: '^2.0.0' },
                listing_slug: 'payroll',
            }),
        );
        bridge.plugins.set('@acme/payroll', 'payroll');
        const before = (await statusCalls()).length;
        const installsBefore = bridge.installCalls.length;
        await expect(approvals.approve(installId, admin, {})).rejects.toMatchObject({
            status: 422,
            response: { code: 'package_not_allowlisted' },
        });
        expect(bridge.allowlist.has('@acme/payroll')).toBe(false);
        expect(bridge.allowlistAdds).toEqual([]);
        expect(bridge.installCalls).toHaveLength(installsBefore);
        expect(await statusCalls()).toHaveLength(before);
        expect((await row(installId))?.state).toBe('requested');
    });

    it('integrity_mismatch_reported: failed with checksum_mismatch, the plugin taken back', async () => {
        const { install_id: installId } = await control('install', { instance_id: instanceId });
        await feed.handle(requestEvent(installId, { version: '1.2.3', integrity: INTEGRITY }));
        bridge.installedIntegrity = `sha512-${'B'.repeat(86)}==`;
        const before = (await statusCalls()).length;
        const view = await approvals.approve(installId, admin, {});
        expect(view).toMatchObject({ state: 'failed', detail: 'checksum_mismatch' });
        expect(bridge.uninstalls).toContain('timeclock');
        const calls = (await statusCalls()).slice(before);
        expect(calls.map((call) => call.status)).toEqual([200, 200]);
        expect(calls.map((call) => call.idempotency_key)).toEqual([
            idempotencyKey(installId, 'installing'),
            idempotencyKey(installId, 'failed'),
        ]);
        bridge.installedIntegrity = INTEGRITY;
    });

    it('integration revoked: an owed report is dropped, a new request is ignored, nothing more is sent', async () => {
        const { install_id: installId } = await control('install', { instance_id: instanceId });
        await feed.handle(requestEvent(installId));
        await control('revoke', {
            instance_id: instanceId,
            integration: 'marketplace_installs',
            link: linkId,
        });
        await integrations.refresh();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const before = (await statusCalls()).length;
        await expect(approvals.approve(installId, admin, {})).rejects.toMatchObject({
            status: 409,
            response: { code: 'integration_not_enabled' },
        });
        await approvals.decline(installId, admin);
        expect((await row(installId))?.reportState).toBeNull();
        const { install_id: another } = await control('install', { instance_id: instanceId });
        expect(await feed.handle(requestEvent(another))).toBe('integration_not_enabled');
        expect(await reporter.sendDue(new Date(Date.now() + 86_400_000))).toBe(0);
        expect(await statusCalls()).toHaveLength(before);
    });

    it('audit_rows_identifiers_only: the log lines name ids and tokens, never a package, a URL or a token', () => {
        const ours = lines.filter((line) => line.startsWith('install_request.'));
        expect(ours.length).toBeGreaterThan(3);
        for (const line of ours) {
            expect(line).not.toMatch(/@acme|https?:|sha512-|evit_|Bearer/);
        }
    });
});
