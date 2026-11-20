import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isDemoSandboxUser } from '@ever-works/agent/demo';
import { Goal } from '@ever-works/agent/entities';
import { DemoAiQuotaService } from './demo-ai-quota.service';
import { type DemoProfile, type DemoProfilePort, type DemoProfileUser } from './demo-profile.port';
import { DEMO_SANDBOX_FIXTURE } from './seed/demo-sandbox.fixture';

/** The seeded, completed Goal whose recorded runs the strip points at once live AI is spent. */
const RECORDED_GOAL_TITLE = DEMO_SANDBOX_FIXTURE.goals.find(
    (goal) => goal.key === 'launch-post',
)!.title;

/**
 * Platform demo mode — the `demo` block of `GET /api/auth/profile/fresh`. Provided by
 * `DemoModule` only, so an instance without `DEMO` has no such provider and the profile
 * carries `demo: null` (`AuthService` resolves it with `getOptionalProvider`).
 */
@Injectable()
export class DemoProfileService implements DemoProfilePort {
    constructor(
        private readonly quota: DemoAiQuotaService,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    /** Null for anything but a demo sandbox on a demo instance (an operator, or demo off). */
    async getDemoProfile(user: DemoProfileUser): Promise<DemoProfile | null> {
        if (!isDemoSandboxUser(user) || !user.anonymousExpiresAt) return null;

        const [aiQuotaExhausted, recordedGoalId] = await Promise.all([
            this.quota.isDayExhausted(),
            this.findRecordedGoalId(user),
        ]);
        return {
            expiresAt: new Date(user.anonymousExpiresAt).toISOString(),
            aiQuotaExhausted,
            recordedGoalId,
        };
    }

    /**
     * Every sandbox has a Goal with the same title, so the lookup is scoped to the sandbox's own
     * owner AND Tenant (the seed gives each sandbox a Tenant of its own): a title match alone
     * would hand out another visitor's Goal.
     */
    private async findRecordedGoalId(user: DemoProfileUser): Promise<string | null> {
        if (!user.tenantId) return null;
        const goal = await this.dataSource.getRepository(Goal).findOne({
            select: { id: true },
            where: { userId: user.id, tenantId: user.tenantId, title: RECORDED_GOAL_TITLE },
        });
        return goal?.id ?? null;
    }
}
