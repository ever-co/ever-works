import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('@/app/actions/save-account', () => ({ saveAnonymousAccount: mocks.save }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { SaveAccountForm } from './SaveAccountForm';

const TERMS = [
    {
        documentId: 'tos:ever-works',
        version: '1.0.2',
        sha256: 'a'.repeat(64),
        locale: 'en',
        url: '/tos',
    },
];

function renderForm() {
    render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <SaveAccountForm
                expiresAt={null}
                termsDocuments={TERMS}
                workNames={['Coffee shops in Lisbon']}
                totalWorks={1}
            />
        </NextIntlClientProvider>,
    );
}

async function fillAndSubmit(username = '') {
    await userEvent.type(screen.getByLabelText('Email address'), 'jane@example.com');
    if (username) await userEvent.type(screen.getByLabelText('Username (optional)'), username);
    await userEvent.type(screen.getByLabelText('Password'), 'MySecure123!');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'MySecure123!');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('save-account-submit'));
}

describe('SaveAccountForm', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => cleanup());

    it('posts the optional username with the rest', async () => {
        mocks.save.mockResolvedValue(undefined);
        renderForm();

        await fillAndSubmit('jane-doe');

        expect(mocks.save).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'jane@example.com',
                password: 'MySecure123!',
                username: 'jane-doe',
            }),
        );
    });

    it('says what a typed username will be saved as', async () => {
        renderForm();

        await userEvent.type(screen.getByLabelText('Username (optional)'), 'Jane Doe');

        expect(screen.getByText('Saved as jane-doe')).toBeInTheDocument();
    });

    it('refuses a username with nothing usable before submit, without calling the server', async () => {
        renderForm();

        await fillAndSubmit('!!!');

        expect(
            await screen.findByText(
                'Use at least 3 letters, digits or dashes, or leave the username empty',
            ),
        ).toBeInTheDocument();
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it('shows a taken username under the username field', async () => {
        mocks.save.mockResolvedValue({
            success: false,
            error: 'This username is taken. Try jane-doe-2, or leave it empty.',
            field: 'username',
        });
        renderForm();

        await fillAndSubmit('jane-doe');

        expect(
            await screen.findByText('This username is taken. Try jane-doe-2, or leave it empty.'),
        ).toBeInTheDocument();
    });

    it('swaps the form for "start again / sign in" once the temporary session has ended', async () => {
        mocks.save.mockResolvedValue({
            success: false,
            error: 'ended',
            reason: 'session_ended',
        });
        renderForm();

        await fillAndSubmit();

        const ended = await screen.findByTestId('save-account-session-ended');
        expect(ended).toHaveTextContent('Your temporary session has ended');
        expect(screen.getByRole('link', { name: 'Start again' })).toHaveAttribute(
            'href',
            '/onboarding',
        );
        expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
        expect(screen.queryByTestId('save-account-submit')).toBeNull();
    });
});
