import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/actions/dashboard/schedules', () => ({ runScheduleNow: vi.fn() }));

import { runScheduleNow } from '@/app/actions/dashboard/schedules';
import { runScheduleNowAskingPastLimit } from './run-schedule-now';

/**
 * Recurring Tasks overlap limit — the one "run now" the Schedules menu and a computer's Schedules
 * tab share: a run at the open-instance limit is refused, the owner is asked, and only a yes
 * sends it again with `force`.
 */
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
const refused = (code: string) => ({
    ok: false as const,
    code,
    reasonKey: null,
    status: 409,
    runId: null,
});

describe('runScheduleNowAskingPastLimit', () => {
    beforeEach(() => vi.mocked(runScheduleNow).mockReset());

    it('a run that starts never asks', async () => {
        vi.mocked(runScheduleNow).mockResolvedValue(ran);
        const ask = vi.fn(() => true);
        await expect(runScheduleNowAskingPastLimit('recurring_task:t-1', {}, ask)).resolves.toBe(
            ran,
        );
        expect(ask).not.toHaveBeenCalled();
        expect(runScheduleNow).toHaveBeenCalledTimes(1);
    });

    it('any other refusal is answered as it came, without asking', async () => {
        vi.mocked(runScheduleNow).mockResolvedValue(refused('SCHEDULE_ALREADY_RUNNING'));
        const ask = vi.fn(() => true);
        const response = await runScheduleNowAskingPastLimit('recurring_task:t-1', {}, ask);
        expect(response).toMatchObject({ ok: false, code: 'SCHEDULE_ALREADY_RUNNING' });
        expect(ask).not.toHaveBeenCalled();
        expect(runScheduleNow).toHaveBeenCalledTimes(1);
    });

    it('at the limit it asks, and a yes sends the same request with force', async () => {
        vi.mocked(runScheduleNow)
            .mockResolvedValueOnce(refused('SCHEDULE_TOO_MANY_OPEN'))
            .mockResolvedValueOnce(ran);
        const ask = vi.fn(() => true);
        const response = await runScheduleNowAskingPastLimit(
            'recurring_task:t-1',
            { confirm: false },
            ask,
        );
        expect(response).toBe(ran);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(runScheduleNow).toHaveBeenNthCalledWith(1, 'recurring_task:t-1', { confirm: false });
        expect(runScheduleNow).toHaveBeenNthCalledWith(2, 'recurring_task:t-1', {
            confirm: false,
            force: true,
        });
    });

    it('a no runs nothing more and answers null', async () => {
        vi.mocked(runScheduleNow).mockResolvedValue(refused('SCHEDULE_TOO_MANY_OPEN'));
        await expect(
            runScheduleNowAskingPastLimit('recurring_task:t-1', {}, () => false),
        ).resolves.toBeNull();
        expect(runScheduleNow).toHaveBeenCalledTimes(1);
    });
});
