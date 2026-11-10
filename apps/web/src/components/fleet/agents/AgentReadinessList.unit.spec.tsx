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
 * reason (a sentence chosen by CODE, never text out of a run), the usage
 * bars with their age, the last successful run, how long ago a refusal was
 * seen, the node-level warning — and that "not known" reads as not known,
 * never as "no agent can work".
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
    reasonCode: null,
    reason: null,
    checkedAt: '2026-11-10T12:00:00.000Z',
    ...over,
});

const report = (
    agents: FleetAgentReadinessEntry[],
    anyReady: boolean | null = agents.some(
        (entry) => entry.installed === true && entry.status === 'ready',
    ),
): FleetNodeAgentReadinessView => ({
    at: '2026-11-10T12:00:01.000Z',
    checkedAt: '2026-11-10T12:00:00.000Z',
    agents,
    anyReady,
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
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([
                        agent({
                            status: 'access_denied',
                            reasonCode: 'org_access_disabled',
                            reason: 'The organization has disabled subscription access for this CLI. Use an API key, or ask an admin to enable access.',
                            lastFailureAt: new Date(NOW - 3 * 3_600_000).toISOString(),
                            lastFailureKind: 'access_denied',
                            lastFailureCode: 'org_access_disabled',
                        }),
                    ]),
                    anyAgentReady: false,
                })}
                compact
            />,
        );

        expect(screen.getByTestId('agent-readiness-warning-n1')).toHaveTextContent('noneReady');
        expect(screen.getByTestId('agent-readiness-status-n1-claude-code')).toHaveTextContent(
            'status.access_denied',
        );
        // The sentence is chosen by the CODE, in the viewer's language.
        const shown = screen.getByTestId('agent-readiness-reason-n1-claude-code');
        expect(shown).toHaveTextContent('reason.org_access_disabled');
        expect(shown).toHaveAttribute('title', 'reason.org_access_disabled');
        expect(shown).toHaveAttribute('data-reason-code', 'org_access_disabled');
        // A verdict a run proved carries its age.
        const seen = screen.getByTestId('agent-readiness-failure-n1-claude-code');
        expect(seen).toHaveAttribute('data-failure-mode', 'seen');
        expect(seen).toHaveTextContent('lastSeen:ago.hour:3');
    });

    it('falls back to the platform’s own sentence for a reason code this build has no words for', () => {
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report(
                        [
                            agent({
                                status: 'unknown',
                                reasonCode: 'a_code_from_the_future',
                                reason: 'A sentence a newer platform built.',
                            }),
                        ],
                        null,
                    ),
                    anyAgentReady: null,
                })}
                compact
            />,
        );
        expect(screen.getByTestId('agent-readiness-reason-n1-claude-code')).toHaveTextContent(
            'A sentence a newer platform built.',
        );
    });

    it('says which limit, and when it resets', () => {
        render(
            <AgentReadinessList
                node={node({
                    agentReadiness: report([
                        agent({
                            status: 'limit_reached',
                            reasonCode: 'usage_limit',
                            reason: 'The weekly limit is reached.',
                            limitWindow: 'weekly',
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
        expect(screen.getByTestId('agent-readiness-reason-n1-claude-code')).toHaveTextContent(
            'reason.usage_limit:limitWindow.weekly',
        );
    });

    describe('not known is not "cannot" (review item 5)', () => {
        const timedOut = (provider: string) =>
            agent({
                provider,
                installed: null,
                version: null,
                signedIn: null,
                authMethod: 'unknown',
                account: null,
                status: 'unknown',
                reasonCode: 'probe_timed_out',
                reason: 'The startup lookup for this CLI timed out. Restart the node when the computer is less busy.',
            });

        it('a computer whose agents could not be judged gets a neutral line, not the warning — and keeps the rows that say why', () => {
            render(
                <AgentReadinessList
                    node={node({
                        agentReadiness: report([timedOut('claude-code'), timedOut('codex')], null),
                        anyAgentReady: null,
                    })}
                    compact
                />,
            );

            expect(screen.getByTestId('agent-readiness-n1')).toHaveAttribute(
                'data-summary',
                'undetermined',
            );
            expect(screen.getByTestId('agent-readiness-undetermined-n1')).toHaveTextContent(
                'undetermined',
            );
            expect(screen.queryByTestId('agent-readiness-warning-n1')).toBeNull();
            expect(screen.queryByRole('status')).toBeNull();
            // Compact, and still there: the rows that explain it.
            for (const provider of ['claude-code', 'codex']) {
                expect(
                    screen.getByTestId(`agent-readiness-status-n1-${provider}`),
                ).toHaveTextContent('status.unknown');
                expect(
                    screen.getByTestId(`agent-readiness-reason-n1-${provider}`),
                ).toHaveTextContent('reason.probe_timed_out');
            }
        });

        it('a refusal that has aged out reads unknown, with the last failure and its time kept in view', () => {
            render(
                <AgentReadinessList
                    node={node({
                        agentReadiness: report(
                            [
                                agent({
                                    status: 'unknown',
                                    reasonCode: 'verdict_stale',
                                    reason: 'The last run was refused and none has run since, so the current state is not known.',
                                    lastFailureAt: new Date(NOW - 3 * 86_400_000).toISOString(),
                                    lastFailureKind: 'not_signed_in',
                                    lastFailureCode: 'session_expired',
                                }),
                            ],
                            null,
                        ),
                        anyAgentReady: null,
                    })}
                    compact
                />,
            );

            expect(screen.queryByTestId('agent-readiness-warning-n1')).toBeNull();
            expect(screen.getByTestId('agent-readiness-status-n1-claude-code')).toHaveTextContent(
                'status.unknown',
            );
            const last = screen.getByTestId('agent-readiness-failure-n1-claude-code');
            expect(last).toHaveAttribute('data-failure-mode', 'last');
            expect(last).toHaveTextContent('lastFailure:ago.day:3,reason.session_expired');
        });
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
                            // A reading always comes with when it was taken.
                            usageObservedAt: new Date(NOW - 3_600_000).toISOString(),
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

    it('says how old the usage reading is, and stops showing a window that has rolled over (review item 8)', () => {
        const withUsage = (observedAt: string) =>
            node({
                agentReadiness: report([
                    agent({
                        usage: [
                            // No reset named: good for its own five hours after it was observed.
                            {
                                window: 'five_hour',
                                usedPercent: 82,
                                resetsAt: null,
                                windowMinutes: 300,
                            },
                            {
                                window: 'weekly',
                                usedPercent: 40,
                                resetsAt: new Date(NOW + 2 * 86_400_000).toISOString(),
                            },
                        ],
                        usageObservedAt: observedAt,
                    }),
                ]),
            });

        const { rerender } = render(
            <AgentReadinessList
                node={withUsage(new Date(NOW - 2 * 3_600_000).toISOString())}
                compact
            />,
        );
        expect(screen.getAllByRole('progressbar')).toHaveLength(2);
        expect(screen.getByTestId('agent-usage-as-of-n1-claude-code')).toHaveTextContent(
            'usageAsOf:ago.hour:2',
        );

        // The same reading, six hours old: the five-hour figure is no longer true of anything.
        rerender(
            <AgentReadinessList
                node={withUsage(new Date(NOW - 6 * 3_600_000).toISOString())}
                compact
            />,
        );
        expect(screen.queryByTestId('agent-usage-five_hour')).toBeNull();
        expect(screen.getByTestId('agent-usage-weekly')).toBeInTheDocument();
        expect(screen.getByTestId('agent-usage-as-of-n1-claude-code')).toHaveTextContent(
            'usageAsOf:ago.hour:6',
        );
    });

    it('shows no "as of" line when there is no usage to date', () => {
        render(<AgentReadinessList node={node()} compact />);
        expect(screen.queryByTestId('agent-usage-as-of-n1-claude-code')).toBeNull();
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

    it('marks run figures that are a floor: more finished than one read counts', () => {
        render(
            <AgentReadinessList
                node={node({
                    runStats: {
                        last24h: { runs: 310, failed: 12, costCents: 0 },
                        last7d: { runs: 2000, failed: 37, costCents: 0 },
                        capped: true,
                    },
                })}
            />,
        );
        expect(screen.getByTestId('agent-readiness-runs-n1')).toHaveAttribute(
            'data-capped',
            'true',
        );
        expect(screen.getByTestId('agent-readiness-runs-24h-n1')).toHaveTextContent(
            'runs.counts:310,12',
        );
        expect(screen.getByTestId('agent-readiness-runs-7d-n1')).toHaveTextContent(
            'runs.countsFloor:2000,37',
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
