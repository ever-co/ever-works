import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FleetCloudOptionsView } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/app/actions/dashboard/oauth', () => ({ connectOAuthProvider: vi.fn() }));

const { listProviders, loadOptions, createCloud } = vi.hoisted(() => ({
    listProviders: vi.fn(),
    loadOptions: vi.fn(),
    createCloud: vi.fn(),
}));
vi.mock('@/app/actions/fleet/cloud', () => ({
    listFleetCloudProvidersAction: () => listProviders(),
    fleetCloudOptionsAction: (pluginId: string) => loadOptions(pluginId),
    createFleetCloudAction: (input: unknown) => createCloud(input),
}));

import { NewCloudComputerDialog } from './NewCloudComputerDialog';

const options = (
    overlayVpn: FleetCloudOptionsView['software'][number] | null,
): FleetCloudOptionsView => ({
    pluginId: 'hetzner',
    providerName: 'Hetzner',
    regions: [{ id: 'fsn1', label: 'Falkenstein', available: true }],
    sizes: [
        {
            id: 'cx22',
            label: 'CX22',
            vcpus: 2,
            memoryMiB: 4096,
            diskGiB: 40,
            priceHourlyCents: 1,
            priceMonthlyCents: 500,
            regions: [],
            available: true,
        },
    ],
    software: [{ id: 'docker', default: true }, ...(overlayVpn ? [overlayVpn] : [])],
    billsWhileOff: true,
    currency: 'USD',
    account: { label: 'me@example.test' },
    imageLabel: null,
    fetchedAt: '2026-11-11T00:00:00.000Z',
    limits: { maxPerOwner: 5, used: 0 },
});

async function openWith(view: FleetCloudOptionsView) {
    loadOptions.mockResolvedValue({ ok: true, data: view });
    render(<NewCloudComputerDialog open onClose={() => undefined} />);
    await waitFor(() => expect(loadOptions).toHaveBeenCalledWith('hetzner'));
}

/**
 * Review of #3172 — the overlay-VPN auth-key field shows only where create
 * accepts a key. A deployment that installs the client but has no join
 * command answers `acceptsAuthKey: false` and refuses a key on create.
 */
describe('NewCloudComputerDialog — the overlay-VPN key field', () => {
    beforeEach(() => {
        listProviders.mockReset();
        loadOptions.mockReset();
        createCloud.mockReset();
        listProviders.mockResolvedValue({
            ok: true,
            data: {
                providers: [
                    {
                        pluginId: 'hetzner',
                        name: 'Hetzner',
                        providerName: 'Hetzner',
                        configured: true,
                        account: null,
                        oauthAvailable: false,
                    },
                ],
            },
        });
    });

    it('hides the key field when the deployment cannot use a key', async () => {
        await openWith(options({ id: 'overlay-vpn', default: false, acceptsAuthKey: false }));
        fireEvent.click(await screen.findByTestId('fleet-cloud-software-overlay-vpn'));
        expect(
            (screen.getByTestId('fleet-cloud-software-overlay-vpn') as HTMLInputElement).checked,
        ).toBe(true);
        expect(screen.queryByTestId('fleet-cloud-vpn-key')).toBeNull();
    });

    it('shows it when the deployment accepts a key', async () => {
        await openWith(options({ id: 'overlay-vpn', default: false, acceptsAuthKey: true }));
        expect(screen.queryByTestId('fleet-cloud-vpn-key')).toBeNull();
        fireEvent.click(await screen.findByTestId('fleet-cloud-software-overlay-vpn'));
        expect(screen.getByTestId('fleet-cloud-vpn-key')).toBeTruthy();
    });

    it('shows it for an older API that sends no flag', async () => {
        await openWith(options({ id: 'overlay-vpn', default: false }));
        fireEvent.click(await screen.findByTestId('fleet-cloud-software-overlay-vpn'));
        expect(screen.getByTestId('fleet-cloud-vpn-key')).toBeTruthy();
    });
});
