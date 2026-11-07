'use client';

import { useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, ExternalLink, PackagePlus } from 'lucide-react';
import type {
    EverInstallRequestState,
    EverInstallRequestView,
    EverInstallRequestsView,
} from '@ever-works/contracts';
import {
    approveInstallRequestAction,
    declineInstallRequestAction,
    type InstallRequestActionCode,
} from '@/app/actions/settings/ever-platform-install-requests';
import { Button } from '@/components/ui/button';

/** The public page about install requests: what they are, the allow-list, `PLUGIN_DISTRIBUTION_MODE`. */
export const INSTALL_REQUESTS_DOCS_URL = 'https://docs.ever.works/ever-platform/install-requests';
/** The plugin system's page (dynamic plugin installs). */
export const PLUGIN_DOCS_URL = 'https://docs.ever.works/plugin-system';

/** The translation key of each request state (leaf names are camelCase, never dotted). */
const STATE_KEY = {
    requested: 'states.requested',
    installing: 'states.installing',
    installed: 'states.installed',
    failed: 'states.failed',
    declined: 'states.declined',
    withdrawn: 'states.withdrawn',
    removed: 'states.removed',
} as const satisfies Record<EverInstallRequestState, string>;

const STATE_TONE: Record<EverInstallRequestState, string> = {
    requested: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
    installing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
    installed: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    declined: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    withdrawn: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    removed: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

/** The translation key of each detail token. */
const DETAIL_KEY = {
    checksum_mismatch: 'details.checksumMismatch',
    incompatible_version: 'details.incompatibleVersion',
    installer_disabled: 'details.installerDisabled',
    permission_denied: 'details.permissionDenied',
    unknown: 'details.unknown',
} as const;

function detailKey(detail: string | null) {
    return detail && Object.prototype.hasOwnProperty.call(DETAIL_KEY, detail)
        ? DETAIL_KEY[detail as keyof typeof DETAIL_KEY]
        : null;
}

/** The translation key of each action code. */
const ERROR_KEY = {
    package_not_allowlisted: 'errors.packageNotAllowlisted',
    package_allowlist_disabled: 'errors.packageAllowlistDisabled',
    installer_disabled: 'errors.installerDisabled',
    not_installable: 'errors.notInstallable',
    not_open: 'errors.notOpen',
    integration_not_enabled: 'errors.integrationNotEnabled',
    forbidden: 'errors.forbidden',
    rate_limited: 'errors.rateLimited',
    unavailable: 'errors.unavailable',
    failed: 'errors.failed',
} as const satisfies Record<InstallRequestActionCode, string>;

interface InstallRequestsPanelProps {
    /** `unavailable`: the requests could not be read. */
    state: 'loaded' | 'unavailable';
    initial: EverInstallRequestsView | null;
}

/**
 * Settings → Ever Platform → Install requests (platform admins only; the page
 * renders it only when the API answered the list).
 *
 * Each request shows what apps.ever.co declared — the listing, the package
 * and version, the integrity and the edition — with its state. An open one
 * can be approved (the dynamic plugin installer installs exactly that) or
 * declined. A package that is not on the plugin allow-list is added only when
 * the admin ticks the box, which starts unticked. Every state is named in
 * text, never by colour alone.
 */
export function InstallRequestsPanel({ state, initial }: InstallRequestsPanelProps) {
    const t = useTranslations('dashboard.settings.everPlatform.installRequests');
    const headingId = useId();
    const [requests, setRequests] = useState<EverInstallRequestView[]>(initial?.requests ?? []);
    const installerEnabled = initial?.installerEnabled ?? false;
    const integrationEnabled = initial?.integrationEnabled ?? false;

    const replace = (next: EverInstallRequestView) =>
        setRequests((current) =>
            current.map((request) =>
                request.installId === next.installId ? { ...request, ...next } : request,
            ),
        );

    return (
        <section
            id="install-requests"
            className="space-y-4"
            aria-labelledby={headingId}
            data-testid="install-requests-panel"
        >
            <div>
                <h2
                    id={headingId}
                    className="text-xl font-semibold text-text dark:text-text-dark flex items-center gap-2"
                >
                    <PackagePlus className="w-5 h-5" aria-hidden="true" />
                    {t('title')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1 max-w-3xl">
                    {t('description')}{' '}
                    <a
                        href={INSTALL_REQUESTS_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 underline"
                    >
                        {t('docsLink')}
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                </p>
            </div>

            {state === 'unavailable' && (
                <Notice testId="install-requests-unavailable">{t('unavailable')}</Notice>
            )}
            {state === 'loaded' && !integrationEnabled && (
                <Notice testId="install-requests-integration-off">{t('integrationOff')}</Notice>
            )}
            {state === 'loaded' && !installerEnabled && (
                <Notice testId="install-requests-installer-disabled">
                    {t('installerDisabled')}{' '}
                    <a
                        href={PLUGIN_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 underline"
                    >
                        {t('installerDocs')}
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                </Notice>
            )}
            {state === 'loaded' && requests.length === 0 && (
                <Notice testId="install-requests-empty">{t('empty')}</Notice>
            )}
            {requests.length > 0 && (
                <ul className="space-y-3" data-testid="install-requests-list">
                    {requests.map((request) => (
                        <RequestRow
                            key={request.installId}
                            request={request}
                            installerEnabled={installerEnabled}
                            integrationEnabled={integrationEnabled}
                            onAnswered={replace}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

function Notice({ children, testId }: { children: React.ReactNode; testId: string }) {
    return (
        <p
            className="text-sm text-text dark:text-text-dark p-4 rounded-lg border border-border dark:border-border-dark"
            data-testid={testId}
        >
            {children}
        </p>
    );
}

function RequestRow({
    request,
    installerEnabled,
    integrationEnabled,
    onAnswered,
}: {
    request: EverInstallRequestView;
    installerEnabled: boolean;
    integrationEnabled: boolean;
    onAnswered: (next: EverInstallRequestView) => void;
}) {
    const t = useTranslations('dashboard.settings.everPlatform.installRequests');
    const format = useFormatter();
    const checkboxId = useId();
    const [addToAllowlist, setAddToAllowlist] = useState(false);
    const [error, setError] = useState<InstallRequestActionCode | null>(null);
    const [pending, startTransition] = useTransition();

    const open = request.state === 'requested';
    const detail = detailKey(request.detail);
    const needsAllowlist = open && request.allowlist === 'absent';
    const packageLabel = request.packageName
        ? `${request.packageName}${request.version ? `@${request.version}` : ''}`
        : `${request.sourceRepo ?? ''}${request.sourceSha ? `#${request.sourceSha.slice(0, 12)}` : ''}`;
    const approveDisabled =
        pending || !installerEnabled || !integrationEnabled || request.notInstallable !== null;

    const answer = (kind: 'approve' | 'decline') =>
        startTransition(async () => {
            setError(null);
            const result =
                kind === 'approve'
                    ? await approveInstallRequestAction(request.installId, addToAllowlist)
                    : await declineInstallRequestAction(request.installId);
            if (!result.success) {
                setError(result.code);
                return;
            }
            onAnswered(result.data);
            toast.success(kind === 'approve' ? t('toastApproved') : t('toastDeclined'));
        });

    const copyIntegrity = async () => {
        if (!request.integrity) return;
        try {
            await navigator.clipboard.writeText(request.integrity);
            toast.success(t('integrityCopied'));
        } catch {
            // The value stays selectable on the page.
        }
    };

    return (
        <li
            className="rounded-lg border border-border dark:border-border-dark p-4 space-y-3"
            data-testid="install-request-row"
            data-install-id={request.installId}
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="font-medium text-text dark:text-text-dark">
                        {request.listingSlug}
                    </p>
                    <p className="text-sm font-mono break-all text-text-muted dark:text-text-muted-dark">
                        {packageLabel}
                    </p>
                </div>
                <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONE[request.state]}`}
                    data-testid="install-request-state"
                >
                    {t(STATE_KEY[request.state])}
                </span>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                <div className="min-w-0">
                    <dt className="text-text-muted dark:text-text-muted-dark">{t('integrity')}</dt>
                    <dd className="flex items-center gap-1 min-w-0">
                        {request.integrity ? (
                            <>
                                <code
                                    className="font-mono text-xs truncate"
                                    title={request.integrity}
                                >
                                    {request.integrity}
                                </code>
                                <button
                                    type="button"
                                    onClick={copyIntegrity}
                                    className="shrink-0 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                                    aria-label={t('copyIntegrity')}
                                >
                                    <Copy className="w-3 h-3" aria-hidden="true" />
                                </button>
                            </>
                        ) : (
                            <span>{t('integrityNotDeclared')}</span>
                        )}
                    </dd>
                </div>
                <div>
                    <dt className="text-text-muted dark:text-text-muted-dark">{t('edition')}</dt>
                    <dd>{request.editionKey ?? t('noEdition')}</dd>
                </div>
                <div>
                    <dt className="text-text-muted dark:text-text-muted-dark">{t('received')}</dt>
                    <dd>
                        {format.dateTime(new Date(request.receivedAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                        })}
                    </dd>
                </div>
            </dl>

            {request.state === 'installed' && request.pluginId && (
                <p className="text-sm" data-testid="install-request-installed">
                    {t('installedAs', {
                        plugin: request.pluginId,
                        version: request.installedVersion ?? '',
                    })}
                </p>
            )}
            {detail && (
                <p className="text-sm" data-testid="install-request-detail">
                    {t(detail)}
                </p>
            )}
            {request.removalRequestedAt && request.state === 'installed' && (
                <p className="text-sm" data-testid="install-request-removal">
                    {t('removalRequested')}
                </p>
            )}
            {open && request.notInstallable && (
                <p className="text-sm" data-testid="install-request-not-installable">
                    {t(
                        request.notInstallable === 'plugin_unknown'
                            ? 'notInstallable.pluginUnknown'
                            : 'notInstallable.sourceNotSupported',
                    )}
                </p>
            )}

            {open && (
                <div className="space-y-3">
                    {needsAllowlist && request.packageName && (
                        <div className="space-y-1">
                            <label
                                htmlFor={checkboxId}
                                className="inline-flex items-center gap-2 text-sm cursor-pointer select-none"
                            >
                                <input
                                    id={checkboxId}
                                    type="checkbox"
                                    checked={addToAllowlist}
                                    onChange={(event) => setAddToAllowlist(event.target.checked)}
                                    data-testid="install-request-allowlist"
                                />
                                {t('allowlistCheckbox', { package: request.packageName })}
                            </label>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('allowlistNote')}
                            </p>
                        </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            onClick={() => answer('approve')}
                            disabled={approveDisabled}
                            data-testid="install-request-approve"
                        >
                            {pending ? t('working') : t('approve')}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => answer('decline')}
                            disabled={pending}
                            data-testid="install-request-decline"
                        >
                            {t('decline')}
                        </Button>
                    </div>
                </div>
            )}

            {error && (
                <p
                    role="alert"
                    className="text-sm text-red-700 dark:text-red-300"
                    data-testid="install-request-error"
                >
                    {t(ERROR_KEY[error])}
                </p>
            )}
        </li>
    );
}
