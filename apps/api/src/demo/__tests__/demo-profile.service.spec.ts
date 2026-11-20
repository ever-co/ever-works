import { DemoProfileService } from '../demo-profile.service';
import { DEMO_SANDBOX_FIXTURE } from '../seed/demo-sandbox.fixture';

const GOAL_TITLE = DEMO_SANDBOX_FIXTURE.goals.find((goal) => goal.key === 'launch-post')!.title;
const EXPIRES = new Date('2026-11-21T08:00:00.000Z');
const ENV_KEYS = ['DEMO'];

/** One Goal row of any sandbox; the fake repository applies the real query's where-clause. */
type GoalRow = { id: string; userId: string; tenantId: string | null; title: string };

function build(options: { goals?: GoalRow[]; exhausted?: boolean } = {}) {
    const goals = options.goals ?? [];
    const findOne = jest.fn(async ({ where }: { where: Partial<GoalRow> }) => {
        return (
            goals.find(
                (row) =>
                    row.userId === where.userId &&
                    row.tenantId === where.tenantId &&
                    row.title === where.title,
            ) ?? null
        );
    });
    const dataSource = { getRepository: jest.fn(() => ({ findOne })) };
    const quota = { isDayExhausted: jest.fn(async () => options.exhausted ?? false) };
    const service = new DemoProfileService(quota as any, dataSource as any);
    return { service, quota, findOne };
}

const demoUser = {
    id: 'u-mine',
    tenantId: 't-mine',
    registrationProvider: 'demo',
    anonymousExpiresAt: EXPIRES,
};

describe('DemoProfileService', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        for (const key of ENV_KEYS) saved[key] = process.env[key];
        process.env.DEMO = 'true';
    });
    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('describes a demo sandbox: expiry, quota state and its own recorded Goal', async () => {
        const { service } = build({
            exhausted: true,
            goals: [{ id: 'g-mine', userId: 'u-mine', tenantId: 't-mine', title: GOAL_TITLE }],
        });

        await expect(service.getDemoProfile(demoUser as any)).resolves.toEqual({
            expiresAt: EXPIRES.toISOString(),
            aiQuotaExhausted: true,
            recordedGoalId: 'g-mine',
        });
    });

    it('reports the quota as available while the day is not used up', async () => {
        const { service } = build();

        const demo = await service.getDemoProfile(demoUser as any);

        expect(demo?.aiQuotaExhausted).toBe(false);
    });

    it("never returns another sandbox's same-named Goal (R32)", async () => {
        const { service, findOne } = build({
            goals: [
                { id: 'g-other', userId: 'u-other', tenantId: 't-other', title: GOAL_TITLE },
                { id: 'g-other-tenant', userId: 'u-mine', tenantId: 't-other', title: GOAL_TITLE },
            ],
        });

        const demo = await service.getDemoProfile(demoUser as any);

        expect(demo?.recordedGoalId).toBeNull();
        expect(findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 'u-mine', tenantId: 't-mine', title: GOAL_TITLE },
            }),
        );
    });

    it('has no recorded Goal for a sandbox without a tenant (the seed failed)', async () => {
        const { service, findOne } = build();

        const demo = await service.getDemoProfile({ ...demoUser, tenantId: null } as any);

        expect(demo?.recordedGoalId).toBeNull();
        expect(findOne).not.toHaveBeenCalled();
    });

    it('is null for an operator (a normal account on a demo instance)', async () => {
        const { service, quota } = build();

        await expect(
            service.getDemoProfile({ ...demoUser, registrationProvider: 'email' } as any),
        ).resolves.toBeNull();
        expect(quota.isDayExhausted).not.toHaveBeenCalled();
    });

    it('is null when the demo is off, even for a sandbox row', async () => {
        delete process.env.DEMO;
        const { service, quota, findOne } = build();

        await expect(service.getDemoProfile(demoUser as any)).resolves.toBeNull();
        expect(quota.isDayExhausted).not.toHaveBeenCalled();
        expect(findOne).not.toHaveBeenCalled();
    });

    it('is null for a sandbox with no expiry', async () => {
        const { service } = build();

        await expect(
            service.getDemoProfile({ ...demoUser, anonymousExpiresAt: null } as any),
        ).resolves.toBeNull();
    });
});
