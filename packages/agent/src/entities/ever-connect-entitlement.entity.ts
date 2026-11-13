import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** The subject of the row that keeps Ever Platform's key set. */
export const EVER_CONNECT_KEY_SET_SUBJECT = 'key-set';

/** The subject of the installation's own entitlement document. */
export const EVER_CONNECT_INSTANCE_ENTITLEMENT_SUBJECT = 'instance';

/**
 * What this installation keeps of Ever Platform's signed documents, one row per
 * subject:
 *
 * - `instance`: the installation's entitlement document;
 * - `link:<tenant link id>`: the entitlement document of one linked
 *   Organization;
 * - `key-set`: the key set the documents are verified with (public keys only).
 *
 * `document` holds the bytes exactly as received (wrapped like a plugin secret
 * when the installation has an encryption key), stored only after the Ever
 * Platform SDK verified them. `seq` and `issuedAt` are kept in clear so an
 * older document is refused even when the stored one cannot be read. Nothing
 * here is a credential.
 */
@Entity({ name: 'ever_connect_entitlements' })
export class EverConnectEntitlement {
    @PrimaryColumn({ type: 'varchar', length: 64 })
    subject: string;

    @Column({ type: 'text', nullable: true })
    document: string | null;

    /** The document's sequence number (`ever.seq`). */
    @Column({ type: 'bigint', nullable: true })
    seq: string | null;

    /** The document's `iat`, in Unix seconds. */
    @Column({ type: 'bigint', nullable: true })
    issuedAt: string | null;

    /** The document's `exp`, in Unix seconds. */
    @Column({ type: 'bigint', nullable: true })
    expiresAt: string | null;

    /** When the document was last read from Ever Platform (also a `304`). */
    @PortableDateColumn({ nullable: true })
    fetchedAt: Date | null;

    /** The machine code of the last refused or failed read. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    lastError: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
