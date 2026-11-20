import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DemoUsageCounter } from '../../entities/demo-usage-counter.entity';

/**
 * Fixed-window counters for demo-mode AI quotas.
 *
 * `increment` is one `INSERT ... ON CONFLICT (key) DO UPDATE ... RETURNING` statement on both drivers, with the
 * window reset expressed in SQL, so it is atomic per key. On SQLite that is also what keeps it safe from
 * concurrent callers: TypeORM shares one connection there, so an explicit transaction per call would collide
 * ("cannot start a transaction within a transaction") while a single statement cannot.
 */
@Injectable()
export class DemoUsageCounterRepository {
    constructor(
        @InjectRepository(DemoUsageCounter)
        private readonly repository: Repository<DemoUsageCounter>,
    ) {}

    /** Adds one to the counter and returns the new count; an ended window (`windowEndsAt <= now`) restarts at 1. */
    async increment(key: string, windowEndsAt: Date, now: Date): Promise<number> {
        const postgres = this.repository.manager.connection.options.type === 'postgres';
        // SQLite stores a `Date` column as 'YYYY-MM-DD HH:mm:ss.SSS' (UTC); the lexical compare matches the time order.
        const bind = (d: Date) =>
            postgres ? d : d.toISOString().replace('T', ' ').replace('Z', '');
        const [p1, p2, p3] = postgres ? ['$1', '$2', '$3'] : ['?', '?', '?'];
        const rows: Array<{ count: number | string }> = await this.repository.query(
            `INSERT INTO "demo_usage_counters" ("key", "count", "windowEndsAt", "updatedAt")
             VALUES (${p1}, 1, ${p2}, ${p3})
             ON CONFLICT ("key") DO UPDATE SET
                 "count" = CASE WHEN "demo_usage_counters"."windowEndsAt" <= ${p3} THEN 1
                                ELSE "demo_usage_counters"."count" + 1 END,
                 "windowEndsAt" = CASE WHEN "demo_usage_counters"."windowEndsAt" <= ${p3} THEN ${p2}
                                       ELSE "demo_usage_counters"."windowEndsAt" END,
                 "updatedAt" = ${p3}
             RETURNING "count"`,
            postgres
                ? [key, windowEndsAt, now]
                : [
                      key,
                      bind(windowEndsAt),
                      bind(now),
                      bind(now),
                      bind(now),
                      bind(windowEndsAt),
                      bind(now),
                  ],
        );
        return Number(rows[0].count);
    }

    /** Current count for the key; 0 for a missing key or an ended window. */
    async peek(key: string, now: Date): Promise<number> {
        const row = await this.repository.findOne({ where: { key } });
        if (!row || row.windowEndsAt.getTime() <= now.getTime()) return 0;
        return row.count;
    }
}
