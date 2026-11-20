/** What the profile tells the web about a demo sandbox (the demo strip). */
export interface DemoProfile {
    /** The sandbox's `anonymousExpiresAt`, ISO 8601. */
    expiresAt: string;
    /** True once the instance's AI requests for the UTC day are used up. */
    aiQuotaExhausted: boolean;
    /** The sandbox's own recorded Goal, or null when it is gone (deleted, or the seed failed). */
    recordedGoalId: string | null;
}

export type DemoProfileUser = {
    id: string;
    tenantId?: string | null;
    registrationProvider?: string | null;
    anonymousExpiresAt?: Date | null;
};

export interface DemoProfilePort {
    /** Null for anything but a demo sandbox on a demo instance (an operator, or demo off). */
    getDemoProfile(user: DemoProfileUser): Promise<DemoProfile | null>;
}

/**
 * Bound by `DemoModule` only. A token of its own, with no imports, so `AuthService` can look
 * the port up without pulling the demo module's graph (seed fixture, quota service) into the
 * auth module's imports.
 */
export const DEMO_PROFILE = Symbol('DEMO_PROFILE');
