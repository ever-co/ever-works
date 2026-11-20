import { DemoQuotaExceededError, DemoRateLimitedError } from '@ever-works/agent/demo';
import type { DemoUsageCounterRepository, UserRepository } from '@ever-works/agent/database';
import { DemoAiQuotaService } from '../demo-ai-quota.service';

/**
 * Platform demo mode — the DB-backed AI quota behind `DEMO_AI_QUOTA`.
 *
 * Three fixed-window counters: the instance's minute (`ai:min:<YYYY-MM-DDTHH:MM>`, 18), the
 * instance's UTC day (`ai:day:<YYYY-MM-DD>`, 900) and the caller's sandbox
 * (`ai:sandbox:<userId>`, 120 per TTL, window = `anonymousExpiresAt`). Ruling R11: the day and
 * the sandbox are read first and a used-up one refuses with nothing counted; then the minute is
 * counted (busy stops there); then the day and the sandbox.
 */

/** `DemoUsageCounterRepository` in memory, with the real one's window rules. */
class FakeCounters {
    readonly rows = new Map<string, { count: number; windowEndsAt: Date }>();

    async increment(key: string, windowEndsAt: Date, now: Date): Promise<number> {
        const row = this.rows.get(key);
        if (!row || row.windowEndsAt.getTime() <= now.getTime()) {
            this.rows.set(key, { count: 1, windowEndsAt });
            return 1;
        }
        row.count += 1;
        return row.count;
    }

    async peek(key: string, now: Date): Promise<number> {
        const row = this.rows.get(key);
        if (!row || row.windowEndsAt.getTime() <= now.getTime()) return 0;
        return row.count;
    }

    count(key: string): number {
        return this.rows.get(key)?.count ?? 0;
    }
}

const DEMO_ENV_KEYS = [
    'DEMO',
    'DEMO_AI_REQUESTS_PER_SANDBOX',
    'DEMO_AI_REQUESTS_PER_DAY',
    'DEMO_AI_REQUESTS_PER_MINUTE',
];

const START = new Date('2026-11-20T08:00:00.000Z');
const TTL_END = new Date('2026-11-21T06:00:00.000Z');

describe('DemoAiQuotaService', () => {
    const saved: Record<string, string | undefined> = {};
    let counters: FakeCounters;
    let users: Map<string, { id: string; anonymousExpiresAt?: Date | null }>;
    let findById: jest.Mock;
    let service: DemoAiQuotaService;

    beforeEach(() => {
        for (const key of DEMO_ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        process.env.DEMO = 'true';
        counters = new FakeCounters();
        users = new Map();
        for (let i = 0; i < 10; i += 1) {
            users.set(`sandbox-${i}`, { id: `sandbox-${i}`, anonymousExpiresAt: TTL_END });
        }
        users.set('operator', { id: 'operator', anonymousExpiresAt: null });
        users.set('expired', {
            id: 'expired',
            anonymousExpiresAt: new Date('2026-11-20T07:59:00.000Z'),
        });
        findById = jest.fn(async (id: string) => users.get(id) ?? null);
        service = new DemoAiQuotaService(
            counters as unknown as DemoUsageCounterRepository,
            { findById } as unknown as UserRepository,
        );
    });

    afterEach(() => {
        for (const key of DEMO_ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    /** The i-th call's clock: 4 s apart, so 15 a minute stays under the minute's 18. */
    const at = (i: number) => new Date(START.getTime() + i * 4_000);

    /** Make `n` calls for `userOf(i)`, spread so the minute limit is never what refuses them. */
    async function callN(n: number, userOf: (i: number) => string | undefined): Promise<void> {
        for (let i = 0; i < n; i += 1) {
            await service.consume(userOf(i), at(i));
        }
    }

    it('refuses the 121st call of one sandbox with DemoQuotaExceededError("sandbox")', async () => {
        await callN(120, () => 'sandbox-0');

        const refusal = await service.consume('sandbox-0', at(120)).catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(DemoQuotaExceededError);
        expect((refusal as DemoQuotaExceededError).scope).toBe('sandbox');
        expect((refusal as DemoQuotaExceededError).code).toBe('DEMO_AI_QUOTA');
        // Another sandbox still has its own 120.
        await expect(service.consume('sandbox-1', at(121))).resolves.toBeUndefined();
    });

    it('refuses the 901st call of a UTC day, across sandboxes, with DemoQuotaExceededError("day")', async () => {
        await callN(900, (i) => `sandbox-${i % 10}`);

        const refusal = await service.consume('sandbox-0', at(900)).catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(DemoQuotaExceededError);
        expect((refusal as DemoQuotaExceededError).scope).toBe('day');
        // A system call (no user) is refused too: the day is the instance's.
        await expect(service.consume(undefined, at(901))).rejects.toBeInstanceOf(
            DemoQuotaExceededError,
        );
    });

    it('opens a new day at the next UTC midnight', async () => {
        await callN(900, () => undefined);
        await expect(service.consume(undefined, at(900))).rejects.toBeInstanceOf(
            DemoQuotaExceededError,
        );

        await expect(
            service.consume(undefined, new Date('2026-11-21T00:00:00.000Z')),
        ).resolves.toBeUndefined();
    });

    it('answers the 19th call in one minute with DemoRateLimitedError until the minute ends', async () => {
        const now = new Date('2026-11-20T08:00:15.000Z');
        for (let i = 0; i < 18; i += 1) await service.consume(`sandbox-${i % 10}`, now);

        const refusal = await service.consume('sandbox-0', now).catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(DemoRateLimitedError);
        const retryAfterMs = (refusal as DemoRateLimitedError).retryAfterMs as number;
        expect(retryAfterMs).toBeGreaterThan(0);
        expect(retryAfterMs).toBeLessThanOrEqual(60_000);
        expect(retryAfterMs).toBe(45_000);
        expect((refusal as DemoRateLimitedError).code).toBe('DEMO_AI_BUSY');
    });

    it('allows calls again in the next minute', async () => {
        const now = new Date('2026-11-20T08:00:59.999Z');
        for (let i = 0; i < 18; i += 1) await service.consume(undefined, now);
        await expect(service.consume(undefined, now)).rejects.toBeInstanceOf(DemoRateLimitedError);

        await expect(
            service.consume(undefined, new Date('2026-11-20T08:01:00.000Z')),
        ).resolves.toBeUndefined();
    });

    it('a busy refusal is charged to neither the day nor the sandbox', async () => {
        const now = new Date('2026-11-20T08:00:00.000Z');
        for (let i = 0; i < 18; i += 1) await service.consume('sandbox-0', now);
        for (let i = 0; i < 5; i += 1) {
            await expect(service.consume('sandbox-0', now)).rejects.toBeInstanceOf(
                DemoRateLimitedError,
            );
        }

        expect(counters.count('ai:day:2026-11-20')).toBe(18);
        expect(counters.count('ai:sandbox:sandbox-0')).toBe(18);
    });

    it('a spent sandbox retrying 30× in one minute takes no minute slot from anyone else (R11)', async () => {
        await callN(120, () => 'sandbox-0');
        const minute = '2026-11-20T09:00';
        const inMinute = (second: number) =>
            new Date(`${minute}:${String(second).padStart(2, '0')}.000Z`);

        for (let i = 0; i < 30; i += 1) {
            const refusal = await service
                .consume('sandbox-0', inMinute(i))
                .catch((e: unknown) => e);
            expect(refusal).toBeInstanceOf(DemoQuotaExceededError);
            expect((refusal as DemoQuotaExceededError).scope).toBe('sandbox');
        }
        expect(counters.count(`ai:min:${minute}`)).toBe(0);

        // Another visitor still has the whole minute: 18 calls go through.
        for (let i = 0; i < 18; i += 1) {
            await expect(service.consume('sandbox-1', inMinute(30 + i))).resolves.toBeUndefined();
        }
        expect(counters.count(`ai:min:${minute}`)).toBe(18);
    });

    it('a used-up day refuses without counting the minute either', async () => {
        await callN(900, (i) => `sandbox-${i % 10}`);
        const minute = '2026-11-20T10:00';

        for (let i = 0; i < 30; i += 1) {
            await expect(
                service.consume(
                    undefined,
                    new Date(`${minute}:${String(i).padStart(2, '0')}.000Z`),
                ),
            ).rejects.toMatchObject({ scope: 'day' });
        }
        expect(counters.count(`ai:min:${minute}`)).toBe(0);
    });

    it('a spent sandbox does not use up the instance day with refused calls', async () => {
        await callN(120, () => 'sandbox-0');
        for (let i = 120; i < 130; i += 1) {
            await expect(service.consume('sandbox-0', at(i))).rejects.toBeInstanceOf(
                DemoQuotaExceededError,
            );
        }

        expect(counters.count('ai:day:2026-11-20')).toBe(120);
    });

    it('writes the three keys with their windows: minute end, next UTC midnight, the sandbox TTL', async () => {
        await service.consume('sandbox-3', new Date('2026-11-20T23:59:30.500Z'));

        expect(counters.rows.get('ai:min:2026-11-20T23:59')).toEqual({
            count: 1,
            windowEndsAt: new Date('2026-11-21T00:00:00.000Z'),
        });
        expect(counters.rows.get('ai:day:2026-11-20')).toEqual({
            count: 1,
            windowEndsAt: new Date('2026-11-21T00:00:00.000Z'),
        });
        expect(counters.rows.get('ai:sandbox:sandbox-3')).toEqual({
            count: 1,
            windowEndsAt: TTL_END,
        });
    });

    it('an undefined user (system work) counts the day and the minute but no sandbox', async () => {
        await callN(130, () => undefined);

        expect(counters.count('ai:day:2026-11-20')).toBe(130);
        expect([...counters.rows.keys()].some((key) => key.startsWith('ai:sandbox:'))).toBe(false);
        expect(findById).not.toHaveBeenCalled();
    });

    it('a user with no anonymousExpiresAt (an operator) gets no sandbox counter', async () => {
        await callN(130, () => 'operator');

        expect(counters.count('ai:day:2026-11-20')).toBe(130);
        expect(counters.rows.has('ai:sandbox:operator')).toBe(false);
    });

    it('fails closed for a sandbox whose TTL has passed', async () => {
        const refusal = await service.consume('expired', START).catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(DemoQuotaExceededError);
        expect((refusal as DemoQuotaExceededError).scope).toBe('sandbox');
        expect(counters.count('ai:day:2026-11-20')).toBe(0);
    });

    it('looks a user up once, not on every call', async () => {
        await callN(5, () => 'sandbox-2');

        expect(findById).toHaveBeenCalledTimes(1);
        expect(findById).toHaveBeenCalledWith('sandbox-2');
    });

    it('reads the limits from config', async () => {
        process.env.DEMO_AI_REQUESTS_PER_SANDBOX = '3';
        await callN(3, () => 'sandbox-4');

        await expect(service.consume('sandbox-4', at(3))).rejects.toMatchObject({
            scope: 'sandbox',
        });
    });

    describe('isDayExhausted', () => {
        it('flips at the 900th call of the day', async () => {
            await callN(899, () => undefined);
            await expect(service.isDayExhausted(at(899))).resolves.toBe(false);

            await service.consume(undefined, at(899));

            await expect(service.isDayExhausted(at(900))).resolves.toBe(true);
            // The next UTC day is fresh again.
            await expect(
                service.isDayExhausted(new Date('2026-11-21T00:00:00.000Z')),
            ).resolves.toBe(false);
        });

        it('defaults to the current time', async () => {
            await expect(service.isDayExhausted()).resolves.toBe(false);
        });
    });
});
