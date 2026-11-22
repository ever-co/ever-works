import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const mocks = vi.hoisted(() => ({ logout: vi.fn(), push: vi.fn() }));

vi.mock('@/app/actions/auth', () => ({ logout: mocks.logout }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: mocks.push }),
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import {
    TemporaryAccountSignOutDialog,
    useTemporaryAccountSignOut,
} from './TemporaryAccountSignOutDialog';

function renderDialog(onOpenChange = vi.fn()) {
    render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TemporaryAccountSignOutDialog open onOpenChange={onOpenChange} />
        </NextIntlClientProvider>,
    );
    return onOpenChange;
}

describe('useTemporaryAccountSignOut', () => {
    it('lets any other account sign out exactly as before', () => {
        const { result } = renderHook(() => useTemporaryAccountSignOut(false));

        let stopped = true;
        act(() => {
            stopped = result.current.offerSaveFirst();
        });

        expect(stopped).toBe(false);
        expect(result.current.dialogProps.open).toBe(false);
    });

    it('stops a temporary account and opens the dialog instead', () => {
        const { result } = renderHook(() => useTemporaryAccountSignOut(true));

        let stopped = false;
        act(() => {
            stopped = result.current.offerSaveFirst();
        });

        expect(stopped).toBe(true);
        expect(result.current.dialogProps.open).toBe(true);
    });
});

describe('TemporaryAccountSignOutDialog', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => cleanup());

    it('says the Works go with a temporary account', () => {
        renderDialog();

        const dialog = screen.getByTestId('temporary-account-sign-out-dialog');
        expect(dialog).toHaveTextContent('Sign out of a temporary account?');
        expect(dialog).toHaveTextContent('its Works are deleted with it');
    });

    it('"Save my account" goes to the save page and does not sign out', async () => {
        const onOpenChange = renderDialog();

        await userEvent.click(screen.getByTestId('temporary-account-sign-out-save'));

        expect(mocks.push).toHaveBeenCalledWith('/save-account');
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(mocks.logout).not.toHaveBeenCalled();
    });

    it('"Sign out anyway" signs out', async () => {
        renderDialog();

        await userEvent.click(screen.getByTestId('temporary-account-sign-out-confirm'));

        expect(mocks.logout).toHaveBeenCalledTimes(1);
    });
});
