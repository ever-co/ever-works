import { describe, expect, it } from 'vitest';
import { agentDriveOf, agentLastRunStatusKey, hasHeartbeatCadence } from './agent-card.shared';

describe('agent card — what drives an Agent', () => {
    it('a real cadence is a heartbeat; null, blank and `manual` are not', () => {
        expect(hasHeartbeatCadence('0 * * * *')).toBe(true);
        expect(hasHeartbeatCadence(null)).toBe(false);
        expect(hasHeartbeatCadence('  ')).toBe(false);
        expect(hasHeartbeatCadence('manual')).toBe(false);
        expect(hasHeartbeatCadence('Manual')).toBe(false);
    });

    it('keeps the heartbeat for an Agent that has one, whatever its Tasks', () => {
        expect(
            agentDriveOf({
                heartbeatCadence: '0 9 * * *',
                recurringTasks: { activeCount: 3, nextRunAt: '2026-11-11T03:00:00.000Z' },
            }),
        ).toEqual({ kind: 'heartbeat', cadence: '0 9 * * *' });
    });

    it('says "on schedule" with the soonest next fire when recurring Tasks drive it', () => {
        expect(
            agentDriveOf({
                heartbeatCadence: null,
                recurringTasks: { activeCount: 2, nextRunAt: '2026-11-11T03:00:00.000Z' },
            }),
        ).toEqual({
            kind: 'schedule',
            activeCount: 2,
            nextRunAt: new Date('2026-11-11T03:00:00.000Z'),
        });
        expect(
            agentDriveOf({
                heartbeatCadence: 'manual',
                recurringTasks: { activeCount: 1, nextRunAt: null },
            }),
        ).toEqual({ kind: 'schedule', activeCount: 1, nextRunAt: null });
    });

    it('says "when assigned" when the list computed no active recurring Task', () => {
        expect(
            agentDriveOf({
                heartbeatCadence: null,
                recurringTasks: { activeCount: 0, nextRunAt: null },
            }),
        ).toEqual({ kind: 'assigned' });
    });

    it('claims nothing when the response did not compute Tasks at all', () => {
        expect(agentDriveOf({ heartbeatCadence: null })).toEqual({ kind: 'unknown' });
    });

    it('maps every status the platform writes to copy, and nothing else', () => {
        expect(agentLastRunStatusKey('completed')).toBe('lastRunCompleted');
        expect(agentLastRunStatusKey('failed')).toBe('lastRunFailed');
        expect(agentLastRunStatusKey('cancelled')).toBe('lastRunCancelled');
        expect(agentLastRunStatusKey('dispatch-failed')).toBe('lastRunDispatchFailed');
        expect(agentLastRunStatusKey('recovered-stuck')).toBe('lastRunRecoveredStuck');
        expect(agentLastRunStatusKey('weird')).toBeNull();
        expect(agentLastRunStatusKey(null)).toBeNull();
    });
});
