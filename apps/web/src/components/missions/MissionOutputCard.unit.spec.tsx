import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Mission } from '@/lib/api/missions';

/**
 * APW-08 T36 (FR-51…FR-53) — the Mission's Output card: the three modes, the Task-output limits
 * shown only when it files Tasks, the bounds the API enforces, the notice for a Mission with no
 * App or Repository Work to file on, and the notice for an attached Repository Work whose Task
 * isolation is off.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const updateMissionAction = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    updateMissionAction: (...args: unknown[]) => updateMissionAction(...args),
}));

import { MissionOutputCard } from './MissionOutputCard';

function mission(overrides: Partial<Mission> = {}): Mission {
    return {
        id: 'm1',
        title: 'Grow Bookings',
        outputMode: 'ideas',
        taskOutput: { tasksPerTick: 1, openTasksCap: 3 },
        ...overrides,
    } as Mission;
}

beforeEach(() => {
    vi.clearAllMocks();
    updateMissionAction.mockImplementation(async (_id: string, input: Partial<Mission>) =>
        mission({ ...input } as Partial<Mission>),
    );
});

describe('MissionOutputCard (APW-08 T36)', () => {
    it('an ideas Mission shows the three modes and no Task limits', () => {
        render(<MissionOutputCard mission={mission()} hasTaskWork onMissionChange={vi.fn()} />);
        expect(screen.getByTestId('mission-output-ideas')).toBeChecked();
        expect(screen.getByTestId('mission-output-tasks')).not.toBeChecked();
        expect(screen.queryByTestId('mission-output-limits')).toBeNull();
    });

    it('choosing Tasks shows the limits; Save sends the mode and the bounded output', async () => {
        const onMissionChange = vi.fn();
        render(
            <MissionOutputCard mission={mission()} hasTaskWork onMissionChange={onMissionChange} />,
        );
        fireEvent.click(screen.getByTestId('mission-output-tasks'));
        expect(screen.getByTestId('mission-output-limits')).toBeInTheDocument();
        fireEvent.change(screen.getByTestId('mission-output-per-tick'), { target: { value: '9' } });
        fireEvent.change(screen.getByTestId('mission-output-open-cap'), { target: { value: '0' } });
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() =>
            expect(updateMissionAction).toHaveBeenCalledWith('m1', {
                outputMode: 'tasks',
                taskOutput: { tasksPerTick: 3, openTasksCap: 1 },
            }),
        );
        expect(onMissionChange).toHaveBeenCalledWith(
            expect.objectContaining({ outputMode: 'tasks' }),
        );
        expect(toastSuccess).toHaveBeenCalledWith('saved');
    });

    it('with no App or Repository Work attached, says what to attach — before saving, and after the API warns', async () => {
        const { unmount } = render(
            <MissionOutputCard
                mission={mission({ outputMode: 'both' })}
                hasTaskWork={false}
                onMissionChange={vi.fn()}
            />,
        );
        expect(screen.getByTestId('mission-output-no-app-work')).toHaveTextContent('noAppWork');
        // Nothing is attached, so there is no Repository Work to report either.
        expect(screen.queryByTestId('mission-output-repo-isolation-off')).toBeNull();
        unmount();

        updateMissionAction.mockResolvedValueOnce(
            mission({ outputMode: 'tasks', warnings: ['noAppWorkRelation'] }),
        );
        render(<MissionOutputCard mission={mission()} hasTaskWork onMissionChange={vi.fn()} />);
        fireEvent.click(screen.getByTestId('mission-output-tasks'));
        expect(screen.queryByTestId('mission-output-no-app-work')).toBeNull();
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() =>
            expect(screen.getByTestId('mission-output-no-app-work')).toBeInTheDocument(),
        );
        expect(screen.queryByTestId('mission-output-repo-isolation-off')).toBeNull();
    });

    it('a Repository Work with Task isolation off: says so and links to that Work’s settings', () => {
        render(
            <MissionOutputCard
                mission={mission({ outputMode: 'tasks' })}
                hasTaskWork
                isolationOffWorks={[
                    { workId: 'w-repo', workName: 'ever-works' },
                    { workId: 'w-site', workName: 'website' },
                ]}
                onMissionChange={vi.fn()}
            />,
        );
        const notice = screen.getByTestId('mission-output-repo-isolation-off');
        expect(notice).toHaveTextContent('repoIsolationOff');
        expect(screen.getByRole('link', { name: 'ever-works' })).toHaveAttribute(
            'href',
            '/works/w-repo/settings',
        );
        expect(screen.getByRole('link', { name: 'website' })).toHaveAttribute(
            'href',
            '/works/w-site/settings',
        );
        // A Repository Work IS attached: this is not the "attach a Work" case.
        expect(screen.queryByTestId('mission-output-no-app-work')).toBeNull();
    });

    it('the isolation notice is shown only while the Mission files Tasks', () => {
        render(
            <MissionOutputCard
                mission={mission({ outputMode: 'ideas' })}
                hasTaskWork
                isolationOffWorks={[{ workId: 'w-repo', workName: 'ever-works' }]}
                onMissionChange={vi.fn()}
            />,
        );
        expect(screen.queryByTestId('mission-output-repo-isolation-off')).toBeNull();
        fireEvent.click(screen.getByTestId('mission-output-both'));
        expect(screen.getByTestId('mission-output-repo-isolation-off')).toBeInTheDocument();
    });

    it('shows the isolation notice once the API warns repoWorkTaskIsolationOff, even with no Work named', async () => {
        updateMissionAction.mockResolvedValueOnce(
            mission({ outputMode: 'tasks', warnings: ['repoWorkTaskIsolationOff'] }),
        );
        render(<MissionOutputCard mission={mission()} hasTaskWork onMissionChange={vi.fn()} />);
        fireEvent.click(screen.getByTestId('mission-output-tasks'));
        expect(screen.queryByTestId('mission-output-repo-isolation-off')).toBeNull();
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() =>
            expect(screen.getByTestId('mission-output-repo-isolation-off')).toHaveTextContent(
                'repoIsolationOff',
            ),
        );
        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.queryByTestId('mission-output-no-app-work')).toBeNull();
    });

    // Only the API can tell these two (they depend on the Agent and the merge policy), so they
    // are shown from a save's answer, and cleared by the next answer without them.
    it('shows the Agent and the merge-policy notices from the API’s warnings, and clears them', async () => {
        updateMissionAction.mockResolvedValueOnce(
            mission({
                outputMode: 'tasks',
                warnings: ['repoWorkAgentCannotOpenPullRequests', 'repoWorkAllowsAgentMerge'],
            }),
        );
        render(<MissionOutputCard mission={mission()} hasTaskWork onMissionChange={vi.fn()} />);
        fireEvent.click(screen.getByTestId('mission-output-tasks'));
        expect(screen.queryByTestId('mission-output-repo-agent-cannot-open-prs')).toBeNull();
        expect(screen.queryByTestId('mission-output-repo-allows-agent-merge')).toBeNull();
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() =>
            expect(
                screen.getByTestId('mission-output-repo-agent-cannot-open-prs'),
            ).toHaveTextContent('repoAgentCannotOpenPullRequests'),
        );
        expect(screen.getByTestId('mission-output-repo-allows-agent-merge')).toHaveTextContent(
            'repoAllowsAgentMerge',
        );
        // Neither is "no Work attached" or "isolation off".
        expect(screen.queryByTestId('mission-output-no-app-work')).toBeNull();
        expect(screen.queryByTestId('mission-output-repo-isolation-off')).toBeNull();

        updateMissionAction.mockResolvedValueOnce(mission({ outputMode: 'tasks', warnings: [] }));
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() =>
            expect(screen.queryByTestId('mission-output-repo-agent-cannot-open-prs')).toBeNull(),
        );
        expect(screen.queryByTestId('mission-output-repo-allows-agent-merge')).toBeNull();
    });

    it('a refused save shows the error and leaves the Mission as it was', async () => {
        updateMissionAction.mockRejectedValueOnce(
            new Error('outputMode must be one of ideas, tasks, both.'),
        );
        const onMissionChange = vi.fn();
        render(
            <MissionOutputCard mission={mission()} hasTaskWork onMissionChange={onMissionChange} />,
        );
        fireEvent.click(screen.getByTestId('mission-output-save'));
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(onMissionChange).not.toHaveBeenCalled();
    });
});
