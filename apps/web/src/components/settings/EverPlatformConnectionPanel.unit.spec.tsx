import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
    EverPlatformConnectionStatusView,
    EverPlatformOrganizationLinkView,
} from '@ever-works/contracts';
import { EverPlatformConnectionPanel } from './EverPlatformConnectionPanel';
import {
    EverPlatformOrganizationLinks,
    type EverPlatformOrganizationLinkItem,
} from './EverPlatformOrganizationLinks';

/**
 * Settings → Ever Platform → Connection and Organization link.
 *
 * Pins what a platform admin sees of the connection (the state in words, the
 * connect form only while not connected, Disconnect only behind a
 * confirmation), what a member sees of an Organization's link (and that only
 * its administrator is offered the form and Remove link), that a code is
 * checked before any request and never kept in the page, and that the parts
 * switched on separately appear only when they are on.
 * Queries by test id and text, not by role (the slow path in this app).
 */

const connect = vi.fn();
const disconnect = vi.fn();
const link = vi.fn();
const unlink = vi.fn();
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
vi.mock('@/app/actions/settings/ever-platform-connection', () => ({
    connectEverPlatformAction: (...args: unknown[]) => connect(...args),
    disconnectEverPlatformAction: (...args: unknown[]) => disconnect(...args),
    linkOrganizationAction: (...args: unknown[]) => link(...args),
    unlinkOrganizationAction: (...args: unknown[]) => unlink(...args),
}));

const INSTANCE = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const ORG = '11111111-1111-4111-8111-111111111111';

function status(
    over: Partial<EverPlatformConnectionStatusView> = {},
    connection: Partial<EverPlatformConnectionStatusView['connection']> = {},
): EverPlatformConnectionStatusView {
    return {
        connection: {
            status: 'disconnected',
            platformInstanceId: null,
            connectedAt: null,
            lastError: null,
            ...connection,
        },
        integrations: [],
        outbox: { pending: 0, failed: 0, lastError: null },
        features: { linkCodes: false, heartbeat: false, entitlements: false, appSync: false },
        heartbeat: { lastSentAt: null },
        entitlement: null,
        appSync: null,
        ...over,
    };
}

const CONNECTED = {
    status: 'active',
    platformInstanceId: INSTANCE,
    connectedAt: '2026-11-13T10:00:00.000Z',
} as const;

function linkView(
    over: Partial<EverPlatformOrganizationLinkView> = {},
): EverPlatformOrganizationLinkView {
    return {
        connected: true,
        link: null,
        entitlement: null,
        appSync: false,
        canManage: true,
        ...over,
    };
}

function item(view: EverPlatformOrganizationLinkView | null): EverPlatformOrganizationLinkItem {
    return { organizationId: ORG, displayName: 'Acme', slug: 'acme', view };
}

describe('EverPlatformConnectionPanel', () => {
    beforeEach(() => {
        connect.mockReset();
        disconnect.mockReset();
        toastSuccess.mockReset();
    });

    it('not connected: the state in words and the connect form; nothing of a connection', () => {
        render(<EverPlatformConnectionPanel state="loaded" initial={status()} />);
        const state = screen.getByTestId('ever-platform-connection-state');
        expect(state.textContent).toBe('states.disconnected');
        expect(state.getAttribute('data-state')).toBe('disconnected');
        expect(screen.getByTestId('ever-platform-connect-form')).toBeTruthy();
        expect(screen.getByText('whatIsSent')).toBeTruthy();
        expect(screen.queryByTestId('ever-platform-disconnect')).toBeNull();
        expect(screen.queryByTestId('ever-platform-instance-id')).toBeNull();
        expect(screen.queryByTestId('ever-platform-instance-entitlement')).toBeNull();
        expect(screen.queryByTestId('ever-platform-app-sync')).toBeNull();
    });

    it('a code that is not a connect code is refused in the page: no request', async () => {
        render(<EverPlatformConnectionPanel state="loaded" initial={status()} />);
        const submit = screen.getByTestId('ever-platform-connect-submit') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        await userEvent.type(
            screen.getByTestId('ever-platform-connect-code'),
            'EVL-TEST-0000-0002',
        );
        await userEvent.click(submit);
        expect((await screen.findByTestId('ever-platform-connection-error')).textContent).toBe(
            'errors.codeInvalid',
        );
        expect(connect).not.toHaveBeenCalled();
    });

    it('connects with a connect code, shows the connection and forgets the code', async () => {
        connect.mockResolvedValue({ success: true, data: status({}, CONNECTED) });
        render(<EverPlatformConnectionPanel state="loaded" initial={status()} />);
        await userEvent.type(
            screen.getByTestId('ever-platform-connect-code'),
            ' evc-test-0000-0004 ',
        );
        await userEvent.click(screen.getByTestId('ever-platform-connect-submit'));
        await waitFor(() => expect(connect).toHaveBeenCalledWith('evc-test-0000-0004'));
        await waitFor(() =>
            expect(screen.getByTestId('ever-platform-connection-state').textContent).toBe(
                'states.active',
            ),
        );
        expect(screen.getByTestId('ever-platform-instance-id').textContent).toBe(INSTANCE);
        expect(screen.queryByTestId('ever-platform-connect-form')).toBeNull();
        expect(document.body.innerHTML).not.toMatch(/0000-0004/i);
        expect(toastSuccess).toHaveBeenCalled();
    });

    it('a refused code is said in words and the form stays, empty', async () => {
        connect.mockResolvedValue({ success: false, code: 'code_expired' });
        render(<EverPlatformConnectionPanel state="loaded" initial={status()} />);
        const input = screen.getByTestId('ever-platform-connect-code') as HTMLInputElement;
        await userEvent.type(input, 'EVC-TEST-0000-0004');
        await userEvent.click(screen.getByTestId('ever-platform-connect-submit'));
        expect((await screen.findByTestId('ever-platform-connection-error')).textContent).toBe(
            'errors.codeExpired',
        );
        expect(input.value).toBe('');
        expect(screen.getByTestId('ever-platform-connection-state').textContent).toBe(
            'states.disconnected',
        );
    });

    it('the last failed attempt is named while not connected', () => {
        render(
            <EverPlatformConnectionPanel
                state="loaded"
                initial={status({}, { lastError: 'code_invalid' })}
            />,
        );
        expect(screen.getByTestId('ever-platform-last-error').textContent).toBe(
            'lastError:code_invalid',
        );
    });

    it('waiting for approval is said, and can be disconnected', () => {
        render(
            <EverPlatformConnectionPanel
                state="loaded"
                initial={status({}, { ...CONNECTED, status: 'pending_approval' })}
            />,
        );
        expect(screen.getByTestId('ever-platform-connection-state').textContent).toBe(
            'states.pendingApproval',
        );
        expect(screen.getByTestId('ever-platform-pending-approval')).toBeTruthy();
        expect(screen.getByTestId('ever-platform-disconnect')).toBeTruthy();
        expect(screen.queryByTestId('ever-platform-connect-form')).toBeNull();
    });

    it('disconnects only after a confirmation', async () => {
        disconnect.mockResolvedValue({ success: true, data: status() });
        render(<EverPlatformConnectionPanel state="loaded" initial={status({}, CONNECTED)} />);
        await userEvent.click(screen.getByTestId('ever-platform-disconnect'));
        expect(disconnect).not.toHaveBeenCalled();
        expect(screen.getByTestId('ever-platform-disconnect-confirm').textContent).toContain(
            'disconnectConfirm',
        );
        await userEvent.click(screen.getByText('cancel'));
        expect(screen.queryByTestId('ever-platform-disconnect-confirm')).toBeNull();
        expect(disconnect).not.toHaveBeenCalled();

        await userEvent.click(screen.getByTestId('ever-platform-disconnect'));
        await userEvent.click(screen.getByTestId('ever-platform-disconnect-submit'));
        await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(screen.getByTestId('ever-platform-connection-state').textContent).toBe(
                'states.disconnected',
            ),
        );
        expect(screen.getByTestId('ever-platform-connect-form')).toBeTruthy();
    });

    it('the heartbeat, the entitlement and the apps mirror show only when they are switched on', () => {
        const { unmount } = render(
            <EverPlatformConnectionPanel state="loaded" initial={status({}, CONNECTED)} />,
        );
        expect(screen.queryByTestId('ever-platform-heartbeat')).toBeNull();
        expect(screen.queryByTestId('ever-platform-instance-entitlement')).toBeNull();
        expect(screen.queryByTestId('ever-platform-app-sync')).toBeNull();
        unmount();

        render(
            <EverPlatformConnectionPanel
                state="loaded"
                initial={status(
                    {
                        features: {
                            linkCodes: true,
                            heartbeat: true,
                            entitlements: true,
                            appSync: true,
                        },
                        heartbeat: { lastSentAt: '2026-11-13T10:05:00.000Z' },
                        entitlement: {
                            status: 'grace',
                            handle: 'acme',
                            tier: 'paid',
                            plan: 'plan-code',
                            features: { handle: true, lookup: false, 'profile.public': true },
                            limits: {},
                            seq: 3,
                            issuedAt: '2026-11-01T10:00:00.000Z',
                            expiresAt: '2026-11-08T10:00:00.000Z',
                            fetchedAt: '2026-11-13T10:00:00.000Z',
                            lastError: 'rate_limited',
                        },
                        appSync: {
                            linksEnabled: 2,
                            pending: 5,
                            failed: 1,
                            lastError: 'schema_violation',
                            reconciledAt: null,
                        },
                    },
                    CONNECTED,
                )}
            />,
        );
        expect(screen.getByTestId('ever-platform-heartbeat').textContent).toBe(
            '2026-11-13T10:05:00.000Z',
        );
        const entitlement = screen.getByTestId('ever-platform-instance-entitlement');
        expect(
            screen
                .getByTestId('ever-platform-instance-entitlement-status')
                .getAttribute('data-status'),
        ).toBe('grace');
        expect(entitlement.textContent).toContain('plan-code (paid)');
        // Only the features that are on, by name.
        expect(entitlement.textContent).toContain('handle, profile.public');
        expect(entitlement.textContent).not.toContain('lookup');
        expect(screen.getByTestId('ever-platform-instance-entitlement-error').textContent).toBe(
            'rate_limited',
        );
        const mirror = screen.getByTestId('ever-platform-app-sync').textContent ?? '';
        expect(mirror).toContain('1 (schema_violation)');
        expect(mirror).toContain('appSync.never');
    });

    it('an entitlement switched on with no document yet says so', () => {
        render(
            <EverPlatformConnectionPanel
                state="loaded"
                initial={status(
                    {
                        features: {
                            linkCodes: false,
                            heartbeat: false,
                            entitlements: true,
                            appSync: false,
                        },
                    },
                    CONNECTED,
                )}
            />,
        );
        expect(screen.getByTestId('ever-platform-instance-entitlement-none')).toBeTruthy();
    });

    it('says when the connection could not be read, and offers nothing', () => {
        render(<EverPlatformConnectionPanel state="unavailable" initial={null} />);
        expect(screen.getByTestId('ever-platform-connection-unavailable')).toBeTruthy();
        expect(screen.queryByTestId('ever-platform-connect-form')).toBeNull();
    });
});

describe('EverPlatformOrganizationLinks', () => {
    beforeEach(() => {
        link.mockReset();
        unlink.mockReset();
        toastSuccess.mockReset();
    });

    it('not linked on a connected installation: the form for a link code', () => {
        render(<EverPlatformOrganizationLinks organizations={[item(linkView())]} />);
        const row = screen.getByTestId('ever-platform-organization-link');
        expect(row.getAttribute('data-organization')).toBe('acme');
        expect(row.textContent).toContain('Acme');
        expect(screen.getByTestId('ever-platform-link-state').getAttribute('data-state')).toBe(
            'not-linked',
        );
        expect(screen.getByTestId('ever-platform-link-form')).toBeTruthy();
        expect(screen.getByText('whatIsSent')).toBeTruthy();
    });

    it('not connected: no form, and why', () => {
        render(
            <EverPlatformOrganizationLinks
                organizations={[item(linkView({ connected: false }))]}
            />,
        );
        expect(screen.getByTestId('ever-platform-link-not-connected')).toBeTruthy();
        expect(screen.queryByTestId('ever-platform-link-form')).toBeNull();
    });

    it('a code that is not a link code is refused in the page: no request', async () => {
        render(<EverPlatformOrganizationLinks organizations={[item(linkView())]} />);
        await userEvent.type(screen.getByTestId('ever-platform-link-code'), 'EVC-TEST-0000-0004');
        await userEvent.click(screen.getByTestId('ever-platform-link-submit'));
        expect((await screen.findByTestId('ever-platform-link-error')).textContent).toBe(
            'errors.codeInvalid',
        );
        expect(link).not.toHaveBeenCalled();
    });

    it('links with a link code and shows the Ever organization; the code is forgotten', async () => {
        link.mockResolvedValue({
            success: true,
            data: linkView({
                link: {
                    everOrgId: '01JMQCK0RG000000000000000B',
                    handle: 'globex',
                    createdVia: 'link_code',
                    linkedAt: '2026-11-13T10:00:00.000Z',
                },
            }),
        });
        render(<EverPlatformOrganizationLinks organizations={[item(linkView())]} />);
        await userEvent.type(screen.getByTestId('ever-platform-link-code'), 'evl-test-0000-0009');
        await userEvent.click(screen.getByTestId('ever-platform-link-submit'));
        await waitFor(() => expect(link).toHaveBeenCalledWith(ORG, 'evl-test-0000-0009'));
        await waitFor(() =>
            expect(screen.getByTestId('ever-platform-link-organization').textContent).toBe(
                'ever.co/globex',
            ),
        );
        expect(screen.getByTestId('ever-platform-link-state').getAttribute('data-state')).toBe(
            'linked',
        );
        expect(screen.getByTestId('ever-platform-link-app-sync').textContent).toBe('appSyncOff');
        expect(document.body.innerHTML).not.toMatch(/0000-0009/i);
        expect(toastSuccess).toHaveBeenCalled();
    });

    it('a refusal of the API is said in words', async () => {
        link.mockResolvedValue({ success: false, code: 'tenant_already_linked' });
        render(<EverPlatformOrganizationLinks organizations={[item(linkView())]} />);
        await userEvent.type(screen.getByTestId('ever-platform-link-code'), 'EVL-TEST-0000-0009');
        await userEvent.click(screen.getByTestId('ever-platform-link-submit'));
        expect((await screen.findByTestId('ever-platform-link-error')).textContent).toBe(
            'errors.tenantAlreadyLinked',
        );
        expect(screen.getByTestId('ever-platform-link-form')).toBeTruthy();
    });

    it('a link without a known handle shows the Ever organization id; removing needs a confirmation', async () => {
        unlink.mockResolvedValue({ success: true, data: linkView() });
        render(
            <EverPlatformOrganizationLinks
                organizations={[
                    item(
                        linkView({
                            link: {
                                everOrgId: '01JMQCK0RG000000000000000B',
                                handle: null,
                                createdVia: 'provisioning',
                                linkedAt: '2026-11-13T10:00:00.000Z',
                            },
                            appSync: true,
                        }),
                    ),
                ]}
            />,
        );
        expect(screen.getByTestId('ever-platform-link-organization').textContent).toBe(
            '01JMQCK0RG000000000000000B',
        );
        expect(screen.getByText('viaProvisioning')).toBeTruthy();
        expect(screen.getByTestId('ever-platform-link-app-sync').textContent).toBe('appSyncOn');

        await userEvent.click(screen.getByTestId('ever-platform-unlink'));
        expect(unlink).not.toHaveBeenCalled();
        expect(screen.getByTestId('ever-platform-unlink-confirm').textContent).toContain(
            'unlinkConfirm',
        );
        await userEvent.click(screen.getByTestId('ever-platform-unlink-submit'));
        await waitFor(() => expect(unlink).toHaveBeenCalledWith(ORG));
        await waitFor(() =>
            expect(screen.getByTestId('ever-platform-link-state').getAttribute('data-state')).toBe(
                'not-linked',
            ),
        );
    });

    it('a link that could not be removed stays, and the reason is said', async () => {
        unlink.mockResolvedValue({ success: false, code: 'platform_unreachable' });
        render(
            <EverPlatformOrganizationLinks
                organizations={[
                    item(
                        linkView({
                            link: {
                                everOrgId: '01JMQCK0RG000000000000000B',
                                handle: 'globex',
                                createdVia: 'link_code',
                                linkedAt: '2026-11-13T10:00:00.000Z',
                            },
                        }),
                    ),
                ]}
            />,
        );
        await userEvent.click(screen.getByTestId('ever-platform-unlink'));
        await userEvent.click(screen.getByTestId('ever-platform-unlink-submit'));
        expect((await screen.findByTestId('ever-platform-link-error')).textContent).toBe(
            'errors.platformUnreachable',
        );
        expect(screen.getByTestId('ever-platform-link-state').getAttribute('data-state')).toBe(
            'linked',
        );
    });

    it('a link that could not be read says so and offers nothing', () => {
        render(<EverPlatformOrganizationLinks organizations={[item(null)]} />);
        expect(screen.getByTestId('ever-platform-link-state').getAttribute('data-state')).toBe(
            'unknown',
        );
        expect(screen.queryByTestId('ever-platform-link-form')).toBeNull();
        expect(screen.queryByTestId('ever-platform-unlink')).toBeNull();
        expect(screen.queryByTestId('ever-platform-link-admin-only')).toBeNull();
    });

    it('a member who is not an administrator reads a missing link and is not offered the form', () => {
        render(
            <EverPlatformOrganizationLinks
                organizations={[item(linkView({ canManage: false }))]}
            />,
        );
        expect(screen.getByTestId('ever-platform-link-state').getAttribute('data-state')).toBe(
            'not-linked',
        );
        expect(screen.queryByTestId('ever-platform-link-form')).toBeNull();
        expect(screen.queryByTestId('ever-platform-link-code')).toBeNull();
        expect(screen.getByTestId('ever-platform-link-admin-only').textContent).toBe('adminOnly');
        // Control: the same view for an administrator has the form and no such note.
        render(<EverPlatformOrganizationLinks organizations={[item(linkView())]} />);
        expect(screen.getAllByTestId('ever-platform-link-form')).toHaveLength(1);
        expect(screen.getAllByTestId('ever-platform-link-admin-only')).toHaveLength(1);
    });

    it('a member who is not an administrator reads the link and cannot remove it', () => {
        render(
            <EverPlatformOrganizationLinks
                organizations={[
                    item(
                        linkView({
                            canManage: false,
                            link: {
                                everOrgId: '01JMQCK0RG000000000000000B',
                                handle: 'globex',
                                createdVia: 'link_code',
                                linkedAt: '2026-11-13T10:00:00.000Z',
                            },
                            appSync: true,
                        }),
                    ),
                ]}
            />,
        );
        expect(screen.getByTestId('ever-platform-link-organization').textContent).toBe(
            'ever.co/globex',
        );
        expect(screen.getByTestId('ever-platform-link-app-sync').textContent).toBe('appSyncOn');
        expect(screen.queryByTestId('ever-platform-unlink')).toBeNull();
        expect(screen.queryByTestId('ever-platform-unlink-confirm')).toBeNull();
        expect(screen.getByTestId('ever-platform-link-admin-only').textContent).toBe('adminOnly');
        expect(unlink).not.toHaveBeenCalled();
    });

    it('a member who is not an administrator on an installation that is not connected is told that first', () => {
        render(
            <EverPlatformOrganizationLinks
                organizations={[item(linkView({ canManage: false, connected: false }))]}
            />,
        );
        expect(screen.getByTestId('ever-platform-link-not-connected')).toBeTruthy();
        expect(screen.queryByTestId('ever-platform-link-admin-only')).toBeNull();
        expect(screen.queryByTestId('ever-platform-link-form')).toBeNull();
    });
});
