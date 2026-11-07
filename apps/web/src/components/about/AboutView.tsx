'use client';

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
    BookOpen,
    Building2,
    Check,
    CircleDot,
    CodeXml,
    Copy,
    ExternalLink,
    FolderGit2,
    GitPullRequest,
    Globe,
    Monitor,
    PenLine,
    Server,
    ShieldCheck,
    Tag,
    Users,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { LogoEverWorkImage } from '@/components/logos';
import type {
    BuildSyncState,
    DeploymentEnvironment,
    GitHubLinks,
    LearnMoreLink,
} from '@/lib/about-info';

/** One build's coordinates, as the web bundle and `GET /api/version` both describe them. */
export interface AboutBuild {
    version: string;
    shortSha: string;
    gitRef: string;
    buildTime: string;
    commitUrl: string | null;
}

export interface AboutViewProps {
    web: AboutBuild;
    /** `null` when the API did not answer `GET /api/version`. */
    api: AboutBuild | null;
    sync: BuildSyncState;
    /** `NODE_ENV` of the running web build. */
    buildMode: 'development' | 'production';
    /** `null` when nothing says which environment this is. */
    environment: DeploymentEnvironment | null;
    /** The API address a reader can use; `null` when there is none to show. */
    apiAddress: string | null;
    github: GitHubLinks;
    /** Empty on a self-hosted install with no operator site: the card is then left out. */
    learnMore: LearnMoreLink[];
}

/** How long the copy button shows its confirmation. */
export const COPIED_CONFIRMATION_MS = 2000;

const CARD =
    'overflow-hidden rounded-xl border border-border bg-white dark:border-border-dark dark:bg-surface-dark';
const SECTION_TITLE =
    'text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark';
const DIVIDE = 'divide-y divide-border dark:divide-border-dark';

/**
 * About (`/about`) — the product, the versions of the web app and API that
 * are running, the environment, and where to learn more or take part.
 *
 * Presentational only: the server page resolves every value (build info,
 * environment, API address, links) and this component lays them out, so it
 * can be rendered and tested with plain props.
 */
export function AboutView(props: AboutViewProps) {
    const t = useTranslations('dashboard.about');

    return (
        <div data-testid="about-page" className="mx-auto max-w-6xl space-y-6">
            <header>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
            </header>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <div className="space-y-6 lg:col-span-2">
                    <ProductCard license={props.github.license} />
                    <VersionCard {...props} />
                </div>
                <div className="space-y-6">
                    <LearnMoreCard links={props.learnMore} />
                    <GitHubCard links={props.github} />
                </div>
            </div>
        </div>
    );
}

function ExternalAnchor({
    href,
    className,
    children,
    label,
    testId,
}: {
    href: string;
    className?: string;
    children: ReactNode;
    label?: string;
    testId?: string;
}) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            data-testid={testId}
            className={className}
        >
            {children}
        </a>
    );
}

function ProductCard({ license }: { license: string }) {
    const t = useTranslations('dashboard.about');

    return (
        <section
            className={cn(CARD, 'flex flex-col gap-5 p-6 sm:flex-row sm:items-start')}
            data-testid="about-product"
        >
            <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-xl bg-surface-secondary px-3 dark:bg-surface-secondary-dark">
                <LogoEverWorkImage width={96} height={32} priority={false} />
            </div>
            <div className="min-w-0 space-y-3">
                <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                    Ever® Works™
                </h2>
                <p className="text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                    {t('product.description')}
                </p>
                <p className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-text-secondary dark:border-border-dark dark:text-text-secondary-dark">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                        {t.rich('product.license', {
                            license: (chunks) => (
                                <ExternalAnchor
                                    href={license}
                                    testId="about-link-license"
                                    className="font-medium text-primary underline underline-offset-2 dark:text-primary-dark"
                                >
                                    {chunks}
                                </ExternalAnchor>
                            ),
                        })}
                    </span>
                </p>
            </div>
        </section>
    );
}

function SyncIndicator({ sync }: { sync: BuildSyncState }) {
    const t = useTranslations('dashboard.about.version');
    if (sync === 'unknown') return null;
    const inSync = sync === 'in-sync';

    return (
        <span
            data-testid="about-sync"
            data-state={sync}
            className={cn(
                'inline-flex items-center gap-1.5 text-xs font-medium',
                inSync
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-amber-700 dark:text-amber-400',
            )}
        >
            <span
                aria-hidden="true"
                className={cn('h-2 w-2 rounded-full', inSync ? 'bg-green-500' : 'bg-amber-500')}
            />
            {inSync ? t('inSync') : t('different')}
        </span>
    );
}

function BuildRow({
    icon: Icon,
    label,
    build,
    testId,
}: {
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    label: string;
    build: AboutBuild | null;
    testId: string;
}) {
    const t = useTranslations('dashboard.about.version');

    return (
        <div className="flex items-center gap-4 px-6 py-4" data-testid={testId}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-text-secondary dark:bg-surface-secondary-dark dark:text-text-secondary-dark">
                <Icon className="h-5 w-5" aria-hidden={true} />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium text-text dark:text-text-dark">
                    <span
                        aria-hidden="true"
                        className={cn(
                            'h-2 w-2 rounded-full',
                            build ? 'bg-green-500' : 'bg-text-muted',
                        )}
                    />
                    {label}
                </p>
                {build ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                        <code className="rounded-md bg-surface-secondary px-2 py-0.5 font-mono font-semibold text-text dark:bg-surface-secondary-dark dark:text-text-dark">
                            {build.shortSha}
                        </code>
                        <span className="font-mono">v{build.version}</span>
                        {build.gitRef ? <span>{t('ref', { ref: build.gitRef })}</span> : null}
                        {build.buildTime ? (
                            <span>{t('builtAt', { time: build.buildTime })}</span>
                        ) : null}
                    </div>
                ) : (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('apiUnavailable')}
                    </p>
                )}
            </div>
            {build?.commitUrl ? (
                <ExternalAnchor
                    href={build.commitUrl}
                    label={t('viewCommit', { sha: build.shortSha })}
                    className="rounded-md p-2 text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text dark:text-text-secondary-dark dark:hover:bg-surface-secondary-dark dark:hover:text-text-dark"
                >
                    <CodeXml className="h-4 w-4" aria-hidden="true" />
                </ExternalAnchor>
            ) : null}
        </div>
    );
}

function EnvironmentRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
            <dt className="text-sm text-text-secondary dark:text-text-secondary-dark">{label}</dt>
            <dd className="min-w-0 text-sm font-medium text-text dark:text-text-dark">
                {children}
            </dd>
        </div>
    );
}

function CopyButton({ value }: { value: string }) {
    const t = useTranslations('dashboard.about.environment');
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            return;
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_CONFIRMATION_MS);
    };

    return (
        <button
            type="button"
            onClick={copy}
            aria-label={copied ? t('copied') : t('copyApiAddress')}
            data-testid="about-copy-api-address"
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text dark:text-text-secondary-dark dark:hover:bg-surface-secondary-dark dark:hover:text-text-dark"
        >
            {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
            ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
        </button>
    );
}

function VersionCard({ web, api, sync, buildMode, environment, apiAddress }: AboutViewProps) {
    const t = useTranslations('dashboard.about');

    return (
        <section className={CARD} data-testid="about-version">
            <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4 dark:border-border-dark">
                <h2 className={SECTION_TITLE}>{t('version.title')}</h2>
                <SyncIndicator sync={sync} />
            </div>
            <div className={DIVIDE}>
                <BuildRow
                    icon={Monitor}
                    label={t('version.web')}
                    build={web}
                    testId="about-build-web"
                />
                <BuildRow
                    icon={Server}
                    label={t('version.api')}
                    build={api}
                    testId="about-build-api"
                />
            </div>

            <div className="border-t border-border px-6 pt-5 pb-3 dark:border-border-dark">
                <h2 className={SECTION_TITLE}>{t('environment.title')}</h2>
                <dl className={cn('mt-2', DIVIDE)} data-testid="about-environment">
                    <EnvironmentRow label={t('environment.build')}>
                        <span className="inline-flex items-center gap-2">
                            <span
                                aria-hidden="true"
                                className={cn(
                                    'h-2 w-2 rounded-full',
                                    buildMode === 'production' ? 'bg-green-500' : 'bg-amber-500',
                                )}
                            />
                            {t(`environment.builds.${buildMode}`)}
                        </span>
                    </EnvironmentRow>
                    <EnvironmentRow label={t('environment.name')}>
                        {environment
                            ? t(`environment.names.${environment}`)
                            : t('environment.notAvailable')}
                    </EnvironmentRow>
                    <EnvironmentRow label={t('environment.apiAddress')}>
                        {apiAddress ? (
                            <span className="inline-flex max-w-full items-center gap-2">
                                <code
                                    className="truncate rounded-md bg-surface-secondary px-2 py-0.5 font-mono text-xs dark:bg-surface-secondary-dark"
                                    data-testid="about-api-address"
                                >
                                    {apiAddress}
                                </code>
                                <CopyButton value={apiAddress} />
                            </span>
                        ) : (
                            t('environment.notAvailable')
                        )}
                    </EnvironmentRow>
                </dl>
            </div>
        </section>
    );
}

interface LinkItem {
    href: string;
    label: string;
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    testId: string;
}

function LinkList({ items }: { items: LinkItem[] }) {
    const t = useTranslations('dashboard.about');

    return (
        <ul className={DIVIDE}>
            {items.map(({ href, label, icon: Icon, testId }) => (
                <li key={testId}>
                    <ExternalAnchor
                        href={href}
                        label={`${label} ${t('opensInNewTab')}`}
                        testId={testId}
                        className="group flex items-center gap-3 px-5 py-3 text-sm font-medium text-text transition-colors hover:bg-surface-secondary dark:text-text-dark dark:hover:bg-surface-secondary-dark"
                    >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-text-secondary dark:border-border-dark dark:text-text-secondary-dark">
                            <Icon className="h-4 w-4" aria-hidden={true} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        <ExternalLink
                            className="h-3.5 w-3.5 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 dark:text-text-muted-dark"
                            aria-hidden="true"
                        />
                    </ExternalAnchor>
                </li>
            ))}
        </ul>
    );
}

const LEARN_MORE_ICONS: Record<LearnMoreLink['id'], LinkItem['icon']> = {
    website: Globe,
    docs: BookOpen,
    company: Building2,
};

/** Renders nothing when there is no link to show (a self-hosted install with no operator site). */
function LearnMoreCard({ links }: { links: LearnMoreLink[] }) {
    const t = useTranslations('dashboard.about.learnMore');
    if (links.length === 0) return null;

    return (
        <section className={CARD} data-testid="about-learn-more">
            <h2
                className={cn(
                    SECTION_TITLE,
                    'border-b border-border px-5 py-4 dark:border-border-dark',
                )}
            >
                {t('title')}
            </h2>
            <LinkList
                items={links.map((link) => ({
                    href: link.href,
                    label: link.label ?? t(link.id),
                    icon: LEARN_MORE_ICONS[link.id],
                    testId: `about-link-${link.id}`,
                }))}
            />
        </section>
    );
}

function GitHubCard({ links }: { links: GitHubLinks }) {
    const t = useTranslations('dashboard.about.github');

    return (
        <section className={CARD} data-testid="about-github">
            <div className="space-y-1 border-b border-border px-5 py-4 dark:border-border-dark">
                <h2 className={SECTION_TITLE}>{t('title')}</h2>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('description')}
                </p>
            </div>
            <LinkList
                items={[
                    {
                        href: links.repository,
                        label: t('repository'),
                        icon: FolderGit2,
                        testId: 'about-link-repository',
                    },
                    {
                        href: links.releases,
                        label: t('releases'),
                        icon: Tag,
                        testId: 'about-link-releases',
                    },
                    {
                        href: links.issues,
                        label: t('issues'),
                        icon: CircleDot,
                        testId: 'about-link-issues',
                    },
                    {
                        href: links.pullRequests,
                        label: t('pullRequests'),
                        icon: GitPullRequest,
                        testId: 'about-link-pull-requests',
                    },
                    {
                        href: links.contributors,
                        label: t('contributors'),
                        icon: Users,
                        testId: 'about-link-contributors',
                    },
                    {
                        href: links.contributingGuide,
                        label: t('contributingGuide'),
                        icon: PenLine,
                        testId: 'about-link-contributing',
                    },
                ]}
            />
        </section>
    );
}
