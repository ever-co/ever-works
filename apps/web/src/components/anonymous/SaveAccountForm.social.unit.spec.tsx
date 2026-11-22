import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
    saveAnonymousAccount: vi.fn(),
    startSavingWithProvider: vi.fn(),
    connectProvider: vi.fn(),
}));

// Echo the key, plus the values when there are any, so each message is identified by its key.
vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}));
vi.mock('@/app/actions/save-account', () => ({
    saveAnonymousAccount: mocks.saveAnonymousAccount,
    startSavingWithProvider: mocks.startSavingWithProvider,
}));
vi.mock('@/app/actions/auth', () => ({ connectProvider: mocks.connectProvider }));
// `Button` reaches @/i18n/navigation, whose next-intl client entry does not resolve under
// vitest's ESM loader — the same stub the other component specs use.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { SaveAccountForm } from './SaveAccountForm';
import { OAuthProvider } from '@/lib/api/enums';

const DOCUMENTS = [
    {
        documentId: 'tos:ever-works',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        locale: 'en',
        url: '/tos',
        title: 'Terms of Service',
    },
] as never[];

const CLAIMS = [
    { documentId: 'tos:ever-works', version: '1.0.0', sha256: 'a'.repeat(64), locale: 'en' },
];

const renderForm = (props: Partial<Parameters<typeof SaveAccountForm>[0]> = {}) =>
    render(
        <SaveAccountForm
            expiresAt={null}
            termsDocuments={DOCUMENTS}
            workNames={['my-directory']}
            totalWorks={1}
            socialProviders={[OAuthProvider.GITHUB, OAuthProvider.GOOGLE]}
            {...props}
        />,
    );

const providerButton = (label: 'github' | 'google') =>
    screen.getByRole('button', { name: `auth.login.socialLogin.${label}` });

describe('SaveAccountForm — saving with GitHub / Google (EW-617)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // A hash change is the one navigation jsdom performs.
        mocks.startSavingWithProvider.mockResolvedValue({ success: true, url: '#provider' });
    });

    it('offers no provider when the API has none configured', () => {
        renderForm({ socialProviders: [] });

        expect(screen.queryByTestId('save-account-social')).toBeNull();
    });

    it('keeps the providers behind the same consent gate as the email path', () => {
        renderForm();

        for (const name of ['github', 'google'] as const) {
            expect(providerButton(name)).toBeDisabled();
            expect(providerButton(name).getAttribute('title')).toBe(
                'anonymousAccount.save.providerNeedsTerms',
            );
        }

        fireEvent.click(screen.getByRole('checkbox'));

        expect(providerButton('github')).not.toBeDisabled();
        expect(providerButton('google')).not.toBeDisabled();
    });

    it('keeps them disabled when the legal documents could not be loaded', () => {
        renderForm({ termsDocuments: [] });

        expect(providerButton('github')).toBeDisabled();
    });

    it('starts a SAVE (not a sign-in) with the documents exactly as displayed', async () => {
        renderForm();
        fireEvent.click(screen.getByRole('checkbox'));

        await act(async () => {
            fireEvent.click(providerButton('github'));
        });

        await waitFor(() =>
            expect(mocks.startSavingWithProvider).toHaveBeenCalledWith('github', CLAIMS),
        );
        expect(mocks.connectProvider).not.toHaveBeenCalled();
        expect(mocks.saveAnonymousAccount).not.toHaveBeenCalled();
    });

    it('shows why the round trip could not start', async () => {
        mocks.startSavingWithProvider.mockResolvedValue({
            success: false,
            error: 'could not start',
        });
        renderForm();
        fireEvent.click(screen.getByRole('checkbox'));

        await act(async () => {
            fireEvent.click(providerButton('google'));
        });

        expect(await screen.findByRole('alert')).toHaveTextContent('could not start');
    });

    it('says why the callback refused the save, naming the provider', () => {
        renderForm({ oauthError: { error: 'identity_taken', provider: OAuthProvider.GITHUB } });

        expect(screen.getByRole('alert')).toHaveTextContent(
            'anonymousAccount.save.errors.oauth.identity_taken:{"provider":"auth.login.socialLogin.github"}',
        );
    });

    it('falls back to the generic message when the URL names no known provider', () => {
        renderForm({ oauthError: { error: 'email_taken', provider: null } });

        expect(screen.getByRole('alert')).toHaveTextContent('anonymousAccount.save.errors.generic');
    });
});
