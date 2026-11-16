import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';
import type { ClassToObject } from './types';
import { PortableDateColumn } from './_types';

/**
 * The last membership change Ever Platform sent for one person in one linked
 * Organization, and what it did here (Ever Connect membership sync, behind
 * `EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED`).
 *
 * One row per (Organization, account): it is what makes the changes ordered
 * and idempotent. A change delivered again (the same envelope id) does
 * nothing, and a change older than the one applied (by `occurred_at`, then the
 * envelope id, a ULID) is skipped.
 *
 * Local ids and machine codes only: never an Ever ID subject, an e-mail address
 * or a name. The row goes with the account or the Organization.
 */
@Entity({ name: 'ever_connect_membership_sync' })
@Index('uq_ever_connect_membership_sync_org_user', ['organizationId', 'userId'], { unique: true })
export class EverConnectMembershipSync {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    organizationId: string;

    @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'organizationId' })
    organization?: ClassToObject<Organization>;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: ClassToObject<User>;

    /** The id of the last envelope taken into account (a ULID). */
    @Column({ type: 'varchar', length: 64 })
    lastEventId: string;

    /** Its `occurred_at`, when it had one. */
    @PortableDateColumn({ nullable: true })
    lastOccurredAt: Date | null;

    /** `created`, `role_changed` or `removed`. */
    @Column({ type: 'varchar', length: 16 })
    lastChange: string;

    /** The Ever role the envelope named (`owner`, `admin` or `member`). */
    @Column({ type: 'varchar', length: 16 })
    lastRole: string;

    /** What it did here, a machine code (`added`, `role_set`, `removed`, `unchanged`, …). */
    @Column({ type: 'varchar', length: 48 })
    outcome: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
