import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EverPlatformClient } from '@ever-co/connect-sdk';
import { EverConnectLink } from '@ever-works/agent/entities';
import {
    EverConnectExtensions,
    type EverConnectResyncListener,
    type EverConnectRoundParticipant,
} from '../ever-connect-extensions';
import { EVER_CONNECT_LEASE_HELD, type EverConnectRoundLease } from '../ever-connect-lease.service';
import { EverConnectService } from '../ever-connect.service';
import { isMembershipSyncEnabled } from '../ever-connect.switches';
import { describeFailure, platformFailure } from '../identity/platform-answer';
import { readLinkMembershipsPage } from './link-memberships.client';
import {
    EverConnectMembershipSyncService,
    ListedMembers,
    parseCurrentMember,
} from './membership-sync.service';

/** At most this many pages of one link's list are read (100 members each). */
export const MEMBERSHIP_RESYNC_MAX_PAGES = 1_000;

/** What one resync did, a machine code. */
export type MembershipResyncOutcome =
    | 'switched_off'
    | 'not_connected'
    | 'done'
    | 'module_disabled'
    | 'failed'
    | 'lease_lost';

/** What reading the list of one link did. */
type LinkOutcome = 'read' | 'link_unknown' | 'module_disabled' | 'failed' | 'lease_lost';

/**
 * The membership resync (with `EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED`): the
 * membership envelopes the feed lost are made up for by reading the current
 * members of each linked organization
 * (`GET /v1/instances/me/tenant-links/{link}/memberships`, 100 a page) and
 * applying them with the rules of the envelopes
 * ({@link EverConnectMembershipSyncService.applyCurrentMember}, then
 * {@link EverConnectMembershipSyncService.removeAbsentMembers} once a link's
 * whole list was read).
 *
 * - **When:** after the feed answered `410 resync_required`, before its
 *   position moves on (a replica that stops or loses the lease on the way
 *   leaves the old position, so the next one is answered `410` again and runs
 *   it); and once after each start, in the next round of the worker. Both on
 *   the replica holding the Ever Connect lease, once the installation is
 *   `active`.
 * - **`404 module_disabled`:** Ever Platform sends no membership events, so
 *   there is nothing to make up for; logged once.
 * - **A link Ever Platform does not know as active** (`404`): skipped.
 * - **Any other failure** (an answer, a page that is not one, the database):
 *   the resync stops with a warning, nobody is removed for the link being read,
 *   and it runs again at the next `410` or start. The lease is checked before
 *   each page and each change; when it is lost the resync stops there, writes
 *   nothing more and stays owed. A cursor answered before (a cycle) stops it.
 *
 * Logged by counts of outcome codes only, never with an identity or a name.
 */
@Injectable()
export class EverConnectMembershipResyncService
    implements OnModuleInit, EverConnectRoundParticipant, EverConnectResyncListener
{
    readonly name = 'membership resync';
    private readonly logger = new Logger(EverConnectMembershipResyncService.name);
    private owed = true;
    private disabledLogged = false;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly connection: EverConnectService,
        private readonly sync: EverConnectMembershipSyncService,
        @Optional() private readonly extensions?: EverConnectExtensions,
    ) {}

    onModuleInit(): void {
        if (!isMembershipSyncEnabled()) return;
        this.extensions?.addResyncListener(this);
        this.extensions?.addRoundParticipant(this);
    }

    /**
     * The feed answered `410 resync_required`: read every list now, before the
     * feed's position moves on. `false` only when the lease was lost on the way.
     */
    async resyncAfterFeedGap(
        lease: EverConnectRoundLease = EVER_CONNECT_LEASE_HELD,
    ): Promise<boolean> {
        return (await this.resync(lease)) !== 'lease_lost';
    }

    /** Whether a resync is owed. */
    isOwed(): boolean {
        return this.owed;
    }

    /** Run the resync when one is owed. */
    async round(
        _now: Date = new Date(),
        lease: EverConnectRoundLease = EVER_CONNECT_LEASE_HELD,
    ): Promise<void> {
        if (this.owed) await this.resync(lease);
    }

    /** Read the members of every active link and apply them. */
    async resync(
        lease: EverConnectRoundLease = EVER_CONNECT_LEASE_HELD,
    ): Promise<MembershipResyncOutcome> {
        if (!isMembershipSyncEnabled()) return 'switched_off';
        if ((await this.connection.connection()).status !== 'active') return 'not_connected';
        const client = await this.connection.client();
        if (!client) return 'not_connected';
        // Cleared before the first read; set again when the lease is lost.
        this.owed = false;

        const counts = new Map<string, number>();
        const count = (code: string) => counts.set(code, (counts.get(code) ?? 0) + 1);
        try {
            const links = await this.dataSource.getRepository(EverConnectLink).find({
                select: { id: true, organizationId: true, platformLinkId: true },
                where: { status: 'active' },
            });
            for (const { organizationId, platformLinkId } of links) {
                // A link Ever Platform has not confirmed yet has no list there.
                if (!platformLinkId) continue;
                const outcome = await this.resyncLink(
                    client,
                    { organizationId, platformLinkId },
                    lease,
                    count,
                );
                if (outcome === 'link_unknown') {
                    count('link_unknown');
                    continue;
                }
                if (outcome === 'read') continue;
                if (outcome === 'module_disabled') {
                    if (!this.disabledLogged) {
                        this.disabledLogged = true;
                        this.logger.log(
                            'Ever Platform sends no membership events (module_disabled): nothing to resync',
                        );
                    }
                    return 'module_disabled';
                }
                if (outcome === 'lease_lost') this.owed = true;
                this.logger.warn(
                    `The membership resync stopped (${outcome}): ${summary(counts)}; it runs again at the next resync or start`,
                );
                return outcome;
            }
        } catch (error) {
            this.logger.warn(
                `The membership resync stopped (${error instanceof Error ? error.name : 'unknown'}): ${summary(counts)}; it runs again at the next resync or start`,
            );
            return 'failed';
        }
        // Read again: a later `module_disabled` (the role feed switched off again)
        // is said again.
        this.disabledLogged = false;
        this.logger.log(`ever_connect.membership.resync ${summary(counts)}`);
        return 'done';
    }

    /** Read the whole list of one link, applying each page; then remove who left. */
    private async resyncLink(
        client: EverPlatformClient,
        link: { readonly organizationId: string; readonly platformLinkId: string },
        lease: EverConnectRoundLease,
        count: (code: string) => void,
    ): Promise<LinkOutcome> {
        const listed = new ListedMembers();
        let complete = true;
        let cursor: string | null = null;
        const cursors = new Set<string>();
        for (let page = 0; ; page += 1) {
            if (page >= MEMBERSHIP_RESYNC_MAX_PAGES) return 'failed';
            if (!(await lease.keep())) return 'lease_lost';
            let answer: Awaited<ReturnType<typeof readLinkMembershipsPage>>;
            try {
                answer = await readLinkMembershipsPage(client, link.platformLinkId, cursor);
            } catch (error) {
                const failure = platformFailure(error);
                if (failure.kind === 'problem' && failure.status === 404) {
                    return failure.code === 'module_disabled' ? 'module_disabled' : 'link_unknown';
                }
                this.logger.warn(`A membership list was not read: ${describeFailure(failure)}`);
                return 'failed';
            }
            for (const item of answer.items) {
                const member = parseCurrentMember(item);
                if (!member) {
                    // Someone the list names but this cannot read: nobody is
                    // removed for this link, so they are not removed by mistake.
                    complete = false;
                    count('malformed');
                    continue;
                }
                // Written only while this replica holds the lease: another one
                // may apply newer changes meanwhile.
                if (!(await lease.keep())) return 'lease_lost';
                const { outcome, userId } = await this.sync.applyCurrentMember(
                    link.organizationId,
                    member,
                );
                listed.add(member, userId);
                count(outcome);
            }
            if (answer.nextCursor === null) break;
            // A cursor answered before (a cycle): the list would never end.
            if (cursors.has(answer.nextCursor)) return 'failed';
            cursors.add(answer.nextCursor);
            cursor = answer.nextCursor;
        }
        if (complete) {
            const outcomes = await this.sync.removeAbsentMembers(link.organizationId, listed, () =>
                lease.keep(),
            );
            if (outcomes === 'lease_lost') return 'lease_lost';
            for (const outcome of outcomes) count(`absent_${outcome}`);
        }
        return 'read';
    }
}

/** `code=count` pairs, by code. */
function summary(counts: ReadonlyMap<string, number>): string {
    if (counts.size === 0) return 'nothing applied';
    return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, n]) => `${code}=${n}`)
        .join(' ');
}
