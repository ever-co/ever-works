import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDemoConfig = vi.hoisted(() => vi.fn());
vi.mock('@/lib/feature-flags/demo', () => ({ getDemoConfig }));

import { buildDemoStrip } from './demo-strip';

const demo = {
    expiresAt: '2026-11-21T08:00:00.000Z',
    aiQuotaExhausted: true,
    recordedGoalId: 'g-1',
};

describe('buildDemoStrip', () => {
    beforeEach(() => {
        getDemoConfig.mockReset();
        getDemoConfig.mockResolvedValue({
            enabled: true,
            signUpUrl: 'https://signup.example/register',
            sandboxTtlHours: 24,
        });
    });

    it('is null when the profile has no demo block, and asks nothing', async () => {
        await expect(buildDemoStrip(null)).resolves.toBeNull();
        await expect(buildDemoStrip(undefined)).resolves.toBeNull();
        expect(getDemoConfig).not.toHaveBeenCalled();
    });

    it('is null when the instance reports demo off, even with a demo block', async () => {
        getDemoConfig.mockResolvedValue({
            enabled: false,
            signUpUrl: 'https://app.ever.works/register',
            sandboxTtlHours: 24,
        });

        await expect(buildDemoStrip(demo)).resolves.toBeNull();
    });

    it('carries the profile fields, the sign-up URL and the Goal route', async () => {
        await expect(buildDemoStrip(demo)).resolves.toEqual({
            signUpUrl: 'https://signup.example/register',
            expiresAt: demo.expiresAt,
            aiQuotaExhausted: true,
            recordedGoalHref: '/goals/g-1',
        });
    });

    it('has no Goal link when the recorded Goal is gone', async () => {
        const strip = await buildDemoStrip({ ...demo, recordedGoalId: null });

        expect(strip?.recordedGoalHref).toBeNull();
    });
});
