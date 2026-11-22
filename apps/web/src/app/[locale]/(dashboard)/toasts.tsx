'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { APP_NAME } from '@/lib/constants';
import { OAuthProvider } from '@/lib/api/enums';
import { VERIFY_EMAIL_PARAM, VERIFY_EMAIL_REQUIRED } from '@/lib/auth/unverified-email';
import { ACCOUNT_SAVED_PARAM } from '@/lib/anonymous/account-saved';
import {
    ACCOUNT_SAVED_WITH_PARAM,
    isSaveAccountOAuthProvider,
} from '@/lib/anonymous/save-account-oauth';

export default function DashboardToasts() {
    const searchParams = useSearchParams();
    const t = useTranslations('dashboard.toasts');
    const tSaved = useTranslations('anonymousAccount.saved');

    const isNewUser = searchParams.get('newUser') === 'true';
    const isAccountSaved = searchParams.get(ACCOUNT_SAVED_PARAM) === 'true';
    // EW-617: saved with GitHub / Google rather than a password. Allow-listed like
    // `oauth_provider` below, so a crafted URL cannot put its own words in the notice.
    const savedWithRaw = searchParams.get(ACCOUNT_SAVED_WITH_PARAM);
    const savedWith = isSaveAccountOAuthProvider(savedWithRaw)
        ? savedWithRaw === OAuthProvider.GITHUB
            ? 'GitHub'
            : 'Google'
        : null;
    const isVerified = searchParams.get('verified') === 'true';
    // EW-077 / EW-080: set by `register` and `redeemMagicLink` when the session
    // they just minted belongs to an address nobody has confirmed yet.
    const isEmailUnconfirmed =
        searchParams.get(VERIFY_EMAIL_PARAM) === VERIFY_EMAIL_REQUIRED && !isVerified;
    const isOAuthConnected = searchParams.get('oauth_connected') === 'true';
    const oauthError = searchParams.get('oauth_error');
    // Security: validate oauth_provider against a known allow-list before
    // embedding it in toast messages. An attacker can craft a redirect URL with
    // any arbitrary string in this query param (social-engineering / UI redress).
    // Unrecognised values fall back to the default provider label.
    const oauthProviderRaw = searchParams.get('oauth_provider');
    const oauthProvider = Object.values(OAuthProvider).includes(oauthProviderRaw as OAuthProvider)
        ? oauthProviderRaw
        : null;

    const providerLabel = oauthProvider
        ? oauthProvider
              .split(/[-_]/)
              .filter(Boolean)
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join(' ')
        : t('oauthConnected.defaultProvider');

    useEffect(() => {
        if (isNewUser) {
            // Show welcome toast for new users
            toast.success(t('newUser.title', { companyName: APP_NAME }), {
                description: t('newUser.description'),
                duration: 6000,
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                        />
                    </svg>
                ),
            });
        }

        // EW-077 / EW-080: the honest version of the old reminder.
        //
        // This used to fire inside the `isNewUser` branch above, unconditionally
        // and with no idea whether the address actually needed confirming — so
        // it told people to check their inbox even when the deployment does not
        // require verification at all. Worse, it described only the email
        // ("we've sent a link, check your spam folder") and never the part that
        // matters: that this session keeps working, and the NEXT one will not.
        // That omission is the whole of EW-077 — the gate looked like a new
        // failure days later because nothing ever announced it.
        //
        // Now it fires on the actual state reported by the API, says what
        // happens next, and does not auto-dismiss: a 4-second toast is not a
        // reasonable way to deliver "you will be locked out later". The
        // matching persistent banner (with a working Resend button) lives in
        // profile settings, which is where the copy points.
        if (isEmailUnconfirmed) {
            toast.warning(t('emailVerification.title'), {
                description: t('emailVerification.pendingDescription'),
                duration: Infinity,
                closeButton: true,
            });
        }

        if (isVerified) {
            // Show email verified success toast
            toast.success(t('verified.title'), {
                description: t('verified.description'),
                duration: 5000,
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
            });
        }

        if (isOAuthConnected) {
            toast.success(t('oauthConnected.title'), {
                description: t('oauthConnected.description', { provider: providerLabel }),
                duration: 5000,
                icon: (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                    </svg>
                ),
            });
        }

        if (oauthError === 'oauth_provider_conflict') {
            toast.error(t('oauthConflict.title'), {
                description: t('oauthConflict.description', { provider: providerLabel }),
                duration: 6000,
            });
        } else if (oauthError) {
            toast.error(t('oauthConnectFailed.title'), {
                description: t('oauthConnectFailed.description', { provider: providerLabel }),
                duration: 6000,
            });
        }

        // EW-617 G3: set by `saveAnonymousAccount` once a temporary account is saved.
        if (isAccountSaved) {
            toast.success(tSaved('title'), {
                id: 'account-saved',
                description: savedWith
                    ? tSaved('descriptionWithProvider', { provider: savedWith })
                    : tSaved('description'),
                duration: 6000,
            });
        }

        // Clean up URL after showing toasts
        if (
            isNewUser ||
            isVerified ||
            isOAuthConnected ||
            oauthError ||
            isEmailUnconfirmed ||
            isAccountSaved
        ) {
            const timer = setTimeout(() => {
                // Remove query params without page refresh
                const url = new URL(window.location.href);
                url.searchParams.delete(ACCOUNT_SAVED_PARAM);
                url.searchParams.delete(ACCOUNT_SAVED_WITH_PARAM);
                url.searchParams.delete('newUser');
                url.searchParams.delete('verified');
                url.searchParams.delete('oauth_connected');
                url.searchParams.delete('oauth_error');
                url.searchParams.delete('oauth_provider');
                url.searchParams.delete(VERIFY_EMAIL_PARAM);
                window.history.replaceState({}, '', url.pathname + url.search);
            }, 1000);

            return () => clearTimeout(timer);
        }
    }, [
        isNewUser,
        isVerified,
        isOAuthConnected,
        oauthError,
        isEmailUnconfirmed,
        isAccountSaved,
        savedWith,
        providerLabel,
        t,
        tSaved,
    ]);

    return null; // This component doesn't render anything
}
