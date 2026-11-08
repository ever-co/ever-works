import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EverInstallRequestView, EverInstallRequestsView } from '@ever-works/contracts';
import { InstallRequestsPanel } from './InstallRequestsPanel';

/**
 * Settings → Ever Platform → Install requests.
 *
 * Pins the rows a platform admin sees (what apps.ever.co declared), that the
 * allow-list box starts unticked and travels with Approve only when ticked,
 * that a `package_not_allowlisted` refusal is said inline, that Approve is
 * disabled while dynamic installs are off, and that the panel has nothing to
 * show without the API's answer (with the module off the page is a 404).
 * Queries by test id and text, not by role (the slow path in this app).
 */

const approve = vi.fn();
const decline = vi.fn();
const toastSuccess = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
    useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('sonner', () => ({
    toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));
vi.mock('@/app/actions/settings/ever-platform-install-requests', () => ({
    approveInstallRequestAction: (...args: unknown[]) => approve(...args),
    declineInstallRequestAction: (...args: unknown[]) => decline(...args),
}));

const INSTALL = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

function request(over: Partial<EverInstallRequestView> = {}): EverInstallRequestView {
    return {
        installId: INSTALL,
        listingSlug: 'timeclock',
        packageName: '@acme/timeclock',
        registry: 'npm',
        sourceRepo: null,
        sourceSha: null,
        version: '1.2.3',
        versionIsExact: true,
        integrity: INTEGRITY,
        editionKey: 'free',
        state: 'requested',
        detail: null,
        pluginId: null,
        installedVersion: null,
        allowlistAdded: false,
        receivedAt: '2026-11-07T10:00:00.000Z',
        decidedAt: null,
        removalRequestedAt: null,
        allowlist: 'absent',
        notInstallable: null,
        ...over,
    };
}

function view(over: Partial<EverInstallRequestsView> = {}): EverInstallRequestsView {
    return { installerEnabled: true, integrationEnabled: true, requests: [request()], ...over };
}

describe('InstallRequestsPanel', () => {
    beforeEach(() => {
        approve.mockReset();
        decline.mockReset();
        toastSuccess.mockReset();
    });

    it('renders_rows_for_admin: listing, package@version, integrity, edition and the state', () => {
        render(<InstallRequestsPanel state="loaded" initial={view()} />);
        const row = screen.getByTestId('install-request-row');
        expect(row.textContent).toContain('timeclock');
        expect(row.textContent).toContain('@acme/timeclock@1.2.3');
        expect(row.textContent).toContain(INTEGRITY);
        expect(row.textContent).toContain('free');
        expect(screen.getByTestId('install-request-state').textContent).toBe('states.requested');
    });

    it('allowlist_checkbox_default_unticked, and Approve sends the tick only when ticked', async () => {
        approve.mockResolvedValue({
            success: true,
            data: request({ state: 'installed', pluginId: 'timeclock', installedVersion: '1.2.3' }),
        });
        render(<InstallRequestsPanel state="loaded" initial={view()} />);
        const box = screen.getByTestId('install-request-allowlist') as HTMLInputElement;
        expect(box.checked).toBe(false);
        expect(screen.getByText('allowlistNote')).toBeTruthy();

        await userEvent.click(box);
        await userEvent.click(screen.getByTestId('install-request-approve'));
        await waitFor(() => expect(approve).toHaveBeenCalledWith(INSTALL, true));
        await waitFor(() =>
            expect(screen.getByTestId('install-request-state').textContent).toBe(
                'states.installed',
            ),
        );
        expect(toastSuccess).toHaveBeenCalled();
    });

    it('approve_without_consent_shows_422_message inline; the request stays open', async () => {
        approve.mockResolvedValue({ success: false, code: 'package_not_allowlisted' });
        render(<InstallRequestsPanel state="loaded" initial={view()} />);
        await userEvent.click(screen.getByTestId('install-request-approve'));
        await waitFor(() => expect(approve).toHaveBeenCalledWith(INSTALL, false));
        expect((await screen.findByTestId('install-request-error')).textContent).toBe(
            'errors.packageNotAllowlisted',
        );
        expect(screen.getByTestId('install-request-state').textContent).toBe('states.requested');
    });

    it('no allow-list box for a package already allowed', () => {
        render(
            <InstallRequestsPanel
                state="loaded"
                initial={view({ requests: [request({ allowlist: 'first_party' })] })}
            />,
        );
        expect(screen.queryByTestId('install-request-allowlist')).toBeNull();
    });

    it('installer_disabled_disables_approve, with the sentence and a docs link; Decline stays', async () => {
        decline.mockResolvedValue({
            success: true,
            data: request({ state: 'declined', detail: 'installer_disabled' }),
        });
        render(<InstallRequestsPanel state="loaded" initial={view({ installerEnabled: false })} />);
        expect(screen.getByTestId('install-requests-installer-disabled').textContent).toContain(
            'installerDisabled',
        );
        expect((screen.getByTestId('install-request-approve') as HTMLButtonElement).disabled).toBe(
            true,
        );
        await userEvent.click(screen.getByTestId('install-request-decline'));
        await waitFor(() => expect(decline).toHaveBeenCalledWith(INSTALL));
        expect((await screen.findByTestId('install-request-detail')).textContent).toBe(
            'details.installerDisabled',
        );
    });

    it('a request that cannot be installed here says why and cannot be approved', () => {
        render(
            <InstallRequestsPanel
                state="loaded"
                initial={view({ requests: [request({ notInstallable: 'plugin_unknown' })] })}
            />,
        );
        expect(screen.getByTestId('install-request-not-installable').textContent).toBe(
            'notInstallable.pluginUnknown',
        );
        expect((screen.getByTestId('install-request-approve') as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('module_off_renders_nothing: without the API’s answer there are no rows and no buttons', () => {
        render(<InstallRequestsPanel state="unavailable" initial={null} />);
        expect(screen.getByTestId('install-requests-unavailable')).toBeTruthy();
        expect(screen.queryByTestId('install-request-row')).toBeNull();
        expect(screen.queryByTestId('install-request-approve')).toBeNull();
    });

    it('answered requests show no buttons', () => {
        render(
            <InstallRequestsPanel
                state="loaded"
                initial={view({
                    requests: [
                        request({
                            state: 'installed',
                            pluginId: 'timeclock',
                            installedVersion: '1.2.3',
                        }),
                    ],
                })}
            />,
        );
        expect(screen.queryByTestId('install-request-approve')).toBeNull();
        expect(screen.getByTestId('install-request-installed').textContent).toBe(
            'installedAs:timeclock,1.2.3',
        );
    });
});
