'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { describeFleetModelProvider } from '@ever-works/contracts';
import type {
    FleetAgentReadinessEntry,
    FleetAgentUsageWindow,
    FleetNodeAgentReadinessView,
    FleetNodeRunStats,
    FleetNodeStatus,
    FleetViewerRole,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { relativeTimeParts } from '@/components/dashboard/runner-status.shared';
import {
    agentDotClass,
    agentLabelClass,
    agentStatusTone,
    agentUsageBarClass,
    agentUsageBarWidth,
    agentUsageWindowKey,
    formatAgentCost,
    listedAgents,
    nodeAgentsBlocked,
    summarizeNodeAgents,
    untilParts,
} from './agent-readiness.shared';

/**
 * Literal message keys for the two relative-time families.
 *
 * Lookup tables rather than template literals, for the reason
 * `RunnerStatusPill` gives: these keys take an INTERPOLATED value, and
 * `next-intl` types `t()` so that a key it cannot narrow cannot take
 * parameters.
 */
const AGO_KEYS = {
    second: 'ago.second',
    minute: 'ago.minute',
    hour: 'ago.hour',
    day: 'ago.day',
} as const;

const RESETS_KEYS = {
    minute: 'resetsIn.minute',
    hour: 'resetsIn.hour',
    day: 'resetsIn.day',
} as const;

/** The slice of a node (or a runner row) this list reads. */
export interface AgentReadinessNode {
    id: string;
    status: FleetNodeStatus;
    agentReadiness?: FleetNodeAgentReadinessView | null;
    anyAgentReady?: boolean | null;
    viewerRole?: FleetViewerRole;
    persisted?: boolean;
    runStats?: FleetNodeRunStats;
}

interface AgentReadinessListProps {
    node: AgentReadinessNode;
    /**
     * `compact` (the sidebar popover, a table cell): installed agents only,
     * one tight block each. Otherwise (the node drawer): every agent the
     * node listed, the sign-in method and account, and the run records.
     */
    compact?: boolean;
    className?: string;
}

/**
 * A computer's agents: for each agent CLI a status dot and word (Ready · Not
 * signed in · Access denied · Limit reached, resets in …), the CLI's own
 * reason, usage bars when the node knows them, and the last successful run —
 * with one clear line on top when the computer is online and none of its
 * agents can work.
 *
 * Why it exists: "Online" plus "Agent CLI claude 2.1.319" did not say whether
 * an agent could actually work. A seat whose organization switched access
 * off, or whose session expired, read exactly like a healthy one while every
 * run sent to it failed.
 *
 * Shared by the "Local runners" popover and the Fleet Computers page, so the
 * two can never tell different stories about the same machine. Renders
 * nothing for a computer whose agents are not the viewer's to see (someone
 * else's, a cluster row, one still enrolling).
 */
export function AgentReadinessList({ node, compact = false, className }: AgentReadinessListProps) {
    const t = useTranslations('fleet.agents');
    const summary = summarizeNodeAgents(node);
    if (summary === 'hidden') return null;

    const agents = listedAgents(node.agentReadiness, { includeNotInstalled: !compact });
    const blocked = nodeAgentsBlocked(node);
    const small = 'text-[11px] text-text-muted dark:text-text-muted-dark';

    return (
        <div
            className={cn('space-y-1.5', className)}
            data-testid={`agent-readiness-${node.id}`}
            data-summary={summary}
        >
            {blocked ? (
                <p
                    className="flex items-start gap-1 text-[11px] font-medium text-warning"
                    role="status"
                    data-testid={`agent-readiness-warning-${node.id}`}
                >
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                        {summary === 'no-agents' ? t('noneInstalledOnline') : t('noneReady')}
                    </span>
                </p>
            ) : null}

            {summary === 'unknown' ? (
                <p className={small} data-testid={`agent-readiness-unknown-${node.id}`}>
                    {t('unknown')}
                </p>
            ) : null}

            {summary === 'no-agents' && !blocked ? (
                <p className={small} data-testid={`agent-readiness-none-${node.id}`}>
                    {t('noneInstalled')}
                </p>
            ) : null}

            {agents.length > 0 ? (
                <ul className={compact ? 'space-y-1.5' : 'space-y-2.5'}>
                    {agents.map((agent) => (
                        <AgentRow
                            key={agent.provider}
                            nodeId={node.id}
                            agent={agent}
                            compact={compact}
                        />
                    ))}
                </ul>
            ) : null}

            {!compact && node.runStats ? <RunStats nodeId={node.id} stats={node.runStats} /> : null}
        </div>
    );
}

function AgentRow({
    nodeId,
    agent,
    compact,
}: {
    nodeId: string;
    agent: FleetAgentReadinessEntry;
    compact: boolean;
}) {
    const t = useTranslations('fleet.agents');
    const tone = agentStatusTone(agent.status);
    // The helpers read the clock themselves, as the popover's "last heartbeat"
    // does: the list re-renders on every poll, so the wording stays current.
    const resets = agent.status === 'limit_reached' ? untilParts(agent.limitResetsAt) : null;
    const lastSuccess = relativeTimeParts(agent.lastSuccessAt);
    const small = 'text-[11px] text-text-muted dark:text-text-muted-dark';
    const name = describeFleetModelProvider(agent.provider);

    return (
        <li className="space-y-0.5" data-testid={`agent-readiness-${nodeId}-${agent.provider}`}>
            <div className="flex items-center gap-1.5 min-w-0">
                <span
                    className={cn('w-1.5 h-1.5 rounded-full shrink-0', agentDotClass(tone))}
                    aria-hidden="true"
                />
                <span className="min-w-0 truncate text-xs font-medium text-text dark:text-text-dark">
                    {name}
                    {agent.version ? (
                        <span className="font-normal text-text-muted dark:text-text-muted-dark">
                            {' '}
                            {agent.version}
                        </span>
                    ) : null}
                </span>
                <span
                    className={cn(
                        'ml-auto shrink-0 text-[11px] font-medium whitespace-nowrap',
                        agentLabelClass(tone),
                    )}
                    data-testid={`agent-readiness-status-${nodeId}-${agent.provider}`}
                    data-status={agent.status}
                >
                    {t(`status.${agent.status}` as never)}
                    {resets ? (
                        <>
                            {', '}
                            {resets.unit === 'soon'
                                ? t('resetsIn.soon')
                                : t(RESETS_KEYS[resets.unit], { value: resets.value })}
                        </>
                    ) : null}
                </span>
            </div>

            {agent.reason ? (
                <p
                    className={cn(small, 'pl-3', compact ? 'line-clamp-2' : 'break-words')}
                    title={agent.reason}
                    data-testid={`agent-readiness-reason-${nodeId}-${agent.provider}`}
                >
                    {agent.reason}
                </p>
            ) : null}

            {!compact && agent.installed ? (
                <p className={cn(small, 'pl-3 break-all')}>
                    {t(`authMethod.${agent.authMethod}` as never)}
                    {agent.account ? ` · ${agent.account}` : ''}
                </p>
            ) : null}

            {(agent.usage ?? []).map((window) => (
                <UsageBar key={window.window} window={window} />
            ))}

            {agent.installed && agent.status !== 'unsupported' ? (
                <p
                    className={cn(small, 'pl-3')}
                    data-testid={`agent-readiness-last-success-${nodeId}-${agent.provider}`}
                >
                    {lastSuccess
                        ? t('lastSuccess', {
                              when: t(AGO_KEYS[lastSuccess.unit], { value: lastSuccess.value }),
                          })
                        : t('lastSuccessNever')}
                </p>
            ) : null}
        </li>
    );
}

function UsageBar({ window }: { window: FleetAgentUsageWindow }) {
    const t = useTranslations('fleet.agents');
    const key = agentUsageWindowKey(window.window);
    const label = key ? t(`window.${key}` as never) : window.window;
    const width = agentUsageBarWidth(window);
    const resets = untilParts(window.resetsAt);
    const resetsText = resets
        ? resets.unit === 'soon'
            ? t('resetsIn.soon')
            : t(RESETS_KEYS[resets.unit], { value: resets.value })
        : null;
    const figure = window.limited
        ? t('usageLimited', { window: label })
        : typeof window.usedPercent === 'number'
          ? t('usage', { window: label, percent: Math.round(window.usedPercent) })
          : label;

    return (
        <div className="pl-3 space-y-0.5" data-testid={`agent-usage-${window.window}`}>
            <p className="flex items-baseline justify-between gap-2 text-[11px] text-text-muted dark:text-text-muted-dark">
                <span className="truncate">{figure}</span>
                {resetsText ? (
                    <span className="shrink-0 whitespace-nowrap">{resetsText}</span>
                ) : null}
            </p>
            {width !== null ? (
                <div
                    className="h-1 w-full rounded-full bg-surface-secondary dark:bg-surface-secondary-dark overflow-hidden"
                    role="progressbar"
                    aria-label={figure}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={width}
                >
                    <div
                        className={cn('h-full rounded-full', agentUsageBarClass(window))}
                        style={{ width: `${width}%` }}
                    />
                </div>
            ) : null}
        </div>
    );
}

/** What the platform's own run records say: runs, failures and spend, 24 hours and 7 days. */
function RunStats({ nodeId, stats }: { nodeId: string; stats: FleetNodeRunStats }) {
    const t = useTranslations('fleet.agents');
    const line = (window: FleetNodeRunStats['last24h']) => {
        const cost = window.costCents > 0 ? formatAgentCost(window.costCents) : null;
        const counts = t('runs.counts', { runs: window.runs, failed: window.failed });
        return cost ? `${counts} · ${t('runs.cost', { amount: cost })}` : counts;
    };
    return (
        <dl
            className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 text-[11px] text-text-muted dark:text-text-muted-dark"
            data-testid={`agent-readiness-runs-${nodeId}`}
        >
            <dt>{t('runs.last24h')}</dt>
            <dd className="text-right" data-testid={`agent-readiness-runs-24h-${nodeId}`}>
                {line(stats.last24h)}
            </dd>
            <dt>{t('runs.last7d')}</dt>
            <dd className="text-right" data-testid={`agent-readiness-runs-7d-${nodeId}`}>
                {line(stats.last7d)}
            </dd>
        </dl>
    );
}
