'use client';

import { useState, useTransition } from 'react';
import { Folder } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { COMPANY_OWNER_WEBSITE, ROUTES } from '@/lib/constants';
import { PASSWORD_RULES } from '@/app/actions/validation';
import { isUsableUsername, normalizeUsername, USERNAME_MIN_LENGTH } from '@/lib/anonymous/username';
import {
    saveAnonymousAccount,
    startSavingWithProvider,
    type SaveAccountField,
} from '@/app/actions/save-account';
import { SocialLoginButtons } from '@/components/auth/social-login';
import { timeLeft } from '@/lib/anonymous/time-left';
import type { SaveAccountOAuthError } from '@/lib/anonymous/save-account-oauth';
import { OAuthProvider } from '@/lib/api/enums';
import type { TermsAcceptanceDocument } from '@/lib/api/types-only';

export interface SaveAccountFormProps {
    /** The account's `anonymousExpiresAt`, ISO 8601; null when unknown. */
    expiresAt: string | null;
    /** The legal documents to accept, from `GET /terms/required`; empty = could not be loaded. */
    termsDocuments: TermsAcceptanceDocument[];
    /** Names of the account's first few Works, to show what is kept. */
    workNames: string[];
    /** How many Works the account has in all; null when the list could not be read. */
    totalWorks: number | null;
    /** GitHub / Google, when the API has them configured: they save the account too. */
    socialProviders?: OAuthProvider[];
    /** Why the last save with a provider was refused, from the OAuth callback's redirect. */
    oauthError?: { error: SaveAccountOAuthError; provider: OAuthProvider | null } | null;
}

type FieldErrors = Partial<Record<SaveAccountField | 'confirmPassword' | 'general', string>>;

/**
 * EW-617 G3 — the save-account form: an email, a password, an optional username and the
 * terms, posted to
 * `saveAnonymousAccount` (`POST /auth/claim`). It reuses the sign-up form's labels, rules
 * and terms handling, so both ways of getting an account read and behave the same, and it
 * names the Works that stay, which is the whole point of the page.
 */
export function SaveAccountForm({
    expiresAt,
    termsDocuments,
    workNames,
    totalWorks,
    socialProviders = [],
    oauthError = null,
}: SaveAccountFormProps) {
    const t = useTranslations('anonymousAccount.save');
    const tForm = useTranslations('auth.register.form');
    const tRegisterErrors = useTranslations('auth.register.errors');
    const tv = useTranslations('validation.auth');
    const tSocial = useTranslations('auth.login.socialLogin');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [isRetrying, startRetry] = useTransition();
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    // The temporary session ended mid-form: nothing is left to save, so the form gives way to
    // "start again" and "sign in" instead of a "try again" that cannot work.
    const [sessionEnded, setSessionEnded] = useState(false);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [acceptedTerms, setAcceptedTerms] = useState(false);
    const [errors, setErrors] = useState<FieldErrors>(() => {
        if (!oauthError) return {};
        // The provider name is only shown when the callback named a known one.
        if (!oauthError.provider) return { general: t('errors.generic') };
        const provider =
            oauthError.provider === OAuthProvider.GITHUB ? tSocial('github') : tSocial('google');
        return { general: t(`errors.oauth.${oauthError.error}`, { provider }) };
    });

    const termsUnavailable = termsDocuments.length === 0;
    const typedUsername = username.trim();
    const usernamePreview =
        typedUsername &&
        isUsableUsername(typedUsername) &&
        normalizeUsername(typedUsername) !== typedUsername
            ? normalizeUsername(typedUsername)
            : null;
    const left = timeLeft(expiresAt);
    const moreWorks = totalWorks !== null ? Math.max(0, totalWorks - workNames.length) : 0;

    // Same source as the sign-up form: the document's own site-relative URL on the company site.
    const legalHref = (kind: 'tos' | 'privacy') => {
        const doc = termsDocuments.find((d) => d.documentId.startsWith(`${kind}:`));
        return new URL(doc?.url || `/${kind}`, COMPANY_OWNER_WEBSITE).toString();
    };

    // The rules the action enforces, in its order, so the field says why before a round trip.
    const passwordError = (value: string): string | undefined => {
        if (value.length < PASSWORD_RULES.MIN_LENGTH)
            return tv('password.minLength', { length: 8 });
        if (!PASSWORD_RULES.LOWERCASE.test(value)) return tv('password.lowercase');
        if (!PASSWORD_RULES.NUMBER_OR_SPECIAL.test(value)) return tv('password.numberOrSpecial');
        if (!PASSWORD_RULES.NOT_STARTING_WITH_DOT_OR_NEWLINE.test(value)) {
            return tv('password.cannotStartWith');
        }
        return undefined;
    };

    // The documents exactly as displayed: both ways of saving post the same claims.
    const termsClaims = () =>
        termsDocuments.map(({ documentId, version, sha256, locale }) => ({
            documentId,
            version,
            sha256,
            locale,
        }));

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        setErrors({});

        const trimmedUsername = username.trim();
        if (!isUsableUsername(trimmedUsername)) {
            setErrors({ username: t('errors.usernameTooShort', { length: USERNAME_MIN_LENGTH }) });
            return;
        }

        const invalidPassword = passwordError(password);
        if (invalidPassword) {
            setErrors({ password: invalidPassword });
            return;
        }
        if (password !== confirmPassword) {
            setErrors({ confirmPassword: tRegisterErrors('passwordsDoNotMatch') });
            return;
        }
        if (!acceptedTerms || termsUnavailable) {
            setErrors({ terms: tRegisterErrors('termsNotAccepted') });
            return;
        }

        startTransition(async () => {
            // Redirects to the dashboard on success; only a failure comes back.
            const result = await saveAnonymousAccount({
                email,
                password,
                username: trimmedUsername,
                terms: termsClaims(),
            });
            if (result?.reason === 'session_ended') {
                setSessionEnded(true);
                return;
            }
            if (result && !result.success) {
                setErrors(
                    result.field ? { [result.field]: result.error } : { general: result.error },
                );
            }
        });
    };

    const deadline =
        left.kind === 'days'
            ? t('deadlineDays', { days: left.days, hours: left.hours })
            : left.kind === 'hours'
              ? t('deadlineHours', { hours: left.hours })
              : left.kind === 'soon'
                ? t('deadlineSoon')
                : t('deadlineUnknown');

    return (
        <div className="mx-auto w-full max-w-xl px-6 py-10">
            <h1 className="text-xl font-medium text-text dark:text-text-dark">{t('title')}</h1>
            <p className="mt-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                {t('intro')}
            </p>
            <p
                className="mt-2 text-sm tabular-nums text-amber-800 dark:text-amber-200"
                data-testid="save-account-deadline"
                suppressHydrationWarning
            >
                {deadline}
            </p>

            {workNames.length > 0 && (
                <section
                    aria-labelledby="save-account-works"
                    className="mt-6 rounded-xl border border-border dark:border-border-dark px-4 py-3"
                >
                    <h2
                        id="save-account-works"
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        {t('worksHeading')}
                    </h2>
                    <ul className="mt-2 space-y-1" data-testid="save-account-works">
                        {workNames.map((name, index) => (
                            <li
                                key={`${index}-${name}`}
                                className="flex items-center gap-2 text-sm text-text dark:text-text-dark"
                            >
                                <Folder
                                    className="h-4 w-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                    aria-hidden="true"
                                />
                                <span className="truncate">{name}</span>
                            </li>
                        ))}
                    </ul>
                    {moreWorks > 0 && (
                        <p className="mt-1 pl-6 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('worksMore', { count: moreWorks })}
                        </p>
                    )}
                </section>
            )}

            {sessionEnded ? (
                <div
                    role="alert"
                    data-testid="save-account-session-ended"
                    className="mt-6 space-y-3 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm"
                >
                    <p className="text-text dark:text-text-dark">{t('errors.sessionEnded')}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button href={ROUTES.ONBOARDING} size="sm">
                            {t('startAgain')}
                        </Button>
                        <Button href={ROUTES.AUTH_LOGIN} size="sm" variant="secondary">
                            {t('signIn')}
                        </Button>
                    </div>
                </div>
            ) : (
                <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
                    {errors.general && (
                        <div
                            role="alert"
                            className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger"
                        >
                            {errors.general}
                        </div>
                    )}

                    {termsUnavailable && (
                        <div
                            role="alert"
                            className="space-y-3 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm"
                        >
                            <p className="text-text dark:text-text-dark">
                                {tRegisterErrors('termsUnavailable.message')}
                            </p>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                loading={isRetrying}
                                onClick={() => startRetry(() => router.refresh())}
                            >
                                {tRegisterErrors('termsUnavailable.retry')}
                            </Button>
                        </div>
                    )}

                    <Input
                        type="email"
                        name="email"
                        autoComplete="email"
                        label={tForm('email.label')}
                        placeholder={tForm('email.placeholder')}
                        value={email}
                        onChange={(e) => {
                            setEmail(e.target.value);
                            setErrors((prev) => ({ ...prev, email: undefined }));
                        }}
                        error={errors.email}
                        required
                        disabled={isPending}
                        className="text-sm"
                    />
                    <Input
                        type="text"
                        name="username"
                        autoComplete="username"
                        label={t('usernameLabel')}
                        placeholder={t('usernamePlaceholder')}
                        value={username}
                        onChange={(e) => {
                            setUsername(e.target.value);
                            setErrors((prev) => ({ ...prev, username: undefined }));
                        }}
                        error={errors.username}
                        // Says what the API will save ("Jane Doe" → "jane-doe") before submit.
                        helperText={
                            usernamePreview
                                ? t('usernameSavedAs', { username: usernamePreview })
                                : t('usernameHint')
                        }
                        disabled={isPending}
                        className="text-sm"
                    />
                    <Input
                        type="password"
                        name="password"
                        autoComplete="new-password"
                        label={tForm('password.label')}
                        placeholder={tForm('password.placeholder')}
                        value={password}
                        onChange={(e) => {
                            setPassword(e.target.value);
                            setErrors((prev) => ({ ...prev, password: undefined }));
                        }}
                        error={errors.password}
                        helperText={tForm('password.hint')}
                        required
                        disabled={isPending}
                        className="text-sm"
                    />
                    <Input
                        type="password"
                        name="confirmPassword"
                        autoComplete="new-password"
                        label={tForm('confirmPassword.label')}
                        placeholder={tForm('confirmPassword.placeholder')}
                        value={confirmPassword}
                        onChange={(e) => {
                            setConfirmPassword(e.target.value);
                            setErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                        }}
                        error={errors.confirmPassword}
                        required
                        disabled={isPending}
                        className="text-sm"
                    />

                    <div>
                        <div className="flex items-start gap-2">
                            <input
                                id="save-account-terms"
                                type="checkbox"
                                checked={acceptedTerms}
                                onChange={(e) => {
                                    setAcceptedTerms(e.target.checked);
                                    setErrors((prev) => ({ ...prev, terms: undefined }));
                                }}
                                disabled={isPending || termsUnavailable}
                                aria-invalid={Boolean(errors.terms)}
                                className="mt-0.5 h-4 w-4 rounded border-border bg-surface-secondary text-primary focus:ring-primary dark:border-border-dark dark:bg-surface-secondary-dark"
                            />
                            <label
                                htmlFor="save-account-terms"
                                className="text-xs text-text-secondary dark:text-text-secondary-dark"
                            >
                                {tForm('terms.text')}{' '}
                                <a
                                    href={legalHref('tos')}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:text-primary-hover dark:text-text-dark"
                                >
                                    {tForm('terms.termsLink')}
                                </a>{' '}
                                {tForm('terms.and')}{' '}
                                <a
                                    href={legalHref('privacy')}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:text-primary-hover dark:text-text-dark"
                                >
                                    {tForm('terms.privacyLink')}
                                </a>
                            </label>
                        </div>
                        {errors.terms && (
                            <p role="alert" className="mt-1 text-xs text-danger">
                                {errors.terms}
                            </p>
                        )}
                    </div>

                    <Button
                        type="submit"
                        fullWidth
                        loading={isPending}
                        disabled={termsUnavailable}
                        data-testid="save-account-submit"
                    >
                        {isPending ? t('submitting') : t('submit')}
                    </Button>

                    {socialProviders.length > 0 && (
                        <div className="space-y-3" data-testid="save-account-social">
                            <div className="flex items-center gap-3">
                                <span
                                    aria-hidden="true"
                                    className="flex-1 border-t border-border dark:border-border-dark"
                                />
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('orSaveWith')}
                                </span>
                                <span
                                    aria-hidden="true"
                                    className="flex-1 border-t border-border dark:border-border-dark"
                                />
                            </div>
                            {/*
                             * The same consent gate as the email path, as on the sign-up form:
                             * these are type="button", so the checkbox would never stop them.
                             */}
                            <SocialLoginButtons
                                providers={socialProviders}
                                disabled={!acceptedTerms || termsUnavailable || isPending}
                                disabledReason={t('providerNeedsTerms')}
                                connect={async (provider) => {
                                    const result = await startSavingWithProvider(
                                        provider,
                                        termsClaims(),
                                    );
                                    // Nothing left to save: the same panel as the email path.
                                    if (!result.success && result.reason === 'session_ended') {
                                        setSessionEnded(true);
                                        return { success: false };
                                    }
                                    return result;
                                }}
                                onError={(message) => setErrors({ general: message })}
                            />
                        </div>
                    )}

                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('otherAccount')}
                    </p>
                </form>
            )}
        </div>
    );
}
