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

/**
 * `lastChange` of a row the membership resync wrote: what it did came from the
 * current membership list, not from an envelope.
 */
export const RESYNC_CHANGE = 'resync';

/**
 * The position a row the resync made first is given: before every envelope, so
 * the next envelope for that person is always applied after it.
 */
export const RESYNC_POSITION = '00000000000000000000000000';

/**
 * The outcomes after which the sync counts the person as a member it keeps in
 * step with Ever Platform (a member of the linked organization there, on the
 * roster here). Only such a person is ever removed by a resync.
 */
const KEPT_MEMBER_OUTCOMES: ReadonlySet<string> = new Set(['added', 'role_set', 'unchanged']);

/** One member of a linked organization, as the membership list names them. */
export interface CurrentMember {
    readonly issuer: string;
    readonly subject: string;
    readonly userRef: string | null;
    readonly role: string;
}

/**
 * Who the membership list of a linked organization named, gathered while it is
 * read page by page: the accounts the members resolved to, their Ever ID
 * identities and the issuers those come from.
 */
export class ListedMembers {
    readonly userIds = new Set<string>();
    readonly identities = new Set<string>();
    readonly issuers = new Set<string>();

    add(member: CurrentMember, userId: string | null): void {
        const issuer = sameIssuer(member.issuer);
        this.issuers.add(issuer);
        this.identities.add(identityKey(issuer, member.subject));
        if (userId) this.userIds.add(userId);
        if (member.userRef) this.userIds.add(member.userRef);
    }
}

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
 *
 * **Resync** ({@link applyCurrentMember}, {@link removeAbsentMembers}): after
 * the feed lost envelopes, the current membership list of each linked
 * organization is applied with the same rules (see
 * `EverConnectMembershipResyncService`).
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
     * Resync: a person the current membership list names as a member of the
     * organization the Organization is linked to, with an Ever role. The same
     * person, role and membership rules as an envelope:
     *
     * - someone the sync already keeps as a member (its last outcome for them
     *   left them on the roster) only has their role set, as `role_changed`
     *   does: if they are no longer on the roster, someone here removed them,
     *   and they are not added back;
     * - anyone else is added, as `created` does (an account is never created,
     *   never moved from another account; a free seat is needed).
     *
     * Answers the outcome (not logged: the resync logs its counts) and the
     * account the identity resolved to (`null` when none). The last change
     * kept for the person becomes the resync, at their last envelope's
     * position, so the next envelope is still applied.
     */
    async applyCurrentMember(
        organizationId: string,
        member: CurrentMember,
    ): Promise<{ outcome: MembershipSyncOutcome; userId: string | null }> {
        if (!isMembershipSyncEnabled()) return { outcome: 'switched_off', userId: null };
        const identity = await this.identityOf(member.issuer, member.subject);
        if (!identity) return { outcome: 'person_unknown', userId: null };
        const userId = identity.userId;
        if (member.userRef !== null && member.userRef !== userId) {
            return { outcome: 'person_mismatch', userId };
        }
        const role = Object.prototype.hasOwnProperty.call(EVER_ROLE_TO_ROSTER_ROLE, member.role)
            ? EVER_ROLE_TO_ROSTER_ROLE[member.role]
            : undefined;
        if (!role) return { outcome: 'role_unknown', userId };

        const synced = await this.dataSource
            .getRepository(EverConnectMembershipSync)
            .findOne({ where: { organizationId, userId } });
        const kept = synced !== null && KEPT_MEMBER_OUTCOMES.has(synced.outcome);
        const outcome = kept
            ? await this.membership.setMemberRoleForPlatform(organizationId, userId, role)
            : await this.membership.addMemberForPlatform(organizationId, userId, role);
        // Removed here by hand: the row keeps saying what the sync last did, so
        // the next resync does not add them back either.
        if (!(kept && outcome === 'not_a_member')) {
            await this.rememberResync(organizationId, userId, member.role, outcome, synced);
        }
        return { outcome, userId };
    }

    /**
     * Resync, once the whole list of a linked organization was read: the people
     * the sync keeps as members of the Organization but whom the list no longer
     * names left the organization on Ever Platform, and are removed as
     * `removed` does (the account owner never; nothing they made is deleted).
     *
     * Only a person the sync itself keeps as a member is a candidate (its last
     * outcome for them is `added`, `role_set` or `unchanged`, as an envelope or
     * a resync left it): someone the sync never saw as a member of the Ever
     * organization is never removed. And only when one of their
     * connected identities comes from an issuer the list names and none of them
     * is on the list: a person whose Ever ID is not known here is left as they
     * are. An empty list removes nobody (an organization always has its owner).
     */
    async removeAbsentMembers(
        organizationId: string,
        listed: ListedMembers,
        keep: () => Promise<boolean> = async () => true,
    ): Promise<MembershipSyncOutcome[] | 'lease_lost'> {
        if (!isMembershipSyncEnabled() || listed.issuers.size === 0) return [];
        const candidates = (
            await this.dataSource
                .getRepository(EverConnectMembershipSync)
                .find({ where: { organizationId } })
        ).filter((row) => KEPT_MEMBER_OUTCOMES.has(row.outcome) && !listed.userIds.has(row.userId));
        const outcomes: MembershipSyncOutcome[] = [];
        for (const row of candidates) {
            const identities = (
                await this.dataSource.getRepository(ExternalIdentity).find({
                    select: { id: true, issuer: true, subject: true },
                    where: { userId: row.userId },
                })
            ).filter((identity) => listed.issuers.has(sameIssuer(identity.issuer)));
            if (identities.length === 0) {
                outcomes.push('person_unknown');
                continue;
            }
            if (identities.some((i) => listed.identities.has(identityKey(i.issuer, i.subject)))) {
                continue;
            }
            // Written only while this replica holds the lease.
            if (!(await keep())) return 'lease_lost';
            const outcome = await this.membership.removeMemberForPlatform(
                organizationId,
                row.userId,
            );
            await this.rememberResync(organizationId, row.userId, row.lastRole, outcome, row);
            outcomes.push(outcome);
        }
        return outcomes;
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

    /**
     * Keep a resync as the last change for the person in the Organization. An
     * existing row keeps its envelope position (an envelope newer than the last
     * one applied is still applied); a new row is placed before every envelope.
     * Nothing is written when the row already says the same.
     */
    private async rememberResync(
        organizationId: string,
        userId: string,
        lastRole: string,
        outcome: string,
        synced: EverConnectMembershipSync | null,
    ): Promise<void> {
        const repository = this.dataSource.getRepository(EverConnectMembershipSync);
        const values = { lastChange: RESYNC_CHANGE, lastRole, outcome };
        if (synced) {
            if (synced.lastRole === lastRole && synced.outcome === outcome) return;
            await repository.update({ organizationId, userId }, values);
            return;
        }
        try {
            await repository.insert({
                organizationId,
                userId,
                lastEventId: RESYNC_POSITION,
                lastOccurredAt: null,
                ...values,
            });
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

/**
 * One item of the membership list (`GET /v1/instances/me/tenant-links/{link}/memberships`),
 * checked as an envelope's data is; `null` when it is not one.
 */
export function parseCurrentMember(item: unknown): CurrentMember | null {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const { identity_issuer, identity_subject, product_user_ref, role } = record;
    if (typeof identity_issuer !== 'string' || !isHttpsUrl(identity_issuer)) return null;
    if (typeof identity_subject !== 'string' || !EXTERNAL_ID.test(identity_subject)) return null;
    if (
        product_user_ref !== undefined &&
        product_user_ref !== null &&
        (typeof product_user_ref !== 'string' || !PRODUCT_ID.test(product_user_ref))
    ) {
        return null;
    }
    if (typeof role !== 'string') return null;
    return {
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

/** An identity as compared: the issuer (as compared) and the subject. */
function identityKey(issuer: string, subject: string): string {
    return `${sameIssuer(issuer)}#${subject}`;
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
