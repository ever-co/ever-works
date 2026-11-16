import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    EverConnectLink,
    EverConnectMembershipSync,
    ExternalIdentity,
    type OrganizationRosterRole,
} from '@ever-works/agent/entities';
import { isUniqueConstraintError } from '@ever-works/agent/utils';
import {
    OrganizationInvitationFlowService,
    type PlatformMembershipOutcome,
} from '../../organizations/organization-invitation-flow.service';
import {
    EverConnectExtensions,
    type EverConnectFeedEvent,
    type EverConnectFeedHandler,
} from '../ever-connect-extensions';
import { isMembershipSyncEnabled } from '../ever-connect.switches';

/** The membership changes Ever Platform sends, and what each one is. */
export const MEMBERSHIP_TOPICS: Readonly<Record<string, MembershipChange>> = {
    'ever.registry.membership.created': 'created',
    'ever.registry.membership.role_changed': 'role_changed',
    'ever.registry.membership.removed': 'removed',
};

export type MembershipChange = 'created' | 'role_changed' | 'removed';

/**
 * Ever roles, as roles on an Organization's roster here. The owner role here
 * is the account (Tenant) owner's alone and is never granted from Ever
 * Platform: an Ever `owner` is an administrator here. Any other role changes
 * nothing.
 */
export const EVER_ROLE_TO_ROSTER_ROLE: Readonly<Record<string, OrganizationRosterRole>> = {
    owner: 'admin',
    admin: 'admin',
    member: 'member',
};

/** What one envelope did, a machine code (also logged, never with an id or a name). */
export type MembershipSyncOutcome =
    | PlatformMembershipOutcome
    | 'switched_off'
    | 'not_a_membership_event'
    | 'malformed'
    | 'role_unknown'
    | 'link_unknown'
    | 'person_unknown'
    | 'person_mismatch'
    | 'duplicate'
    | 'stale';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const PRODUCT_ID = /^[A-Za-z0-9._:*-]{1,64}$/;

interface MembershipData {
    linkId: string;
    issuer: string;
    subject: string;
    userRef: string | null;
    role: string;
}

/**
 * Applies the membership changes Ever Platform sends on the installation's feed
 * (`ever.registry.membership.created|role_changed|removed`, the shape an
 * installation receives: the tenant link, the person's Ever ID identity, their
 * local account when a person link exists, and the Ever role) to the
 * Organization that link is for. Behind `EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED`:
 * off, it is not registered and the feed reads past these events.
 *
 * - **The person** is the one account whose connected identity has that subject
 *   and issuer (a trailing slash of the issuer aside); when the envelope names a
 *   local account too, it must be that one. No account here, or two: nothing
 *   changes (no account is ever created).
 * - **The Organization** is the one of an active link with that id; none:
 *   nothing changes.
 * - **The role** maps through {@link EVER_ROLE_TO_ROSTER_ROLE}; an unknown one
 *   changes nothing.
 * - **The change** is made by the Organization's own membership code
 *   (`OrganizationInvitationFlowService`): added (`created`), the roster role
 *   set (`role_changed`, members only), or removed (`removed`). The account
 *   (Tenant) owner is never changed or removed, so an Organization never loses
 *   its owner; an account homed in another account is never moved.
 * - **Order and repeats.** The last change applied for the person in that
 *   Organization is kept (`ever_connect_membership_sync`): the same envelope
 *   again does nothing, and an envelope older than it (by `occurred_at`, then by
 *   its id, a ULID) is skipped.
 *
 * Each outcome is logged by its code only. A failure of the database throws, so
 * the feed reads the envelope again.
 */
@Injectable()
export class EverConnectMembershipSyncService implements OnModuleInit, EverConnectFeedHandler {
    readonly name = 'membership';
    private readonly logger = new Logger(EverConnectMembershipSyncService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly membership: OrganizationInvitationFlowService,
        @Optional() private readonly extensions?: EverConnectExtensions,
    ) {}

    onModuleInit(): void {
        if (isMembershipSyncEnabled()) this.extensions?.addFeedHandler(this);
    }

    handles(type: string): boolean {
        return Object.prototype.hasOwnProperty.call(MEMBERSHIP_TOPICS, type);
    }

    async handle(event: EverConnectFeedEvent): Promise<void> {
        await this.apply(event);
    }

    /** Apply one envelope; answers what it did. */
    async apply(event: EverConnectFeedEvent): Promise<MembershipSyncOutcome> {
        if (!isMembershipSyncEnabled()) return 'switched_off';
        const change = this.handles(event.type) ? MEMBERSHIP_TOPICS[event.type] : undefined;
        if (!change) return 'not_a_membership_event';
        const data = parseMembership(event.data);
        if (!data || typeof event.id !== 'string' || !ULID.test(event.id)) {
            return this.done('malformed');
        }
        const role = Object.prototype.hasOwnProperty.call(EVER_ROLE_TO_ROSTER_ROLE, data.role)
            ? EVER_ROLE_TO_ROSTER_ROLE[data.role]
            : undefined;
        if (!role) return this.done('role_unknown');

        const link = await this.dataSource
            .getRepository(EverConnectLink)
            .findOne({ where: { platformLinkId: data.linkId, status: 'active' } });
        if (!link) return this.done('link_unknown');
        const identity = await this.identityOf(data.issuer, data.subject);
        if (!identity) return this.done('person_unknown');
        if (data.userRef !== null && data.userRef !== identity.userId) {
            return this.done('person_mismatch');
        }

        const position = { id: event.id.toUpperCase(), at: occurredAt(event) };
        const synced = await this.dataSource.getRepository(EverConnectMembershipSync).findOne({
            where: { organizationId: link.organizationId, userId: identity.userId },
        });
        if (synced && synced.lastEventId.toUpperCase() === position.id) {
            return this.done('duplicate');
        }
        if (synced && !isAfter(position, synced)) return this.done('stale');

        let outcome: PlatformMembershipOutcome;
        switch (change) {
            case 'created':
                outcome = await this.membership.addMemberForPlatform(
                    link.organizationId,
                    identity.userId,
                    role,
                );
                break;
            case 'role_changed':
                outcome = await this.membership.setMemberRoleForPlatform(
                    link.organizationId,
                    identity.userId,
                    role,
                );
                break;
            default:
                outcome = await this.membership.removeMemberForPlatform(
                    link.organizationId,
                    identity.userId,
                );
        }

        await this.remember(link.organizationId, identity.userId, {
            lastEventId: position.id,
            lastOccurredAt: position.at,
            lastChange: change,
            lastRole: data.role,
            outcome,
        });
        return this.done(outcome);
    }

    /**
     * The connected identity with this subject and issuer (an issuer spelled with
     * or without a trailing slash is the same issuer). `null` when there is none,
     * or when two accounts would match.
     */
    private async identityOf(
        issuer: string,
        subject: string,
    ): Promise<Pick<ExternalIdentity, 'userId'> | null> {
        const wanted = sameIssuer(issuer);
        const candidates = (
            await this.dataSource.getRepository(ExternalIdentity).find({
                select: { id: true, userId: true, issuer: true },
                where: { subject },
            })
        ).filter((identity) => sameIssuer(identity.issuer) === wanted);
        const userIds = new Set(candidates.map((identity) => identity.userId));
        return userIds.size === 1 ? { userId: [...userIds][0] } : null;
    }

    /** Keep the envelope as the last one applied for the person in the Organization. */
    private async remember(
        organizationId: string,
        userId: string,
        values: Pick<
            EverConnectMembershipSync,
            'lastEventId' | 'lastOccurredAt' | 'lastChange' | 'lastRole' | 'outcome'
        >,
    ): Promise<void> {
        const repository = this.dataSource.getRepository(EverConnectMembershipSync);
        const updated = await repository.update({ organizationId, userId }, values);
        if ((updated.affected ?? 0) > 0) return;
        try {
            await repository.insert({ organizationId, userId, ...values });
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            await repository.update({ organizationId, userId }, values);
        }
    }

    private done<T extends MembershipSyncOutcome>(outcome: T): T {
        this.logger.log(`ever_connect.membership.${outcome}`);
        return outcome;
    }
}

function parseMembership(data: unknown): MembershipData | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const { tenant_link_id, identity_issuer, identity_subject, product_user_ref, role } = record;
    if (typeof tenant_link_id !== 'string' || !ULID.test(tenant_link_id)) return null;
    if (typeof identity_issuer !== 'string' || !isHttpsUrl(identity_issuer)) return null;
    if (typeof identity_subject !== 'string' || !EXTERNAL_ID.test(identity_subject)) return null;
    if (
        product_user_ref !== undefined &&
        (typeof product_user_ref !== 'string' || !PRODUCT_ID.test(product_user_ref))
    ) {
        return null;
    }
    if (typeof role !== 'string') return null;
    return {
        linkId: tenant_link_id,
        issuer: identity_issuer,
        subject: identity_subject,
        userRef: typeof product_user_ref === 'string' ? product_user_ref : null,
        role,
    };
}

/** An issuer as compared: without trailing slashes. */
function sameIssuer(issuer: string): string {
    return issuer.replace(/\/+$/, '');
}

function isHttpsUrl(value: string): boolean {
    if (value.length > 2048) return false;
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

/** The envelope's own time (`occurred_at`), when it carries a valid one. */
function occurredAt(event: EverConnectFeedEvent): Date | null {
    const value = (event as EverConnectFeedEvent & { occurred_at?: unknown }).occurred_at;
    if (typeof value !== 'string') return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
}

/** Whether the envelope comes after the last one applied: by its time, then by its id. */
function isAfter(
    next: { id: string; at: Date | null },
    last: Pick<EverConnectMembershipSync, 'lastEventId' | 'lastOccurredAt'>,
): boolean {
    const lastAt = last.lastOccurredAt ? new Date(last.lastOccurredAt).getTime() : NaN;
    if (next.at && Number.isFinite(lastAt) && next.at.getTime() !== lastAt) {
        return next.at.getTime() > lastAt;
    }
    return next.id > last.lastEventId.toUpperCase();
}
