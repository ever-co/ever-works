import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

/**
 * The Mission page's "Team and agents" panel — who works on a Mission: the
 * Teams that hold it (linked) with their Agents, then the Agents scoped to the
 * Mission or one of its Works that no Team shows; each with status + last run.
 */

vi.mock('next-intl', () => ({
    useTranslations:
        () =>
        (key: string, values?: Record<string, unknown>): string =>
            values ? `${key} ${JSON.stringify(values)}` : key,
    useFormatter: () => ({
        relativeTime: (date: Date) => `rel(${date.toISOString()})`,
    }),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const getMissionTeamAction = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    getMissionTeamAction: (...args: unknown[]) => getMissionTeamAction(...args),
}));

import { MissionTeamPanel } from './MissionTeamPanel';

const builder = {
    id: 'a1',
    name: 'Builder',
    status: 'active',
    latestRun: { status: 'completed', finishedAt: '2026-11-10T21:04:00.000Z' },
};

beforeEach(() => vi.clearAllMocks());

describe('MissionTeamPanel', () => {
    it('lists each Team (linked) with its Agents, their status and last run', async () => {
        getMissionTeamAction.mockResolvedValue({
            teams: [{ id: 't1', name: 'Product', slug: 'product', agents: [builder] }],
            agents: [],
        });

        render(<MissionTeamPanel missionId="m1" />);

        await waitFor(() => expect(screen.getByTestId('mission-team-team')).toBeTruthy());
        expect(getMissionTeamAction).toHaveBeenCalledWith('m1');
        expect(screen.getByText('Product').closest('a')).toHaveAttribute('href', '/teams/t1');
        const row = screen.getByTestId('mission-team-agent');
        expect(within(row).getByText('Builder').closest('a')).toHaveAttribute('href', '/agents/a1');
        expect(within(row).getByText('statusActive')).toBeTruthy();
        expect(
            within(row).getByText(
                'lastRun {"time":"rel(2026-11-10T21:04:00.000Z)","status":"lastRunCompleted"}',
            ),
        ).toBeTruthy();
    });

    it('lists the other Agents with what ties them to the Mission', async () => {
        getMissionTeamAction.mockResolvedValue({
            teams: [{ id: 't1', name: 'Product', slug: 'product', agents: [] }],
            agents: [
                {
                    ...builder,
                    id: 'a2',
                    name: 'Mission Lead',
                    via: 'mission',
                    workId: null,
                    workName: null,
                },
                {
                    ...builder,
                    id: 'a3',
                    name: 'Site Bot',
                    latestRun: null,
                    via: 'work',
                    workId: 'w1',
                    workName: 'ever.co website',
                },
                {
                    ...builder,
                    id: 'a4',
                    name: 'Ever Docs Writer',
                    via: 'standing-tasks',
                    workId: 'w1',
                    workName: 'ever.co website',
                },
            ],
        });

        render(<MissionTeamPanel missionId="m1" />);

        await waitFor(() => expect(screen.getByTestId('mission-team-others')).toBeTruthy());
        expect(screen.getByText('teamNoAgents')).toBeTruthy();
        expect(screen.getByText('otherAgents')).toBeTruthy();
        expect(screen.getByText('viaMission')).toBeTruthy();
        expect(screen.getByText('viaWork {"name":"ever.co website"}')).toBeTruthy();
        expect(screen.getByText('viaStandingTasks {"name":"ever.co website"}')).toBeTruthy();
        expect(screen.getByText('neverRan')).toBeTruthy();
    });

    it('says plainly when nobody works on the Mission yet', async () => {
        getMissionTeamAction.mockResolvedValue({ teams: [], agents: [] });
        render(<MissionTeamPanel missionId="m1" />);
        await waitFor(() => expect(screen.getByTestId('mission-team-empty')).toBeTruthy());
    });

    it('says it could not load, rather than showing an empty panel, when the read fails', async () => {
        getMissionTeamAction.mockRejectedValue(new Error('404'));
        render(<MissionTeamPanel missionId="m1" />);
        await waitFor(() => expect(screen.getByText('unavailable')).toBeTruthy());
        expect(screen.queryByTestId('mission-team-empty')).toBeNull();
    });
});
