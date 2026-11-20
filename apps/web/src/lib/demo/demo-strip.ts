import 'server-only';
import { ROUTES } from '@/lib/constants';
import type { DemoStripProps } from '@/components/demo/DemoStrip';
import { getDemoConfig } from '@/lib/feature-flags/demo';

/** The profile's `demo` block (`GET /auth/profile/fresh`); null for a normal user or demo off. */
export interface DemoProfile {
    expiresAt: string;
    aiQuotaExhausted: boolean;
    recordedGoalId: string | null;
}

/**
 * What the dashboard layout hands `<DemoStrip>`, or null for no strip. Null without asking the
 * API for anything when the profile has no `demo` block (an operator, or demo off), and null
 * when the instance does not itself report demo mode, so the strip needs both answers.
 */
export async function buildDemoStrip(
    demo: DemoProfile | null | undefined,
): Promise<DemoStripProps | null> {
    if (!demo) return null;
    const config = await getDemoConfig();
    if (!config.enabled) return null;
    return {
        signUpUrl: config.signUpUrl,
        expiresAt: demo.expiresAt,
        aiQuotaExhausted: demo.aiQuotaExhausted,
        recordedGoalHref: demo.recordedGoalId
            ? `${ROUTES.DASHBOARD_GOALS}/${demo.recordedGoalId}`
            : null,
    };
}
