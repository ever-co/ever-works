import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentCard } from './AgentCard';
import type { Agent } from '@/lib/api/agents';

vi.mock('next-intl', () => ({
    // Keys come back as-is, with their values appended, so a test can see
    // both which message was chosen and what was put into it.
    useTranslations:
        () =>
        (key: string, values?: Record<string, unknown>): string =>
            values ? `${key} ${JSON.stringify(values)}` : key,
    useFormatter: () => ({
        relativeTime: (date: Date) => `rel(${date.toISOString()})`,
    }),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: 'tenant',
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        environmentId: null,
        maxSkillContextTokens: 4000,
        status: 'draft',
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
        targets: null,
        reportsToAgentId: null,
        guardrails: null,
        heartbeatCadence: null,
        idleBehavior: 'propose',
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: 'initials',
        avatarIcon: null,
        avatarImageUploadId: null,
        scorecard: null,
        initScript: null,
        contentHash: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...over,
    };
}

describe('AgentCard', () => {
    it('renders the agent name and scope label', () => {
        render(<AgentCard agent={makeAgent({ name: 'CEO', scope: 'tenant' })} />);
        expect(screen.getByText('CEO')).toBeTruthy();
        expect(screen.getByText('scopeTenant')).toBeTruthy();
    });

    it('shows initials when avatarMode is "initials"', () => {
        render(<AgentCard agent={makeAgent({ name: 'Quality Assurance' })} />);
        expect(screen.getByText('QA')).toBeTruthy();
    });

    it('renders heartbeat cadence when present', () => {
        render(<AgentCard agent={makeAgent({ heartbeatCadence: '*/15 * * * *' })} />);
        expect(screen.getByText(/cadencePrefix \*\/15/)).toBeTruthy();
    });

    it('falls back to "noCadence" when not set', () => {
        render(<AgentCard agent={makeAgent({ heartbeatCadence: null })} />);
        expect(screen.getByText('noCadence')).toBeTruthy();
    });

    describe('an Agent without a heartbeat says what drives it', () => {
        it('recurring Tasks: "Runs on schedule · next <time>"', () => {
            render(
                <AgentCard
                    agent={makeAgent({
                        heartbeatCadence: null,
                        recurringTasks: { activeCount: 2, nextRunAt: '2026-11-11T03:00:00.000Z' },
                    })}
                />,
            );
            expect(screen.getByTestId('agent-card-drive').textContent).toBe(
                'runsOnScheduleNext {"time":"rel(2026-11-11T03:00:00.000Z)"}',
            );
        });

        it('recurring Tasks without a known next fire: "Runs on schedule"', () => {
            render(
                <AgentCard
                    agent={makeAgent({ recurringTasks: { activeCount: 1, nextRunAt: null } })}
                />,
            );
            expect(screen.getByTestId('agent-card-drive').textContent).toBe('runsOnSchedule');
        });

        it('no active recurring Task: "Runs when assigned"', () => {
            render(
                <AgentCard
                    agent={makeAgent({ recurringTasks: { activeCount: 0, nextRunAt: null } })}
                />,
            );
            expect(screen.getByTestId('agent-card-drive').textContent).toBe('runsWhenAssigned');
        });

        it('`manual` is not a heartbeat', () => {
            render(
                <AgentCard
                    agent={makeAgent({
                        heartbeatCadence: 'manual',
                        recurringTasks: { activeCount: 0, nextRunAt: null },
                    })}
                />,
            );
            expect(screen.getByTestId('agent-card-drive').textContent).toBe('runsWhenAssigned');
        });

        it('a heartbeat Agent keeps "Heartbeat: <cadence>"', () => {
            render(
                <AgentCard
                    agent={makeAgent({
                        heartbeatCadence: '0 9 * * *',
                        recurringTasks: { activeCount: 4, nextRunAt: null },
                    })}
                />,
            );
            expect(screen.getByTestId('agent-card-drive').textContent).toBe(
                'cadencePrefix 0 9 * * *',
            );
        });
    });

    describe('last run', () => {
        it('shows "Last run <relative time> · <status>" from the latest ENDED run of any kind', () => {
            render(
                <AgentCard
                    agent={makeAgent({
                        latestRun: { status: 'completed', finishedAt: '2026-11-10T21:04:00.000Z' },
                    })}
                />,
            );
            expect(screen.getByTestId('agent-card-last-run').textContent).toBe(
                'lastRun {"time":"rel(2026-11-10T21:04:00.000Z)","status":"lastRunCompleted"}',
            );
        });

        it('never reads the heartbeat lastRunAt: a running heartbeat is not a finished run', () => {
            render(
                <AgentCard
                    agent={makeAgent({
                        status: 'running',
                        lastRunAt: '2026-11-10T22:00:00.000Z',
                        lastRunStatus: 'failed',
                        latestRun: null,
                    })}
                />,
            );
            expect(screen.queryByTestId('agent-card-last-run')).toBeNull();
            expect(screen.getByText('statusRunning')).toBeTruthy();
        });

        it('shows a status it has no copy for as-is', () => {
            render(
                <AgentCard
                    agent={makeAgent({
                        latestRun: {
                            status: 'something-new',
                            finishedAt: '2026-11-10T21:04:00.000Z',
                        },
                    })}
                />,
            );
            expect(screen.getByTestId('agent-card-last-run').textContent).toContain(
                '"status":"something-new"',
            );
        });

        it('shows no last-run line for an Agent that never ran, or when it was not computed', () => {
            const { unmount } = render(<AgentCard agent={makeAgent({ latestRun: null })} />);
            expect(screen.queryByTestId('agent-card-last-run')).toBeNull();
            unmount();
            render(<AgentCard agent={makeAgent({ lastRunAt: '2026-11-10T21:00:00.000Z' })} />);
            expect(screen.queryByTestId('agent-card-last-run')).toBeNull();
        });
    });
});
