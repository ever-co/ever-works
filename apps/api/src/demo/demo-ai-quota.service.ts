import { Injectable } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import { DemoUsageCounterRepository, UserRepository } from '@ever-works/agent/database';
import {
    DemoQuotaExceededError,
    DemoRateLimitedError,
    type DemoAiQuotaPort,
} from '@ever-works/agent/demo';

const MINUTE_MS = 60_000;
/** How long a user's sandbox window (`anonymousExpiresAt`) is reused before it is read again. */
const SANDBOX_WINDOW_CACHE_MS = 60_000;
/** Bound on that per-user cache; the least recently read entry goes first. */
const SANDBOX_WINDOW_CACHE_MAX = 1_000;

/**
 * Platform demo mode (`DEMO=true`) — the AI quota behind `DEMO_AI_QUOTA`, kept in
 * `demo_usage_counters` so every API pod and (through the remote proxy) every Trigger
 * worker share one count.
 *
 * Three fixed windows, checked in this order:
 *   1. `ai:min:<YYYY-MM-DDTHH:MM>` — the instance's minute (`DEMO_AI_REQUESTS_PER_MINUTE`,
 *      under OpenRouter's 20/min free limit). Over it: `DemoRateLimitedError` carrying the
 *      milliseconds left in the minute. A busy call is charged to nothing else.
 *   2. `ai:day:<YYYY-MM-DD>` — the instance's UTC day (`DEMO_AI_REQUESTS_PER_DAY`); the
 *      window ends at the next UTC midnight. Over it: `DemoQuotaExceededError('day')`.
 *   3. `ai:sandbox:<userId>` — the visitor's sandbox (`DEMO_AI_REQUESTS_PER_SANDBOX`); the
 *      window is the user's `anonymousExpiresAt`. Over it, or past that TTL (fail closed):
 *      `DemoQuotaExceededError('sandbox')`. Skipped for system work (`userId` undefined) and
 *      for a user with no `anonymousExpiresAt` (an operator, or a row already gone).
 *
 * The day and the sandbox are both read before either is charged, so a refused call
 * spends nothing: a spent sandbox that keeps retrying must not use up the instance's day.
 * Calls racing past those reads can overshoot a cap by the calls in flight, which the
 * minute limit bounds.
 */
@Injectable()
export class DemoAiQuotaService implements DemoAiQuotaPort {
    private readonly sandboxWindows = new Map<string, { endsAt: Date | null; readAt: number }>();

    constructor(
        private readonly counters: DemoUsageCounterRepository,
        private readonly users: UserRepository,
    ) {}

    async consume(userId: string | undefined, now: Date = new Date()): Promise<void> {
        const minuteEndsAt = new Date((Math.floor(now.getTime() / MINUTE_MS) + 1) * MINUTE_MS);
        const inMinute = await this.counters.increment(minuteKeyOf(now), minuteEndsAt, now);
        if (inMinute > config.demo.aiRequestsPerMinute()) {
            throw new DemoRateLimitedError(minuteEndsAt.getTime() - now.getTime());
        }

        const perDay = config.demo.aiRequestsPerDay();
        const perSandbox = config.demo.aiRequestsPerSandbox();
        const dayKey = dayKeyOf(now);
        const sandboxEndsAt = userId ? await this.sandboxWindowEnd(userId) : null;
        const sandboxKey = `ai:sandbox:${userId}`;

        const [usedToday, usedInSandbox] = await Promise.all([
            this.counters.peek(dayKey, now),
            sandboxEndsAt ? this.counters.peek(sandboxKey, now) : 0,
        ]);
        if (usedToday >= perDay) throw new DemoQuotaExceededError('day');
        if (
            sandboxEndsAt &&
            (sandboxEndsAt.getTime() <= now.getTime() || usedInSandbox >= perSandbox)
        ) {
            throw new DemoQuotaExceededError('sandbox');
        }

        if ((await this.counters.increment(dayKey, nextUtcMidnight(now), now)) > perDay) {
            throw new DemoQuotaExceededError('day');
        }
        if (
            sandboxEndsAt &&
            (await this.counters.increment(sandboxKey, sandboxEndsAt, now)) > perSandbox
        ) {
            throw new DemoQuotaExceededError('sandbox');
        }
    }

    /** True once the instance's AI requests for the current UTC day are used up. */
    async isDayExhausted(now: Date = new Date()): Promise<boolean> {
        return (await this.counters.peek(dayKeyOf(now), now)) >= config.demo.aiRequestsPerDay();
    }

    /** The user's `anonymousExpiresAt`, or null when there is none; cached briefly per user. */
    private async sandboxWindowEnd(userId: string): Promise<Date | null> {
        const cached = this.sandboxWindows.get(userId);
        if (cached && Date.now() - cached.readAt < SANDBOX_WINDOW_CACHE_MS) return cached.endsAt;

        const user = await this.users.findById(userId);
        const endsAt = user?.anonymousExpiresAt ? new Date(user.anonymousExpiresAt) : null;

        this.sandboxWindows.delete(userId);
        if (this.sandboxWindows.size >= SANDBOX_WINDOW_CACHE_MAX) {
            const oldest = this.sandboxWindows.keys().next().value;
            if (oldest !== undefined) this.sandboxWindows.delete(oldest);
        }
        this.sandboxWindows.set(userId, { endsAt, readAt: Date.now() });
        return endsAt;
    }
}

/** `ai:min:<YYYY-MM-DDTHH:MM>`, UTC. */
function minuteKeyOf(now: Date): string {
    return `ai:min:${now.toISOString().slice(0, 16)}`;
}

/** `ai:day:<YYYY-MM-DD>`, UTC. */
function dayKeyOf(now: Date): string {
    return `ai:day:${now.toISOString().slice(0, 10)}`;
}

function nextUtcMidnight(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
