import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
        values ? `${ns}.${key}(${JSON.stringify(values)})` : `${ns}.${key}`,
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
// `Button` pulls in the locale-aware Link, which resolves `next/navigation` through next-intl.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/app/actions/fleet/usage', () => ({ getFleetUsageTaskCostsAction: vi.fn() }));
vi.mock('@/app/actions/dashboard/schedules', () => ({
    runScheduleNow: vi.fn(),
    pauseSchedule: vi.fn(),
    resumeSchedule: vi.fn(),
}));
vi.mock('./NewNodeScheduleDialog', () => ({ NewNodeScheduleDialog: () => null }));
vi.mock('./ScheduleRunHistory', () => ({ ScheduleRunHistory: () => null }));
vi.mock('./ScheduleUsageCost', () => ({ ScheduleUsageCost: () => null }));
vi.mock('./schedules.client', () => ({
    schedulesClient: {
        listAll: vi.fn(async () => ({
            ok: true,
            data: {
                commands: [],
                agentSessions: [
                    {
                        id: 'recurring_task:t-1',
                        taskId: 't-1',
                        name: 'Quality loop',
                        agentName: 'Builder',
                        cadenceHuman: 'Every day at 09:00',
                        nextRunAt: null,
                        lastRunAt: null,
                        paused: false,
                    },
                ],
            },
        })),
    },
}));

import { runScheduleNow } from '@/app/actions/dashboard/schedules';
import { SchedulesPanel } from './SchedulesPanel';

/**
 * Recurring Tasks overlap limit on a computer's Schedules tab (FL-13 Agent-session rows): Run now
 * on a recurring Task at its open-instance limit asks, like the Schedules menu, whether to run it
 * anyway, and only then sends `force`.
 */
const node = { id: 'node-1', name: 'Build box', kind: 'node', timeZone: 'UTC' } as never;
const T = 'fleet.schedules';
const tooMany = {
    ok: false as const,
    code: 'SCHEDULE_TOO_MANY_OPEN',
    reasonKey: null,
    status: 409,
    runId: null,
};
const ran = {
    ok: true as const,
    result: {
        kind: 'run' as const,
        scheduleId: 'recurring_task:t-1',
        runIds: ['run-1'],
        parked: false,
        queuedReason: null,
        taskId: 'instance-1',
        nextRunAt: null,
    },
};

async function clickRunNow() {
    render(<SchedulesPanel node={node} nodes={[node]} />);
    await waitFor(() => expect(screen.getByText('Quality loop')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: `${T}.actions.runNow` }));
}

describe('SchedulesPanel — Run now at the open-instance limit', () => {
    beforeEach(() => vi.mocked(runScheduleNow).mockReset());
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('asks with the specific "too many open" message, then runs it with force', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(runScheduleNow).mockResolvedValueOnce(tooMany).mockResolvedValueOnce(ran);
        await clickRunNow();

        await waitFor(() =>
            expect(
                screen.getByText(`${T}.runStarted(${JSON.stringify({ name: 'Quality loop' })})`),
            ).toBeTruthy(),
        );
        expect(confirm).toHaveBeenNthCalledWith(
            2,
            `dashboard.schedules.runNow.tooManyOpenConfirm(${JSON.stringify({ name: 'Quality loop' })})`,
        );
        expect(runScheduleNow).toHaveBeenNthCalledWith(1, 'recurring_task:t-1', {});
        expect(runScheduleNow).toHaveBeenNthCalledWith(2, 'recurring_task:t-1', { force: true });
    });

    it('a no to "run anyway" runs nothing more and shows no error', async () => {
        const confirm = vi
            .spyOn(window, 'confirm')
            .mockReturnValueOnce(true) // "Run on this computer?"
            .mockReturnValueOnce(false); // "Run anyway?"
        vi.mocked(runScheduleNow).mockResolvedValue(tooMany);
        await clickRunNow();

        await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
        expect(runScheduleNow).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(`${T}.errors.run`)).toBeNull();
    });
});
