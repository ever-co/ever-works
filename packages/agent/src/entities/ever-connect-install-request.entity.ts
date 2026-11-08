import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Where an install request stands on this installation.
 *
 * - `requested`: received; a platform admin has not answered yet.
 * - `installing`: approved; the plugin installer runs.
 * - `installed`: installed and registered.
 * - `failed`: the install did not complete (`detail` says why).
 * - `declined`: a platform admin declined it.
 * - `withdrawn`: apps.ever.co withdrew it before it was answered.
 * - `removed`: the plugin installed from it was uninstalled here.
 */
export type EverConnectInstallRequestState =
    | 'requested'
    | 'installing'
    | 'installed'
    | 'failed'
    | 'declined'
    | 'withdrawn'
    | 'removed';

/** What is reported to Ever Platform (`POST /v1/installs/{install}/status`). */
export type EverConnectInstallReportState = 'installing' | 'installed' | 'failed' | 'removed';

/**
 * A plugin install requested from apps.ever.co for this installation, one row
 * per Ever Platform install id. The request installs nothing by itself: a
 * platform admin approves it, and the approval runs the plugin installer.
 *
 * Identifiers and package coordinates only, as the request declared them: the
 * listing's slug, the package, the version (exact or a range), the integrity
 * and the edition. Never a tenant, a person, an organization name, a URL or
 * free text; a failure is a fixed token (`detail`).
 *
 * The report owed to Ever Platform is `reportState`; `reportedState` is the
 * last one Ever Platform recorded. A report is retried until the two agree, or
 * dropped (`reportState` cleared) when Ever Platform refuses it for good.
 */
@Entity({ name: 'ever_connect_install_requests' })
@Index('idx_ever_connect_install_requests_state', ['state'])
@Index('idx_ever_connect_install_requests_report', ['reportState', 'nextReportAt'])
export class EverConnectInstallRequest {
    /** Ever Platform's install id (a ULID). */
    @PrimaryColumn({ type: 'varchar', length: 26 })
    installId: string;

    /** The listing on apps.ever.co (its slug). */
    @Column({ type: 'varchar', length: 64 })
    listingSlug: string;

    /** `registry` (a package of a registry) or `repo` (a repository at a commit). */
    @Column({ type: 'varchar', length: 16 })
    sourceKind: 'registry' | 'repo';

    /** `npm`, `oci` or `cargo` for a registry package. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    registry: string | null;

    @Column({ type: 'varchar', length: 214, nullable: true })
    packageName: string | null;

    @Column({ type: 'varchar', length: 201, nullable: true })
    sourceRepo: string | null;

    @Column({ type: 'varchar', length: 40, nullable: true })
    sourceSha: string | null;

    /** The exact version, or the semver range, the request declared; NULL: none. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    version: string | null;

    @Column({ type: 'boolean', default: false })
    versionIsExact: boolean;

    /** The integrity the request declared (`sha512-…`), when it declared one. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    integrity: string | null;

    @Column({ type: 'varchar', length: 41, nullable: true })
    editionKey: string | null;

    /** The Ever organization that asked (its id), when the request named it. */
    @Column({ type: 'varchar', length: 26, nullable: true })
    everOrgId: string | null;

    /** The tenant link the reports go under (`Ever-Link-Id`). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    linkId: string | null;

    @Column({ type: 'varchar', length: 16, default: 'requested' })
    state: EverConnectInstallRequestState;

    /** Why it failed: `checksum_mismatch`, `incompatible_version`, `installer_disabled`, `permission_denied` or `unknown`. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    detail: string | null;

    /** The plugin installed from it (the plugin id). */
    @Column({ type: 'varchar', length: 128, nullable: true })
    pluginId: string | null;

    /** The version installed. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    installedVersion: string | null;

    /** The platform admin who approved or declined it. */
    @Column({ type: 'uuid', nullable: true })
    decidedByUserId: string | null;

    @PortableDateColumn({ nullable: true })
    decidedAt: Date | null;

    /** Whether the approving admin added the package to the plugin allow-list. */
    @Column({ type: 'boolean', default: false })
    allowlistAdded: boolean;

    /** When apps.ever.co asked for the removal of the plugin installed from it. */
    @PortableDateColumn({ nullable: true })
    removalRequestedAt: Date | null;

    /** The report owed to Ever Platform; NULL: nothing is owed. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    reportState: EverConnectInstallReportState | null;

    /** The last report Ever Platform recorded. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    reportedState: EverConnectInstallReportState | null;

    @Column({ type: 'int', default: 0 })
    reportAttempts: number;

    /** When the owed report is tried again. */
    @PortableDateColumn({ nullable: true })
    nextReportAt: Date | null;

    /** When the request reached this installation. */
    @PortableDateColumn()
    receivedAt: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
