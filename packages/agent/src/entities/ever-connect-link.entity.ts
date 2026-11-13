import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * How a link was made: the company was created from Ever Platform
 * (`provisioning`), or an organization admin pasted a link code minted in
 * app.ever.co (`link_code`).
 */
export type EverConnectLinkOrigin = 'provisioning' | 'link_code';

/** A link stays `active` until it is ended; an ended one is `archived`. */
export type EverConnectLinkStatus = 'active' | 'archived';

/**
 * A Works Organization linked to an Ever organization. `platformLinkId` is
 * Ever Platform's id of the link, known once it answered the report. One active
 * link per tenant and per Ever organization, one per Organization.
 *
 * `productOrgRef` is what Ever Platform was given as this Organization's id when
 * the link was made (its slug at that time). Reports that name the Organization
 * repeat it unchanged, also after the slug changed; a row written before the
 * column existed has none and the Organization's slug is used.
 */
@Entity({ name: 'ever_connect_links' })
@Index('uq_ever_connect_links_organization', ['organizationId'], { unique: true })
@Index('uq_ever_connect_links_tenant_active', ['tenantId'], {
    unique: true,
    where: `"status" = 'active'`,
})
@Index('uq_ever_connect_links_ever_org_active', ['everOrgId'], {
    unique: true,
    where: `"status" = 'active'`,
})
export class EverConnectLink {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    organizationId: string;

    @Column({ type: 'uuid' })
    tenantId: string;

    @Column({ type: 'varchar', length: 64 })
    everOrgId: string;

    /** The Ever handle, a display copy (the Organization's slug may differ). */
    @Column({ type: 'varchar', length: 64 })
    handle: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    platformLinkId: string | null;

    /** The Organization's id as Ever Platform holds it for this link. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    productOrgRef: string | null;

    @Column({ type: 'varchar', length: 16 })
    createdVia: EverConnectLinkOrigin;

    @Column({ type: 'varchar', length: 16, default: 'active' })
    status: EverConnectLinkStatus;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
