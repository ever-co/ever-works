import type { DataSource } from 'typeorm';
import { EverConnectInstallRequest } from '@ever-works/agent/entities';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import { idempotencyKey } from '../install-status-reporter.service';
import {
    INSTALL,
    INTEGRITY,
    LINK,
    buildInstallServices,
    problem,
    requestEvent,
    seedUsers,
} from './install-requests.helper-spec';

/**
 * Install requests from apps.ever.co on this installation: the feed side (a
 * request is kept and the admins told, nothing installed), the admin's answer
 * (the dynamic installer through its public path, the allow-list only with
 * consent, the integrity compared), and the reports to Ever Platform.
 */
describe('install requests', () => {
    let dataSource: DataSource;
    let services: ReturnType<typeof buildInstallServices>;
    let users: { admins: string[]; other: string };
    const row = () =>
        dataSource
            .getRepository(EverConnectInstallRequest)
            .findOne({ where: { installId: INSTALL } });

    beforeEach(async () => {
        dataSource = await createIdentityDataSource();
        services = buildInstallServices(dataSource);
        users = await seedUsers(dataSource);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    describe('the feed (installs nothing)', () => {
        it('request_creates_row_and_notice_once: one row, one notice per platform admin', async () => {
            expect(await services.feed.handle(requestEvent())).toBe('requested');
            expect(await row()).toMatchObject({
                state: 'requested',
                listingSlug: 'timeclock',
                packageName: '@acme/timeclock',
                registry: 'npm',
                version: '^1.0.0',
                versionIsExact: false,
                integrity: null,
                editionKey: 'free',
                linkId: LINK,
                reportState: null,
            });
            expect(services.bridge.notices.map((notice) => notice.userId).sort()).toEqual(
                [...users.admins].sort(),
            );
            expect(services.bridge.notices.every((notice) => notice.kind === 'install')).toBe(true);
        });

        it('repeat_is_noop: the same request delivered again adds no row and no notice', async () => {
            await services.feed.handle(requestEvent());
            expect(await services.feed.handle(requestEvent())).toBe('repeated');
            expect(await dataSource.getRepository(EverConnectInstallRequest).count()).toBe(1);
            expect(services.bridge.notices).toHaveLength(2);
        });

        it('extra_field_rejected_audited: a field outside the closed set keeps nothing', async () => {
            const warn = jest.spyOn((services.feed as any).logger, 'warn');
            expect(await services.feed.handle(requestEvent({ tenant_name: 'Acme Ltd' }))).toBe(
                'rejected',
            );
            expect(await dataSource.getRepository(EverConnectInstallRequest).count()).toBe(0);
            expect(services.bridge.notices).toHaveLength(0);
            const line = String(warn.mock.calls[0]?.[0]);
            expect(line).toContain('install_request.rejected');
            expect(line).toContain('/tenant_name');
            // The path only, never the value.
            expect(line).not.toContain('Acme');
        });

        it('withdraw_clears_notice: a withdrawn request is closed, its notices taken back, nothing reported', async () => {
            await services.feed.handle(requestEvent());
            expect(await services.feed.handle(requestEvent({ state: 'cancelled' }))).toBe(
                'withdrawn',
            );
            expect((await row())?.state).toBe('withdrawn');
            expect(services.bridge.cleared.map((entry) => entry.userId).sort()).toEqual(
                [...users.admins].sort(),
            );
            expect(services.platform.reports()).toEqual([]);
        });

        it('remove_requested_notice_only_no_uninstall', async () => {
            await services.feed.handle(requestEvent());
            await services.approvals.approve(INSTALL, users.admins[0], { addToAllowlist: true });
            services.bridge.notices.length = 0;
            expect(await services.feed.handle(requestEvent({ state: 'removed' }))).toBe(
                'remove_noticed',
            );
            expect(services.bridge.notices.map((notice) => notice.kind)).toEqual([
                'remove',
                'remove',
            ]);
            expect(services.bridge.uninstalls).toEqual([]);
            expect((await row())?.state).toBe('installed');
            // Delivered again: no second notice.
            expect(await services.feed.handle(requestEvent({ state: 'removed' }))).toBe('ignored');
            expect(services.bridge.notices).toHaveLength(2);
        });

        it('unknown_kind_dropped: a blueprint install, or an echo of a report, changes nothing', async () => {
            expect(
                await services.feed.handle(
                    requestEvent({
                        mechanism: 'works_blueprint',
                        listing_slug: undefined,
                        package: undefined,
                        edition_key: undefined,
                    }),
                ),
            ).toBe('ignored');
            expect(await services.feed.handle(requestEvent({ state: 'installing' }))).toBe(
                'ignored',
            );
            expect(await dataSource.getRepository(EverConnectInstallRequest).count()).toBe(0);
        });

        it('integration_not_enabled_not_registered: without the consent, every message is ignored', async () => {
            services.integrations.links = [{ linkId: LINK, state: 'available', enabled: false }];
            expect(await services.feed.handle(requestEvent())).toBe('integration_not_enabled');
            expect(await dataSource.getRepository(EverConnectInstallRequest).count()).toBe(0);
            expect(services.bridge.notices).toEqual([]);
        });

        it('no_installer_call_from_feed: no install, no allow-list change, no report', async () => {
            await services.feed.handle(requestEvent());
            await services.feed.handle(requestEvent({ state: 'removed' }));
            await services.feed.handle(requestEvent({ state: 'cancelled' }));
            expect(services.bridge.installCalls).toEqual([]);
            expect(services.bridge.allowlistAdds).toEqual([]);
            expect(services.platform.calls).toEqual([]);
        });

        it('a request for another installation is ignored', async () => {
            expect(
                await services.feed.handle(
                    requestEvent({ instance_id: '01JZ8Q3M4N5P6R7S8T9V0W1X9Z' }),
                ),
            ).toBe('ignored');
            expect(await dataSource.getRepository(EverConnectInstallRequest).count()).toBe(0);
        });
    });

    describe('the admin’s answer', () => {
        beforeEach(async () => {
            await services.feed.handle(requestEvent());
        });

        it('approve_allowlisted_installs_and_matches_integrity: installing, then installed, through the installer', async () => {
            services.bridge.allowlist.set('@acme/timeclock', true);
            const view = await services.approvals.approve(INSTALL, users.admins[0], {});
            expect(view).toMatchObject({
                state: 'installed',
                pluginId: 'timeclock',
                installedVersion: '1.2.3',
                allowlistAdded: false,
            });
            expect(services.bridge.installCalls).toEqual([
                {
                    pluginId: 'timeclock',
                    packageName: '@acme/timeclock',
                    version: '^1.0.0',
                    integrity: null,
                },
            ]);
            expect(services.platform.reports().map((report) => report.state)).toEqual([
                'installing',
                'installed',
            ]);
            expect(services.platform.reports()[1]).toMatchObject({ external_ref: 'timeclock' });
            expect(await row()).toMatchObject({
                decidedByUserId: users.admins[0],
                reportedState: 'installed',
                reportState: null,
            });
            // The notices are taken back once the request is answered.
            expect(services.bridge.cleared).toHaveLength(2);
        });

        it('a declared integrity is passed to the installer and compared with what it installed', async () => {
            await dataSource
                .getRepository(EverConnectInstallRequest)
                .update(
                    { installId: INSTALL },
                    { integrity: INTEGRITY, version: '1.2.3', versionIsExact: true },
                );
            services.bridge.allowlist.set('@acme/timeclock', true);
            await services.approvals.approve(INSTALL, users.admins[0], {});
            expect(services.bridge.installCalls[0]).toMatchObject({
                version: '1.2.3',
                integrity: INTEGRITY,
            });
            expect((await row())?.state).toBe('installed');
        });

        it('approve_not_allowlisted_422_control: refused, the request stays open, the allow-list unchanged', async () => {
            await expect(
                services.approvals.approve(INSTALL, users.admins[0], { addToAllowlist: false }),
            ).rejects.toMatchObject({
                status: 422,
                response: { code: 'package_not_allowlisted' },
            });
            expect((await row())?.state).toBe('requested');
            expect(services.bridge.allowlistAdds).toEqual([]);
            expect(services.bridge.installCalls).toEqual([]);
            expect(services.platform.calls).toEqual([]);
        });

        it('approve_with_consent_appends_allowlist_audited: pinned to the declared version and integrity', async () => {
            const view = await services.approvals.approve(INSTALL, users.admins[0], {
                addToAllowlist: true,
            });
            expect(view).toMatchObject({ state: 'installed', allowlistAdded: true });
            expect(services.bridge.allowlistAdds).toEqual([
                { packageName: '@acme/timeclock', versionRange: '^1.0.0', integrity: null },
            ]);
            expect(services.activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: users.admins[0],
                    action: 'ever_connect.install_request.allowlist_added',
                    metadata: { installId: INSTALL, packageName: '@acme/timeclock' },
                }),
            );
        });

        it('a disabled allow-list entry is the operator’s choice: refused even with the tick', async () => {
            services.bridge.allowlist.set('@acme/timeclock', false);
            await expect(
                services.approvals.approve(INSTALL, users.admins[0], { addToAllowlist: true }),
            ).rejects.toMatchObject({ response: { code: 'package_allowlist_disabled' } });
            expect(services.bridge.allowlistAdds).toEqual([]);
        });

        it('integrity_mismatch_failed_checksum: what was placed is taken back, failed is reported', async () => {
            await dataSource
                .getRepository(EverConnectInstallRequest)
                .update({ installId: INSTALL }, { integrity: INTEGRITY });
            services.bridge.allowlist.set('@acme/timeclock', true);
            services.bridge.installedIntegrity = `sha512-${'B'.repeat(86)}==`;
            const view = await services.approvals.approve(INSTALL, users.admins[0], {});
            expect(view).toMatchObject({ state: 'failed', detail: 'checksum_mismatch' });
            expect(services.bridge.uninstalls).toEqual(['timeclock']);
            expect(
                services.platform.reports().map((report) => [report.state, report.detail]),
            ).toEqual([
                ['installing', undefined],
                ['failed', 'checksum_mismatch'],
            ]);
        });

        it('installer refusals map to fixed tokens; the free text stays here', async () => {
            const { HttpException } = await import('@nestjs/common');
            services.bridge.allowlist.set('@acme/timeclock', true);
            services.bridge.installError = new HttpException(
                { statusCode: 424, message: 'Integrity mismatch for @acme/timeclock: expected …' },
                424,
            );
            const view = await services.approvals.approve(INSTALL, users.admins[0], {});
            expect(view).toMatchObject({ state: 'failed', detail: 'checksum_mismatch' });
            const failed = services.platform.reports().at(-1);
            expect(failed).toEqual({
                install: INSTALL,
                state: 'failed',
                detail: 'checksum_mismatch',
                idempotencyKey: idempotencyKey(INSTALL, 'failed'),
            });
        });

        it('mode_not_dynamic_422_installer_disabled; decline then reports installer_disabled', async () => {
            services.bridge.mode = 'bundled';
            await expect(
                services.approvals.approve(INSTALL, users.admins[0], { addToAllowlist: true }),
            ).rejects.toMatchObject({ status: 422, response: { code: 'installer_disabled' } });
            expect((await row())?.state).toBe('requested');
            const view = await services.approvals.decline(INSTALL, users.admins[0]);
            expect(view).toMatchObject({ state: 'declined', detail: 'installer_disabled' });
            expect(services.platform.reports()).toEqual([
                expect.objectContaining({ state: 'failed', detail: 'installer_disabled' }),
            ]);
        });

        it('decline_reports_permission_denied, and a second answer is refused', async () => {
            const view = await services.approvals.decline(INSTALL, users.admins[1]);
            expect(view).toMatchObject({ state: 'declined', detail: 'permission_denied' });
            expect(services.platform.reports()).toEqual([
                expect.objectContaining({ state: 'failed', detail: 'permission_denied' }),
            ]);
            await expect(
                services.approvals.approve(INSTALL, users.admins[0], { addToAllowlist: true }),
            ).rejects.toMatchObject({ status: 409, response: { code: 'not_open' } });
            expect(services.bridge.installCalls).toEqual([]);
            expect(services.bridge.allowlistAdds).toEqual([]);
        });

        it('a request no plugin of this installation is known by cannot be approved', async () => {
            services.bridge.plugins.clear();
            await expect(
                services.approvals.approve(INSTALL, users.admins[0], { addToAllowlist: true }),
            ).rejects.toMatchObject({ response: { code: 'not_installable' } });
            expect(services.bridge.allowlistAdds).toEqual([]);
            expect((await services.approvals.view()).requests[0]).toMatchObject({
                notInstallable: 'plugin_unknown',
            });
        });

        it('approval is refused once the integration is off for the request’s link', async () => {
            services.integrations.links = [{ linkId: LINK, state: 'revoked', enabled: false }];
            await expect(
                services.approvals.approve(INSTALL, users.admins[0], { addToAllowlist: true }),
            ).rejects.toMatchObject({ status: 409, response: { code: 'integration_not_enabled' } });
            expect(services.bridge.installCalls).toEqual([]);
        });

        it('installer_called_through_public_path_only: the declared package name, never another', async () => {
            services.bridge.allowlist.set('@acme/timeclock', true);
            await services.approvals.approve(INSTALL, users.admins[0], {});
            expect(services.bridge.installCalls.map((call) => call.packageName)).toEqual([
                '@acme/timeclock',
            ]);
        });

        it('the view lists the open request with its allow-list state and the installer mode', async () => {
            const view = await services.approvals.view();
            expect(view).toMatchObject({ installerEnabled: true, integrationEnabled: true });
            expect(view.requests).toEqual([
                expect.objectContaining({
                    installId: INSTALL,
                    state: 'requested',
                    allowlist: 'absent',
                    notInstallable: null,
                }),
            ]);
            expect(JSON.stringify(view)).not.toMatch(/linkId|everOrgId|decidedByUserId/);
        });
    });

    describe('the reports to Ever Platform', () => {
        beforeEach(async () => {
            await services.feed.handle(requestEvent());
            services.bridge.allowlist.set('@acme/timeclock', true);
        });

        it('installing_then_installed_sent_in_order with an idempotency key per state', async () => {
            await services.approvals.approve(INSTALL, users.admins[0], {});
            expect(services.platform.reports()).toEqual([
                {
                    install: INSTALL,
                    state: 'installing',
                    idempotencyKey: idempotencyKey(INSTALL, 'installing'),
                },
                {
                    install: INSTALL,
                    state: 'installed',
                    external_ref: 'timeclock',
                    idempotencyKey: idempotencyKey(INSTALL, 'installed'),
                },
            ]);
        });

        it('retry_at_heartbeat_until_sent: not reachable now, sent by a later worker pass, installing first', async () => {
            services.platform.answer = () =>
                Object.assign(new Error('timeout'), { name: 'TimeoutError' });
            await services.approvals.approve(INSTALL, users.admins[0], {});
            expect((await row())?.reportState).toBe('installed');
            expect((await row())?.reportedState).toBeNull();
            services.platform.calls.length = 0;
            services.platform.answer = () => ({});
            // Not yet due.
            expect(await services.reporter.sendDue(new Date())).toBe(0);
            expect(await services.reporter.sendDue(new Date(Date.now() + 3_600_000))).toBe(1);
            expect(services.platform.reports().map((report) => report.state)).toEqual([
                'installing',
                'installed',
            ]);
            expect(await row()).toMatchObject({ reportState: null, reportedState: 'installed' });
        });

        it('idempotent_on_state: a state Ever Platform has is not sent again', async () => {
            await services.approvals.approve(INSTALL, users.admins[0], {});
            services.platform.calls.length = 0;
            expect(await services.reporter.owe(INSTALL, 'installed')).toBe('nothing_owed');
            expect(services.platform.calls).toEqual([]);
        });

        it('refused_403_no_retry_audited: a refusal drops the report for good', async () => {
            services.platform.answer = () => problem(403, 'integration_revoked');
            const warn = jest.spyOn((services.reporter as any).logger, 'warn');
            await services.approvals.approve(INSTALL, users.admins[0], {});
            expect(await row()).toMatchObject({ reportState: null });
            expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
                'install_request.report_refused',
            );
            services.platform.calls.length = 0;
            expect(await services.reporter.sendDue(new Date(Date.now() + 86_400_000))).toBe(0);
            expect(services.platform.calls).toEqual([]);
        });

        it('integration_disabled_never_sends: an owed report is dropped, not sent later', async () => {
            services.integrations.links = [{ linkId: LINK, state: 'disabled', enabled: false }];
            await dataSource
                .getRepository(EverConnectInstallRequest)
                .update({ installId: INSTALL }, { state: 'installed', pluginId: 'timeclock' });
            expect(await services.reporter.owe(INSTALL, 'installed')).toBe('dropped');
            services.integrations.links = [{ linkId: LINK, state: 'enabled', enabled: true }];
            expect(await services.reporter.sendDue(new Date(Date.now() + 86_400_000))).toBe(0);
            expect(services.platform.calls).toEqual([]);
        });

        it('dropOwed drops every owed report when the integration goes off', async () => {
            services.platform.connected = false;
            await services.approvals.approve(INSTALL, users.admins[0], {});
            expect((await row())?.reportState).toBe('installed');
            expect(await services.reporter.dropOwed('integration_not_enabled')).toBe(1);
            expect((await row())?.reportState).toBeNull();
        });

        it('uninstall_reports_removed_once', async () => {
            await services.approvals.approve(INSTALL, users.admins[0], {});
            services.platform.calls.length = 0;
            expect(await services.approvals.reconcileRemovals()).toBe(0);
            services.bridge.installed.delete('timeclock');
            expect(await services.approvals.reconcileRemovals()).toBe(1);
            expect(await services.approvals.reconcileRemovals()).toBe(0);
            expect(services.platform.reports()).toEqual([
                expect.objectContaining({ state: 'removed' }),
            ]);
            expect((await row())?.state).toBe('removed');
            // Its echo on the feed asks nothing of the admins.
            expect(await services.feed.handle(requestEvent({ state: 'removed' }))).toBe('ignored');
        });
    });
});
