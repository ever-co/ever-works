import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Demo mode (`DEMO=true`) — one fixed-window counter per key, backing the DB-held AI request quotas
 * (per sandbox, per day, per minute). A key names its window (e.g. `sandbox:<userId>`, `day:2026-11-19`);
 * when `windowEndsAt` has passed the next increment resets the count to 1 with a new window.
 * See `DemoUsageCounterRepository.increment`.
 */
@Entity({ name: 'demo_usage_counters' })
export class DemoUsageCounter {
    @PrimaryColumn({ type: 'varchar', length: 160 })
    key: string;

    @Column({ type: 'int', default: 0 })
    count: number;

    @PortableDateColumn()
    windowEndsAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
