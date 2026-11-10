import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetAgentReadinessEntry, FleetNodeAgentReadinessView } from '@ever-works/contracts';
import { AgentReadinessList, type AgentReadinessNode } from './AgentReadinessList';

/**
 * The per-agent list shown in the sidebar's "Local runners" popover and on
 * the Fleet Computers page.
 *
 * The derivations (tone, summary, "resets in") are pinned by
 * `agent-readiness.shared.unit.spec.ts`; this pins that each fact the list
 * promises actually reaches the screen: the status word per agent, the
 * CLI's own reason, the usage bars, the last successful run, the node-level
 * warning — and that a node which never reported reads "unknown", not "no
 * agent can work".
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));

const NOW = Date.parse('2026-11-10T12:00:00.000Z');

const agent = (over: Partial<FleetAgentReadinessEntry> = {}): FleetAgentReadinessEntry => ({
    provider: 'claude-code',
    installed: true,
    version: '2.1.319',
    signedIn: true,
    authMethod: 'subscription',
    account: 'owner@example.com (Acme, max)',
    status: 'ready',
    reason: null,
    checkedAt: '2026-11-10T12:00:00.000Z',
    ...over,
});

const report = (agents: FleetAgentReadinessEntry[]): FleetNodeAgentReadinessView => ({
    at: '2026-11-10T12:00:01.000Z',
    checkedAt: '2026-11-10T12:00:00.000Z',
    agents,
    anyReady: agents.some((entry) => entry.installed && entry.status === 'ready'),
});

const node = (over: Partial<AgentReadinessNode> = {}): AgentReadinessNode => ({
    id: 'n1',
    status: 'online',
    agentReadiness: report([agent()]),
    anyAgentReady: true,
    ...over,
});

describe('AgentReadinessList', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a ready agent with its version, and no warning', () => {
        render(<AgentReadinessList node={node()} compact />);

        expect(screen.getByTestId('agent-readiness-n1')).toHaveAttribute('data-summary', 'ready');
        expect(screen.getByTestId('agent-readiness-n1-claude-code')).toHaveTextContent(
            'Claude Code 2.1.319',
        );
        const status = screen.getByTestId('agent-readiness-status-n1-claude-code');
        expect(status).toHaveAttribute('data-status', 'ready');
        expect(status).toHaveTextContent('status.ready');
        expect(screen.queryByTestId('agent-readiness-warning-n1')).toBeNull();
    });

    it('online, CLI installed, signed in — and says clearly that no agent can work (the production case)', () => {
        const reason =
            'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([agent({ status: 'access_denied', reason })]),
                    anyAgentReady: false,
                })}
                compact
            />,
        );

        expect(screen.getByTestId('agent-readiness-warning-n1')).toHaveTextContent('noneReady');
        expect(screen.getByTestId('agent-readiness-status-n1-claude-code')).toHaveTextContent(
            'status.access_denied',
        );
        const shown = screen.getByTestId('agent-readiness-reason-n1-claude-code');
        expect(shown).toHaveTextContent(reason);
        expect(shown).toHaveAttribute('title', reason);
    });

    it('says when a limit resets', () => {
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([
                        agent({
                            status: 'limit_reached',
                            reason: "You've hit your weekly limit",
                            limitResetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
                        }),
                    ]),
                    anyAgentReady: false,
                })}
                compact
            />,
        );
        expect(screen.getByTestId('agent-readiness-status-n1-claude-code')).toHaveTextContent(
            'status.limit_reached, resetsIn.hour:2',
        );
    });

    it('draws a usage bar per window with its figure and reset, and none for a window without a figure', () => {
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([
                        agent({
                            usage: [
                                {
                                    window: 'five_hour',
                                    usedPercent: 42.4,
                                    resetsAt: new Date(NOW + 90 * 60_000).toISOString(),
                                },
                                {
                                    window: 'weekly',
                                    usedPercent: 100,
                                    resetsAt: null,
                                    limited: true,
                                },
                                {
                                    window: 'weekly_opus',
                                    usedPercent: null,
                                    resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
                                },
                            ],
                        }),
                    ]),
                })}
                compact
            />,
        );

        const bars = screen.getAllByRole('progressbar');
        expect(bars).toHaveLength(2);
        expect(bars[0]).toHaveAttribute('aria-valuenow', '42');
        expect(bars[0]).toHaveAttribute('aria-label', 'usage:window.five_hour,42');
        expect(bars[1]).toHaveAttribute('aria-valuenow', '100');
        expect(screen.getByTestId('agent-usage-five_hour')).toHaveTextContent('resetsIn.hour:2');
        expect(screen.getByTestId('agent-usage-weekly')).toHaveTextContent(
            'usageLimited:window.weekly',
        );
        expect(screen.getByTestId('agent-usage-weekly_opus')).toHaveTextContent('resetsIn.day:3');
    });

    it('shows the last successful run, or that there is none on record', () => {
        const { rerender } = render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([
                        agent({ lastSuccessAt: new Date(NOW - 3 * 3_600_000).toISOString() }),
                    ]),
                })}
                compact
            />,
        );
        expect(screen.getByTestId('agent-readiness-last-success-n1-claude-code')).toHaveTextContent(
            'lastSuccess:ago.hour:3',
        );

        rerender(<AgentReadinessList node={node()} compact />);
        expect(screen.getByTestId('agent-readiness-last-success-n1-claude-code')).toHaveTextContent(
            'lastSuccessNever',
        );
    });

    it('a node that never reported reads unknown — update the node — and is never called blocked', () => {
        render(
            <AgentReadinessList
                node={node({ agentReadiness: null, anyAgentReady: null })}
                compact
            />,
        );

        expect(screen.getByTestId('agent-readiness-n1')).toHaveAttribute('data-summary', 'unknown');
        expect(screen.getByTestId('agent-readiness-unknown-n1')).toHaveTextContent('unknown');
        expect(screen.queryByTestId('agent-readiness-warning-n1')).toBeNull();
    });

    it('an online computer with no agent CLI at all is warned about', () => {
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([
                        agent({ installed: false, status: 'not_installed', version: null }),
                    ]),
                    anyAgentReady: false,
                })}
                compact
            />,
        );
        expect(screen.getByTestId('agent-readiness-warning-n1')).toHaveTextContent(
            'noneInstalledOnline',
        );
        // Compact: a CLI that is simply not installed gets no row.
        expect(screen.queryByTestId('agent-readiness-n1-claude-code')).toBeNull();
    });

    it('an offline computer shows its last known agents without the warning', () => {
        render(
            <AgentReadinessList
                node={node({
                    status: 'offline',
                    agentReadiness: report([agent({ status: 'not_signed_in' })]),
                    anyAgentReady: false,
                })}
                compact
            />,
        );
        expect(screen.queryByTestId('agent-readiness-warning-n1')).toBeNull();
        expect(screen.getByTestId('agent-readiness-status-n1-claude-code')).toHaveTextContent(
            'status.not_signed_in',
        );
    });

    it('renders nothing for a computer whose agents are not the viewer’s to see', () => {
        const { container } = render(
            <AgentReadinessList node={node({ viewerRole: 'org-member' })} compact />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('full (the node drawer): the sign-in, every listed agent, and the platform’s run records', () => {
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([
                        agent(),
                        agent({
                            provider: 'codex',
                            installed: false,
                            status: 'not_installed',
                            version: null,
                            signedIn: null,
                            authMethod: 'unknown',
                            account: null,
                        }),
                    ]),
                    runStats: {
                        last24h: { runs: 4, failed: 4, costCents: 0 },
                        last7d: { runs: 9, failed: 6, costCents: 310 },
                    },
                })}
            />,
        );

        expect(screen.getByTestId('agent-readiness-n1-claude-code')).toHaveTextContent(
            'authMethod.subscription · owner@example.com (Acme, max)',
        );
        expect(screen.getByTestId('agent-readiness-status-n1-codex')).toHaveTextContent(
            'status.not_installed',
        );
        expect(screen.getByTestId('agent-readiness-runs-24h-n1')).toHaveTextContent(
            'runs.counts:4,4',
        );
        expect(screen.getByTestId('agent-readiness-runs-7d-n1')).toHaveTextContent(
            'runs.counts:9,6 · runs.cost:$3.10',
        );
    });

    it('compact leaves the sign-in and the run records out', () => {
        render(
            <AgentReadinessList
                node={node({
                    runStats: {
                        last24h: { runs: 1, failed: 0, costCents: 5 },
                        last7d: { runs: 1, failed: 0, costCents: 5 },
                    },
                })}
                compact
            />,
        );
        expect(screen.queryByTestId('agent-readiness-runs-n1')).toBeNull();
        expect(screen.getByTestId('agent-readiness-n1-claude-code')).not.toHaveTextContent(
            'owner@example.com',
        );
    });
});
