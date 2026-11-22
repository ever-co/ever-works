import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAuthFromCookie: vi.fn(),
    getDemoConfig: vi.fn(),
    wasSignedOutByEverId: vi.fn(),
    hasEverIdSignOutMarker: vi.fn(),
    getAuthProvidersConfig: vi.fn(),
    isEverIdOffered: vi.fn(),
    hasSavableAnonymousSession: vi.fn(),
    redirect: vi.fn(() => {
        throw new Error('NEXT_REDIRECT');
    }),
}));

vi.mock('next-intl/server', () => ({
    getLocale: async () => 'en',
    getTranslations: async () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth', () => ({
    getAuthFromCookieOnSignIn: mocks.getAuthFromCookie,
    wasSignedOutByEverId: mocks.wasSignedOutByEverId,
}));
vi.mock('@/lib/auth/ever-id-signed-out', () => ({
    hasEverIdSignOutMarker: mocks.hasEverIdSignOutMarker,
}));
vi.mock('@/lib/auth/providers', () => ({ getAuthProvidersConfig: mocks.getAuthProvidersConfig }));
vi.mock('@/lib/feature-flags/ever-id', () => ({
    EVER_ID_ANONYMOUS_DISTINCT_ID: 'anonymous',
    isEverIdOffered: mocks.isEverIdOffered,
}));
vi.mock('@/lib/feature-flags/demo', () => ({ getDemoConfig: mocks.getDemoConfig }));
vi.mock('./login-client', () => ({ LoginClient: () => null }));
vi.mock('@/lib/anonymous/save-account-strip', () => ({
    hasSavableAnonymousSession: mocks.hasSavableAnonymousSession,
}));

import { ROUTES } from '@/lib/constants';
import LoginPage from './page';
import { LoginClient } from './login-client';

/**
 * APW-12 — what the sign-in page hands its client: the Ever ID button only when
 * the switch and the flag allow it, and the S6 notice ("You were signed out of
 * Ever ID.") when this request saw the API end the stale session OR an earlier
 * action already removed the cookie and left the marker. A signed-in visitor is
 * redirected before any of it is looked at.
 */

type LoginClientProps = ComponentProps<typeof LoginClient>;

const EVER_ID_OFF = { enabled: false, displayName: 'Ever ID' };

async function renderedClientProps(): Promise<LoginClientProps> {
    const page = (await LoginPage()) as ReactElement<{ children: ReactElement<LoginClientProps> }>;
    const client = page.props.children;
    expect(client.type).toBe(LoginClient);
    return client.props;
}

describe('LoginPage — Ever ID props', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthFromCookie.mockResolvedValue(null);
        mocks.getDemoConfig.mockResolvedValue({
            enabled: false,
            signUpUrl: 'u',
            sandboxTtlHours: 24,
        });
        mocks.wasSignedOutByEverId.mockReturnValue(false);
        mocks.hasEverIdSignOutMarker.mockResolvedValue(false);
        mocks.isEverIdOffered.mockResolvedValue(false);
        mocks.getAuthProvidersConfig.mockResolvedValue({
            socialProviders: ['github'],
            magicLinkEnabled: true,
            everId: EVER_ID_OFF,
        });
    });

    it('keeps the existing props and shows nothing new while Ever ID is off', async () => {
        const props = await renderedClientProps();

        expect(props).toMatchObject({
            availableSocialProviders: ['github'],
            magicLinkEnabled: true,
            everIdEnabled: false,
            signedOutByEverId: false,
        });
        expect(mocks.isEverIdOffered).toHaveBeenCalledWith(EVER_ID_OFF, 'anonymous');
    });

    it('hands the client no demo block when demo is off', async () => {
        expect((await renderedClientProps()).demo).toBeNull();
    });

    it('hands the client the demo block (TTL) when demo is on', async () => {
        mocks.getDemoConfig.mockResolvedValue({
            enabled: true,
            signUpUrl: 'u',
            sandboxTtlHours: 12,
        });
        expect((await renderedClientProps()).demo).toEqual({ ttlHours: 12 });
    });

    // R42 b: the demo config and the auth providers are two independent reads of the API; the
    // page asks for both at once instead of one after the other. The props are the same.
    it('asks for the demo config while the auth providers are still loading', async () => {
        let releaseProviders: (value: unknown) => void = () => undefined;
        mocks.getAuthProvidersConfig.mockReturnValue(
            new Promise((resolve) => {
                releaseProviders = resolve;
            }),
        );

        const page = LoginPage();
        await vi.waitFor(() => expect(mocks.getDemoConfig).toHaveBeenCalledTimes(1));
        releaseProviders({
            socialProviders: ['github'],
            magicLinkEnabled: true,
            everId: EVER_ID_OFF,
        });

        const client = ((await page) as ReactElement<{ children: ReactElement<LoginClientProps> }>)
            .props.children;
        expect(client.props).toMatchObject({
            availableSocialProviders: ['github'],
            magicLinkEnabled: true,
            demo: null,
        });
    });

    it('offers the button when the switch and the flag allow it', async () => {
        mocks.isEverIdOffered.mockResolvedValue(true);

        expect((await renderedClientProps()).everIdEnabled).toBe(true);
    });

    it('shows the S6 notice when this request saw the API end the stale session', async () => {
        mocks.wasSignedOutByEverId.mockReturnValue(true);

        expect((await renderedClientProps()).signedOutByEverId).toBe(true);
        // Already known; the marker is not consulted.
        expect(mocks.hasEverIdSignOutMarker).not.toHaveBeenCalled();
    });

    it('shows the S6 notice from the marker when the cookie was already removed', async () => {
        mocks.hasEverIdSignOutMarker.mockResolvedValue(true);

        expect((await renderedClientProps()).signedOutByEverId).toBe(true);
    });

    it('redirects a signed-in visitor before looking at the flag or the marker', async () => {
        mocks.getAuthFromCookie.mockResolvedValue({ id: 'u1' });

        await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT');
        expect(mocks.redirect).toHaveBeenCalledWith({ locale: 'en', href: ROUTES.DASHBOARD });
        expect(mocks.isEverIdOffered).not.toHaveBeenCalled();
        expect(mocks.hasEverIdSignOutMarker).not.toHaveBeenCalled();
    });
});

// EW-617: a temporary (anonymous) account used to be bounced to the dashboard like any
// signed-in visitor, with no word about what signing in to another account does to its Works.
describe('LoginPage — temporary account', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthProvidersConfig.mockResolvedValue({
            socialProviders: [],
            magicLinkEnabled: false,
            everId: EVER_ID_OFF,
        });
        mocks.getDemoConfig.mockResolvedValue({ enabled: false, sandboxTtlHours: 24 });
        mocks.isEverIdOffered.mockResolvedValue(false);
        mocks.wasSignedOutByEverId.mockReturnValue(false);
        mocks.hasEverIdSignOutMarker.mockResolvedValue(false);
    });

    it('shows a temporary account the form with the warning instead of redirecting', async () => {
        mocks.getAuthFromCookie.mockResolvedValue({ id: 'u-anon', isAnonymous: true });
        mocks.hasSavableAnonymousSession.mockResolvedValue(true);

        const props = await renderedClientProps();

        expect(props.temporaryAccount).toBe(true);
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('still sends a registered account to the dashboard, without the extra read', async () => {
        mocks.getAuthFromCookie.mockResolvedValue({ id: 'u-1', isAnonymous: false });

        await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT');
        expect(mocks.redirect).toHaveBeenCalledWith({ locale: 'en', href: ROUTES.DASHBOARD });
        expect(mocks.hasSavableAnonymousSession).not.toHaveBeenCalled();
    });

    it('sends an anonymous session the strip rules refuse (demo) to the dashboard', async () => {
        mocks.getAuthFromCookie.mockResolvedValue({ id: 'u-demo', isAnonymous: true });
        mocks.hasSavableAnonymousSession.mockResolvedValue(false);

        await expect(LoginPage()).rejects.toThrow('NEXT_REDIRECT');
    });

    it('asks nothing about a temporary account for a signed-out visitor', async () => {
        mocks.getAuthFromCookie.mockResolvedValue(null);

        const props = await renderedClientProps();

        expect(props.temporaryAccount).toBe(false);
        expect(mocks.hasSavableAnonymousSession).not.toHaveBeenCalled();
    });
});
