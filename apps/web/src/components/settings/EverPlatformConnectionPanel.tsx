'use client';

import { useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ExternalLink, Link2 } from 'lucide-react';
import {
    EVER_PLATFORM_CONNECT_CODE_PATTERN,
    type EverPlatformConnectionState,
    type EverPlatformConnectionStatusView,
    type EverPlatformEntitlementView,
} from '@ever-works/contracts';
import {
    connectEverPlatformAction,
    disconnectEverPlatformAction,
    type EverPlatformActionCode,
} from '@/app/actions/settings/ever-platform-connection';
import { Button } from '@/components/ui/button';

/** The public page about connecting an installation to Ever Platform. */
export const EVER_PLATFORM_CONNECTION_DOCS_URL = 'https://docs.ever.works/ever-platform/connection';
/** Where a platform admin gets a connect code. */
export const EVER_PLATFORM_APP_URL = 'https://app.ever.co';

/** The translation key of each connection state (leaf names are camelCase, never dotted). */
const STATE_KEY = {
    disconnected: 'states.disconnected',
    pending_approval: 'states.pendingApproval',
    active: 'states.active',
    revoked: 'states.revoked',
} as const satisfies Record<EverPlatformConnectionState, string>;

const STATE_TONE: Record<EverPlatformConnectionState, string> = {
    disconnected: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    pending_approval: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
    active: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
    revoked: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

/** The translation key of each action code. */
export const EVER_PLATFORM_ERROR_KEY = {
    code_invalid: 'errors.codeInvalid',
    code_expired: 'errors.codeExpired',
    already_connected: 'errors.alreadyConnected',
    not_connected: 'errors.notConnected',
    already_linked: 'errors.alreadyLinked',
    tenant_already_linked: 'errors.tenantAlreadyLinked',
    not_linked: 'errors.notLinked',
    product_mismatch: 'errors.productMismatch',
    platform_unreachable: 'errors.platformUnreachable',
    session_required: 'errors.sessionRequired',
    forbidden: 'errors.forbidden',
    rate_limited: 'errors.rateLimited',
    unavailable: 'errors.unavailable',
    failed: 'errors.failed',
} as const satisfies Record<EverPlatformActionCode, string>;

interface EverPlatformConnectionPanelProps {
    /** `unavailable`: the connection could not be read. */
    state: 'loaded' | 'unavailable';
    initial: EverPlatformConnectionStatusView | null;
}

/**
 * Settings → Ever Platform → Connection (platform admins only; the page
 * renders it only when the API answered the status).
 *
 * Shows where the connection stands and, while the installation is not
 * connected, the form for a connect code from app.ever.co. A connected
 * installation can be disconnected (after a confirmation). Below, read-only:
 * the last heartbeat, what the installation's entitlement document says and
 * where the apps mirror stands, each only when it is switched on. Every state
 * is named in text, never by colour alone, and the code typed is never shown
 * again or kept after it was sent.
 */
export function EverPlatformConnectionPanel({ state, initial }: EverPlatformConnectionPanelProps) {
    const t = useTranslations('dashboard.settings.everPlatform.connection');
    const format = useFormatter();
    const headingId = useId();
    const codeId = useId();
    const [status, setStatus] = useState<EverPlatformConnectionStatusView | null>(initial);
    const [code, setCode] = useState('');
    const [error, setError] = useState<EverPlatformActionCode | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [pending, startTransition] = useTransition();

    const connection = status?.connection ?? null;
    const connected = connection?.status === 'active' || connection?.status === 'pending_approval';
    const codeLooksRight = EVER_PLATFORM_CONNECT_CODE_PATTERN.test(code.trim());
    const dateTime = (value: string | null) =>
        value
            ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })
            : null;

    const connect = () => {
        if (!codeLooksRight) {
            setError('code_invalid');
            return;
        }
        setError(null);
        startTransition(async () => {
            const result = await connectEverPlatformAction(code.trim());
            // The code is used once: it is not kept in the page either way.
            setCode('');
            if (result.success) {
                setStatus(result.data);
                toast.success(t('connected'));
            } else {
                setError(result.code);
            }
        });
    };

    const disconnect = () => {
        setError(null);
        startTransition(async () => {
            const result = await disconnectEverPlatformAction();
            setConfirming(false);
            if (result.success) {
                setStatus(result.data);
                toast.success(t('disconnected'));
            } else {
                setError(result.code);
            }
        });
    };

    return (
        <section
            id="connection"
            className="space-y-4"
            aria-labelledby={headingId}
            data-testid="ever-platform-connection-panel"
        >
            <div>
                <h2
                    id={headingId}
                    className="text-xl font-semibold text-text dark:text-text-dark flex items-center gap-2"
                >
                    <Link2 className="w-5 h-5" aria-hidden="true" />
                    {t('title')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1 max-w-3xl">
                    {t('description')}{' '}
                    <a
                        href={EVER_PLATFORM_CONNECTION_DOCS_URL}
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
                <Notice testId="ever-platform-connection-unavailable">{t('unavailable')}</Notice>
            )}

            {connection && (
                <div className="p-4 rounded-lg border border-border dark:border-border-dark space-y-3">
                    <dl className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('stateLabel')}
                        </dt>
                        <dd>
                            <span
                                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATE_TONE[connection.status]}`}
                                data-testid="ever-platform-connection-state"
                                data-state={connection.status}
                            >
                                {t(STATE_KEY[connection.status])}
                            </span>
                        </dd>
                        {connection.platformInstanceId && connected && (
                            <>
                                <dt className="text-text-muted dark:text-text-muted-dark">
                                    {t('instanceIdLabel')}
                                </dt>
                                <dd
                                    className="font-mono text-xs break-all text-text dark:text-text-dark"
                                    data-testid="ever-platform-instance-id"
                                >
                                    {connection.platformInstanceId}
                                </dd>
                            </>
                        )}
                        {connection.connectedAt && connected && (
                            <>
                                <dt className="text-text-muted dark:text-text-muted-dark">
                                    {t('connectedAtLabel')}
                                </dt>
                                <dd className="text-text dark:text-text-dark">
                                    {dateTime(connection.connectedAt)}
                                </dd>
                            </>
                        )}
                        {status?.features.heartbeat && connected && (
                            <>
                                <dt className="text-text-muted dark:text-text-muted-dark">
                                    {t('heartbeatLabel')}
                                </dt>
                                <dd
                                    className="text-text dark:text-text-dark"
                                    data-testid="ever-platform-heartbeat"
                                >
                                    {dateTime(status.heartbeat.lastSentAt) ?? t('heartbeatNever')}
                                </dd>
                            </>
                        )}
                    </dl>

                    {connection.status === 'pending_approval' && (
                        <p
                            className="text-sm text-text dark:text-text-dark"
                            data-testid="ever-platform-pending-approval"
                        >
                            {t('pendingApprovalHint')}
                        </p>
                    )}
                    {connection.status === 'revoked' && (
                        <p className="text-sm text-text dark:text-text-dark">{t('revokedHint')}</p>
                    )}
                    {!connected && connection.lastError && (
                        <p
                            className="text-sm text-red-700 dark:text-red-300"
                            data-testid="ever-platform-last-error"
                        >
                            {t('lastError', { code: connection.lastError })}
                        </p>
                    )}

                    {!connected && (
                        <div className="space-y-2" data-testid="ever-platform-connect-form">
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
                                    placeholder="EVC-XXXX-XXXX-XXXX"
                                    autoComplete="off"
                                    autoCapitalize="characters"
                                    spellCheck={false}
                                    maxLength={32}
                                    disabled={pending}
                                    aria-invalid={error === 'code_invalid'}
                                    className="w-64 px-3 py-2 rounded-md border border-border dark:border-border-dark bg-transparent font-mono text-sm text-text dark:text-text-dark"
                                    data-testid="ever-platform-connect-code"
                                />
                                <Button
                                    type="button"
                                    onClick={connect}
                                    disabled={pending || code.trim() === ''}
                                    data-testid="ever-platform-connect-submit"
                                >
                                    {pending ? t('connecting') : t('connect')}
                                </Button>
                            </div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark max-w-3xl">
                                {t('whatIsSent')}
                            </p>
                        </div>
                    )}

                    {connected && !confirming && (
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                setError(null);
                                setConfirming(true);
                            }}
                            disabled={pending}
                            data-testid="ever-platform-disconnect"
                        >
                            {t('disconnect')}
                        </Button>
                    )}
                    {connected && confirming && (
                        <div
                            className="space-y-2 p-3 rounded-md border border-border dark:border-border-dark"
                            data-testid="ever-platform-disconnect-confirm"
                        >
                            <p className="text-sm text-text dark:text-text-dark max-w-3xl">
                                {t('disconnectConfirm')}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    variant="danger"
                                    onClick={disconnect}
                                    disabled={pending}
                                    data-testid="ever-platform-disconnect-submit"
                                >
                                    {pending ? t('disconnecting') : t('disconnectYes')}
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

                    {error && (
                        <p
                            role="alert"
                            className="text-sm text-red-700 dark:text-red-300"
                            data-testid="ever-platform-connection-error"
                        >
                            {t(EVER_PLATFORM_ERROR_KEY[error])}
                        </p>
                    )}
                </div>
            )}

            {status && connected && status.features.entitlements && (
                <EntitlementSummary
                    entitlement={status.entitlement}
                    testId="ever-platform-instance-entitlement"
                />
            )}

            {status && connected && status.appSync && (
                <div
                    className="p-4 rounded-lg border border-border dark:border-border-dark space-y-2"
                    data-testid="ever-platform-app-sync"
                >
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('appSync.title')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-3xl">
                        {t('appSync.description')}
                    </p>
                    <dl className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-1 text-sm">
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('appSync.linksEnabled')}
                        </dt>
                        <dd className="text-text dark:text-text-dark">
                            {status.appSync.linksEnabled}
                        </dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('appSync.pending')}
                        </dt>
                        <dd className="text-text dark:text-text-dark">{status.appSync.pending}</dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('appSync.failed')}
                        </dt>
                        <dd className="text-text dark:text-text-dark">
                            {status.appSync.failed}
                            {status.appSync.lastError ? ` (${status.appSync.lastError})` : ''}
                        </dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('appSync.reconciledAt')}
                        </dt>
                        <dd className="text-text dark:text-text-dark">
                            {dateTime(status.appSync.reconciledAt) ?? t('appSync.never')}
                        </dd>
                    </dl>
                </div>
            )}
        </section>
    );
}

/** The translation key of each entitlement status. */
const ENTITLEMENT_STATUS_KEY = {
    valid: 'entitlement.statusValid',
    grace: 'entitlement.statusGrace',
    paused: 'entitlement.statusPaused',
} as const;

/**
 * What a stored entitlement document says: read-only, the same for the
 * installation's document and for a linked Organization's. Never the document.
 */
export function EntitlementSummary({
    entitlement,
    testId,
}: {
    entitlement: EverPlatformEntitlementView | null;
    testId: string;
}) {
    const t = useTranslations('dashboard.settings.everPlatform.connection');
    const format = useFormatter();
    const dateTime = (value: string | null) =>
        value
            ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })
            : null;
    const features = Object.entries(entitlement?.features ?? {})
        .filter(([, on]) => on)
        .map(([key]) => key)
        .sort();

    return (
        <div
            className="p-4 rounded-lg border border-border dark:border-border-dark space-y-2"
            data-testid={testId}
        >
            <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                {t('entitlement.title')}
            </h3>
            <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-3xl">
                {t('entitlement.description')}
            </p>
            {!entitlement && (
                <p className="text-sm text-text dark:text-text-dark" data-testid={`${testId}-none`}>
                    {t('entitlement.none')}
                </p>
            )}
            {entitlement && (
                <dl className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-text-muted dark:text-text-muted-dark">
                        {t('entitlement.status')}
                    </dt>
                    <dd
                        className="text-text dark:text-text-dark"
                        data-testid={`${testId}-status`}
                        data-status={entitlement.status}
                    >
                        {t(ENTITLEMENT_STATUS_KEY[entitlement.status])}
                    </dd>
                    {entitlement.plan && (
                        <>
                            <dt className="text-text-muted dark:text-text-muted-dark">
                                {t('entitlement.plan')}
                            </dt>
                            <dd className="text-text dark:text-text-dark break-all">
                                {entitlement.plan}
                                {entitlement.tier ? ` (${entitlement.tier})` : ''}
                            </dd>
                        </>
                    )}
                    {features.length > 0 && (
                        <>
                            <dt className="text-text-muted dark:text-text-muted-dark">
                                {t('entitlement.features')}
                            </dt>
                            <dd className="text-text dark:text-text-dark font-mono text-xs break-words">
                                {features.join(', ')}
                            </dd>
                        </>
                    )}
                    {entitlement.expiresAt && (
                        <>
                            <dt className="text-text-muted dark:text-text-muted-dark">
                                {t('entitlement.expiresAt')}
                            </dt>
                            <dd className="text-text dark:text-text-dark">
                                {dateTime(entitlement.expiresAt)}
                            </dd>
                        </>
                    )}
                    {entitlement.fetchedAt && (
                        <>
                            <dt className="text-text-muted dark:text-text-muted-dark">
                                {t('entitlement.fetchedAt')}
                            </dt>
                            <dd className="text-text dark:text-text-dark">
                                {dateTime(entitlement.fetchedAt)}
                            </dd>
                        </>
                    )}
                    {entitlement.lastError && (
                        <>
                            <dt className="text-text-muted dark:text-text-muted-dark">
                                {t('entitlement.lastError')}
                            </dt>
                            <dd
                                className="text-red-700 dark:text-red-300 font-mono text-xs"
                                data-testid={`${testId}-error`}
                            >
                                {entitlement.lastError}
                            </dd>
                        </>
                    )}
                </dl>
            )}
        </div>
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
