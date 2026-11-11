import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SeatsState } from '@/lib/api/billing.shared';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
const { toastSuccess, toastError, updateSeats } = vi.hoisted(() => ({
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    updateSeats: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/app/actions/dashboard/billing', () => ({
    cancelSubscriptionAction: vi.fn(),
    changePlanAction: vi.fn(),
    openBillingPortalAction: vi.fn(),
    resumeSubscriptionAction: vi.fn(),
    startCreditCheckoutAction: vi.fn(),
    startPlanCheckoutAction: vi.fn(),
    updateAutoRechargeAction: vi.fn(),
    updatePaygAction: vi.fn(),
    updateSeatsAction: (seats: number) => updateSeats(seats),
}));

import { BillingSettings } from './BillingSettings';

const seats: SeatsState = {
    included: 5,
    purchased: 0,
    allowance: 5,
    members: 2,
    agents: 1,
    used: 3,
    available: 2,
    seatPriceCents: 900,
    purchasable: true,
};

function renderSeats() {
    render(
        <BillingSettings
            paymentsEnabled
            initialPlan={null}
            initialPlans={null}
            initialBalance={null}
            initialLedger={null}
            initialOverview={null}
            initialInvoices={null}
            initialSeats={seats}
        />,
    );
}

/**
 * Review of #3172 — the seats input's `max` bounds only its spinner (it is in
 * no form), so a typed 15000 reached the API and came back as a generic 400.
 */
describe('BillingSettings — seats above the API cap', () => {
    beforeEach(() => {
        updateSeats.mockReset();
        toastSuccess.mockReset();
        toastError.mockReset();
    });

    it('refuses more than 10,000 seats with its own message and calls no API', async () => {
        renderSeats();
        fireEvent.change(screen.getByTestId('billing-seats-input'), {
            target: { value: '15000' },
        });
        fireEvent.click(screen.getByTestId('billing-seats-save'));

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith('seats.tooMany:{"max":"10,000"}'),
        );
        expect(updateSeats).not.toHaveBeenCalled();
    });

    it('still saves 10,000 exactly', async () => {
        updateSeats.mockResolvedValue({ success: true, seats: { ...seats, allowance: 10_000 } });
        renderSeats();
        fireEvent.change(screen.getByTestId('billing-seats-input'), {
            target: { value: '10000' },
        });
        fireEvent.click(screen.getByTestId('billing-seats-save'));

        await waitFor(() => expect(updateSeats).toHaveBeenCalledWith(10_000));
        expect(toastError).not.toHaveBeenCalled();
    });
});
