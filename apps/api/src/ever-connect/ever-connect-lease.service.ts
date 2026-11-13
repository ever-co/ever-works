import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import type { Repository } from 'typeorm';
import { EVER_CONNECT_LEASE_ROW_ID, EverConnectLease } from '@ever-works/agent/entities';

/** How long a held lease lasts without renewal. */
export const EVER_CONNECT_LEASE_TTL_MS = 2 * 60 * 1000;
/**
 * A round renews its lease between two of its steps once this long has passed
 * since the last renewal: a quarter of the lease, so a step may take a minute
 * and a half before the lease runs out under it.
 */
export const EVER_CONNECT_LEASE_RENEW_MS = 30_000;

/**
 * The lease as one round of the worker holds it. A round is made of steps (a
 * feed page, a batch, a read); between two steps it calls {@link keep}.
 */
export interface EverConnectRoundLease {
    /**
     * Renew the lease when a renewal is due, and say whether this replica still
     * holds it. `false`: another replica may run the worker now, so the caller
     * stops where it is and leaves the rest (nothing it has not sent yet is
     * lost: it stays owed for the replica that holds the lease).
     */
    keep(): Promise<boolean>;
    /** What the last {@link keep} answered (`true` until one fails). No request. */
    readonly held: boolean;
}

/** A lease that is always held: for a part run on its own, outside the worker's round. */
export const EVER_CONNECT_LEASE_HELD: EverConnectRoundLease = {
    keep: async () => true,
    held: true,
};

/**
 * The lease that makes one replica run the Ever Connect worker (the feed and
 * the outbox): a compare-and-set on one row, taken at the start of every round
 * and renewed between the steps of a long one ({@link roundLease}).
 */
@Injectable()
export class EverConnectLeaseService {
    readonly holderId = `${process.pid}:${randomBytes(6).toString('hex')}`;

    constructor(
        @InjectRepository(EverConnectLease) private readonly leases: Repository<EverConnectLease>,
    ) {}

    /** Take the lease, or renew it when this replica holds it. */
    async hold(now = new Date()): Promise<boolean> {
        await this.leases
            .createQueryBuilder()
            .insert()
            .into(EverConnectLease)
            .values({ id: EVER_CONNECT_LEASE_ROW_ID, holder: null, expiresAt: null })
            .orIgnore()
            .execute();
        const result = await this.leases
            .createQueryBuilder()
            .update(EverConnectLease)
            .set({
                holder: this.holderId,
                expiresAt: new Date(now.getTime() + EVER_CONNECT_LEASE_TTL_MS),
            })
            .where(`${this.column('id')} = :id`, { id: EVER_CONNECT_LEASE_ROW_ID })
            .andWhere(
                `(${this.column('holder')} IS NULL OR ${this.column('holder')} = :holder OR ${this.column(
                    'expiresAt',
                )} IS NULL OR ${this.column('expiresAt')} < :now)`,
                { holder: this.holderId, now },
            )
            .execute();
        return (result.affected ?? 0) === 1;
    }

    /**
     * The lease for the round that has just taken it with {@link hold}. Its
     * `keep()` renews at most every {@link EVER_CONNECT_LEASE_RENEW_MS}, so a
     * short round costs no extra statement. A renewal that fails (another
     * replica holds the lease, or the database did not answer) ends it for the
     * round: every later `keep()` answers `false` without asking again.
     */
    roundLease(clock: () => number = Date.now): EverConnectRoundLease {
        let renewedAt = clock();
        let held = true;
        return {
            keep: async () => {
                if (!held) return false;
                const at = clock();
                if (at - renewedAt < EVER_CONNECT_LEASE_RENEW_MS) return true;
                held = await this.hold(new Date(at)).catch(() => false);
                if (held) renewedAt = at;
                return held;
            },
            get held() {
                return held;
            },
        };
    }

    /** Release the lease if this replica holds it. */
    async release(): Promise<void> {
        await this.leases
            .createQueryBuilder()
            .update(EverConnectLease)
            .set({ holder: null, expiresAt: null })
            .where(`${this.column('id')} = :id`, { id: EVER_CONNECT_LEASE_ROW_ID })
            .andWhere(`${this.column('holder')} = :holder`, { holder: this.holderId })
            .execute();
    }

    /** A column name quoted for the running driver (camelCase columns need quotes on Postgres). */
    private column(name: string): string {
        return this.leases.manager.connection.driver.escape(name);
    }
}
