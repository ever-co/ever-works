'use client';

import { useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Building2, ExternalLink } from 'lucide-react';
import {
    EVER_PLATFORM_LINK_CODE_PATTERN,
    type EverPlatformOrganizationLinkView,
} from '@ever-works/contracts';
import {
    linkOrganizationAction,
    unlinkOrganizationAction,
    type EverPlatformActionCode,
} from '@/app/actions/settings/ever-platform-connection';
import { Button } from '@/components/ui/button';
import {
    EntitlementSummary,
    EVER_PLATFORM_APP_URL,
    EVER_PLATFORM_CONNECTION_DOCS_URL,
    EVER_PLATFORM_ERROR_KEY,
} from './EverPlatformConnectionPanel';

/** One of the person's Organizations, with its link as the API answered it. */
export interface EverPlatformOrganizationLinkItem {
    readonly organizationId: string;
    readonly displayName: string;
    readonly slug: string;
    /** `null`: the link could not be read. */
    readonly view: EverPlatformOrganizationLinkView | null;
}

interface EverPlatformOrganizationLinksProps {
    organizations: readonly EverPlatformOrganizationLinkItem[];
}

/**
 * Settings → Ever Platform → Organization link (the page renders it only when
 * linking is switched on in the API and the person has an Organization).
 *
 * For each Organization: whether it is linked to an Ever organization and, when
 * it is not, the form for a link code created in app.ever.co. A linked
 * Organization shows its Ever organization and what its entitlement document
 * says, and can be unlinked after a confirmation. The API decides who may
 * change a link (an admin of the Organization); a refusal is said in words.
 */
export function EverPlatformOrganizationLinks({
    organizations,
}: EverPlatformOrganizationLinksProps) {
    const t = useTranslations('dashboard.settings.everPlatform.organizationLink');
    const headingId = useId();

    return (
        <section
            id="organization-link"
            className="space-y-4"
            aria-labelledby={headingId}
            data-testid="ever-platform-organization-links"
        >
            <div>
                <h2
                    id={headingId}
                    className="text-xl font-semibold text-text dark:text-text-dark flex items-center gap-2"
                >
                    <Building2 className="w-5 h-5" aria-hidden="true" />
                    {t('title')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1 max-w-3xl">
                    {t('description')}{' '}
                    <a
                        href={`${EVER_PLATFORM_CONNECTION_DOCS_URL}#linking-an-organization`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 underline"
                    >
                        {t('docsLink')}
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                </p>
            </div>
            <ul className="space-y-3">
                {organizations.map((organization) => (
                    <OrganizationLinkRow key={organization.organizationId} item={organization} />
                ))}
            </ul>
        </section>
    );
}

function OrganizationLinkRow({ item }: { item: EverPlatformOrganizationLinkItem }) {
    const t = useTranslations('dashboard.settings.everPlatform.organizationLink');
    const tErrors = useTranslations('dashboard.settings.everPlatform.connection');
    const format = useFormatter();
    const codeId = useId();
    const [view, setView] = useState<EverPlatformOrganizationLinkView | null>(item.view);
    const [code, setCode] = useState('');
    const [error, setError] = useState<EverPlatformActionCode | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [pending, startTransition] = useTransition();

    const link = view?.link ?? null;
    const codeLooksRight = EVER_PLATFORM_LINK_CODE_PATTERN.test(code.trim());

    const submit = () => {
        if (!codeLooksRight) {
            setError('code_invalid');
            return;
        }
        setError(null);
        startTransition(async () => {
            const result = await linkOrganizationAction(item.organizationId, code.trim());
            // The code is used once: it is not kept in the page either way.
            setCode('');
            if (result.success) {
                setView(result.data);
                toast.success(t('linked'));
            } else {
                setError(result.code);
            }
        });
    };

    const remove = () => {
        setError(null);
        startTransition(async () => {
            const result = await unlinkOrganizationAction(item.organizationId);
            setConfirming(false);
            if (result.success) {
                setView(result.data);
                toast.success(t('unlinked'));
            } else {
                setError(result.code);
            }
        });
    };

    return (
        <li
            className="p-4 rounded-lg border border-border dark:border-border-dark space-y-3"
            data-testid="ever-platform-organization-link"
            data-organization={item.slug}
        >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-text dark:text-text-dark">
                    {item.displayName}
                </h3>
                <span
                    className="text-xs font-medium text-text-muted dark:text-text-muted-dark"
                    data-testid="ever-platform-link-state"
                    data-state={!view ? 'unknown' : link ? 'linked' : 'not-linked'}
                >
                    {!view ? t('stateUnknown') : link ? t('stateLinked') : t('stateNotLinked')}
                </span>
            </div>

            {!view && <p className="text-sm text-text dark:text-text-dark">{t('unavailable')}</p>}

            {view && link && (
                <>
                    <dl className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-1 text-sm">
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('everOrganization')}
                        </dt>
                        <dd
                            className="text-text dark:text-text-dark break-all"
                            data-testid="ever-platform-link-organization"
                        >
                            {link.handle ? `ever.co/${link.handle}` : link.everOrgId}
                        </dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('linkedAt')}
                        </dt>
                        <dd className="text-text dark:text-text-dark">
                            {format.dateTime(new Date(link.linkedAt), { dateStyle: 'medium' })}
                        </dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('createdVia')}
                        </dt>
                        <dd className="text-text dark:text-text-dark">
                            {link.createdVia === 'provisioning'
                                ? t('viaProvisioning')
                                : t('viaLinkCode')}
                        </dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('appSync')}
                        </dt>
                        <dd
                            className="text-text dark:text-text-dark"
                            data-testid="ever-platform-link-app-sync"
                        >
                            {view.appSync ? t('appSyncOn') : t('appSyncOff')}
                        </dd>
                    </dl>
                    {view.entitlement && (
                        <EntitlementSummary
                            entitlement={view.entitlement}
                            testId="ever-platform-link-entitlement"
                        />
                    )}
                    {!confirming && (
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                setError(null);
                                setConfirming(true);
                            }}
                            disabled={pending}
                            data-testid="ever-platform-unlink"
                        >
                            {t('unlink')}
                        </Button>
                    )}
                    {confirming && (
                        <div
                            className="space-y-2 p-3 rounded-md border border-border dark:border-border-dark"
                            data-testid="ever-platform-unlink-confirm"
                        >
                            <p className="text-sm text-text dark:text-text-dark max-w-3xl">
                                {t('unlinkConfirm')}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    variant="danger"
                                    onClick={remove}
                                    disabled={pending}
                                    data-testid="ever-platform-unlink-submit"
                                >
                                    {pending ? t('unlinking') : t('unlinkYes')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => setConfirming(false)}
                                    disabled={pending}
                                >
                                    {t('cancel')}
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {view && !link && !view.connected && (
                <p
                    className="text-sm text-text dark:text-text-dark"
                    data-testid="ever-platform-link-not-connected"
                >
                    {t('notConnected')}
                </p>
            )}

            {view && !link && view.connected && (
                <div className="space-y-2" data-testid="ever-platform-link-form">
                    <label
                        htmlFor={codeId}
                        className="block text-sm font-medium text-text dark:text-text-dark"
                    >
                        {t('codeLabel')}
                    </label>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-3xl">
                        {t('codeHelp')}{' '}
                        <a
                            href={EVER_PLATFORM_APP_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 underline"
                        >
                            app.ever.co
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            id={codeId}
                            type="text"
                            value={code}
                            onChange={(event) => {
                                setCode(event.target.value);
                                setError(null);
                            }}
                            placeholder="EVL-XXXX-XXXX-XXXX"
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            maxLength={32}
                            disabled={pending}
                            aria-invalid={error === 'code_invalid'}
                            className="w-64 px-3 py-2 rounded-md border border-border dark:border-border-dark bg-transparent font-mono text-sm text-text dark:text-text-dark"
                            data-testid="ever-platform-link-code"
                        />
                        <Button
                            type="button"
                            onClick={submit}
                            disabled={pending || code.trim() === ''}
                            data-testid="ever-platform-link-submit"
                        >
                            {pending ? t('linking') : t('link')}
                        </Button>
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark max-w-3xl">
                        {t('whatIsSent')}
                    </p>
                </div>
            )}

            {error && (
                <p
                    role="alert"
                    className="text-sm text-red-700 dark:text-red-300"
                    data-testid="ever-platform-link-error"
                >
                    {tErrors(EVER_PLATFORM_ERROR_KEY[error])}
                </p>
            )}
        </li>
    );
}
