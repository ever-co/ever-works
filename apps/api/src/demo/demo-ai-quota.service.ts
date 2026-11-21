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

/** The usage-counter key of one sandbox's AI requests (the demo sweeper removes it with the sandbox). */
export function sandboxQuotaKey(userId: string | undefined): string {
    return `ai:sandbox:${userId}`;
}

/**
 * Platform demo mode (`DEMO=true`) — the AI quota behind `DEMO_AI_QUOTA`, kept in
 * `demo_usage_counters` so every API pod and (through the remote proxy) every Trigger
 * worker share one count.
 *
 * Three fixed windows:
 *   - `ai:day:<YYYY-MM-DD>` — the instance's UTC day (`DEMO_AI_REQUESTS_PER_DAY`); the
 *     window ends at the next UTC midnight. Over it: `DemoQuotaExceededError('day')`.
 *   - `ai:sandbox:<userId>` — the visitor's sandbox (`DEMO_AI_REQUESTS_PER_SANDBOX`); the
 *     window is the user's `anonymousExpiresAt`. Over it, or past that TTL (fail closed):
 *     `DemoQuotaExceededError('sandbox')`. Skipped for system work (`userId` undefined) and
 *     for a user with no `anonymousExpiresAt` (an operator). A `userId` with no user row (a
 *     sandbox already deleted) fails closed the same way, before anything is counted.
 *   - `ai:min:<YYYY-MM-DDTHH:MM>` — the instance's minute (`DEMO_AI_REQUESTS_PER_MINUTE`,
 *     under OpenRouter's 20/min free limit). Over it: `DemoRateLimitedError` carrying the
 *     milliseconds left in the minute.
 *
 * A refused call is charged to nothing (ruling R11):
 *   1. the day and the sandbox are READ first; a used-up one refuses before anything is
 *      counted, so a spent sandbox retrying cannot take the minute's slots (everyone else
 *      would see "busy") nor the instance's day;
 *   2. then the minute is counted (atomic increment); a busy call stops there, so it costs
 *      the day and the sandbox nothing;
 *   3. then the day and the sandbox are counted, each re-checked against its cap.
 * Calls racing past the reads in step 1 can overshoot a cap by the calls in flight, which the
 * minute limit bounds; step 3 still refuses the ones that land over it.
 */
@Injectable()
export class DemoAiQuotaService implements DemoAiQuotaPort {
    private readonly sandboxWindows = new Map<string, { endsAt: Date | null; readAt: number }>();

    constructor(
        private readonly counters: DemoUsageCounterRepository,
        private readonly users: UserRepository,
    ) {}

    async consume(userId: string | undefined, now: Date = new Date()): Promise<void> {
        const perDay = config.demo.aiRequestsPerDay();
        const perSandbox = config.demo.aiRequestsPerSandbox();
        const dayKey = dayKeyOf(now);
        const sandboxEndsAt = userId ? await this.sandboxWindowEnd(userId) : null;
        const sandboxKey = sandboxQuotaKey(userId);

        // 1. Read the day and the sandbox: a used-up one refuses with nothing counted.
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

        // 2. Count the minute: a busy call stops here, charged to neither the day nor the sandbox.
        const minuteEndsAt = new Date((Math.floor(now.getTime() / MINUTE_MS) + 1) * MINUTE_MS);
        const inMinute = await this.counters.increment(minuteKeyOf(now), minuteEndsAt, now);
        if (inMinute > config.demo.aiRequestsPerMinute()) {
            throw new DemoRateLimitedError(minuteEndsAt.getTime() - now.getTime());
        }

        // 3. Count the day and the sandbox, each re-checked (a call that lost a race to the cap).
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

    /**
     * The user's `anonymousExpiresAt`, or null when it has none (an operator); cached briefly
     * per user. A user with no row at all (a sandbox the sweeper deleted mid-flight, or an id
     * that never existed) is no operator: refused with `DemoQuotaExceededError('sandbox')`, as
     * a sandbox past its TTL is, and the miss is not cached, so a row that appears is served.
     */
    private async sandboxWindowEnd(userId: string): Promise<Date | null> {
        const cached = this.sandboxWindows.get(userId);
        if (cached && Date.now() - cached.readAt < SANDBOX_WINDOW_CACHE_MS) return cached.endsAt;

        const user = await this.users.findById(userId);
        if (!user) {
            this.sandboxWindows.delete(userId);
            throw new DemoQuotaExceededError('sandbox');
        }
        const endsAt = user.anonymousExpiresAt ? new Date(user.anonymousExpiresAt) : null;

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
