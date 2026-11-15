import { Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EverConnectLink, Tenant, User } from '@ever-works/agent/entities';
import { AccountDeletionService } from '../../account-deletion/account-deletion.service';
import { EverConnectExtensions } from '../ever-connect-extensions';
import { isPersonDeletionEnabled } from '../ever-connect.switches';
import type {
    PersonDataParticipant,
    PersonDataRequest,
    PersonDeletionOutcome,
} from '../identity/person-data-participant.port';

/**
 * Why an account is not deleted for Ever Platform: it is kept until it is
 * deleted here (Settings → Danger Zone), and the request is answered `failed`
 * with `account_deletion_pending`. Logged by code only.
 */
export type PersonDeletionHold =
    /** The workspace would go with the account while other people are in it. */
    | 'workspace_shared'
    /** The workspace that would go holds an Organization linked to Ever Platform. */
    | 'organization_linked'
    /** The account administers this installation. */
    | 'platform_admin';

/**
 * Ever Works' part in people's deletion requests from Ever Platform
 * (`EVER_CONNECT_PERSON_DELETION_ENABLED`), registered with the request handler
 * through {@link EverConnectExtensions} only while the switch is on.
 *
 * The accounts are the ones the request handler matched by the person's
 * identity hashes, nothing else. Each is deleted by the one account deletion
 * there is ({@link AccountDeletionService.execute}, the routine behind Settings
 * → Danger Zone and the e-mail link), so what goes and what stays is the same:
 *
 * - a workspace the account owns with other people in it is handed to the
 *   longest-standing admin (else member), with what the account created there;
 * - in somebody else's workspace, the account's membership goes and what it
 *   created there is handed to the workspace owner;
 * - a workspace only the account is in goes with it.
 *
 * Before anything is deleted, every account is checked ({@link holdFor}); if
 * one of them must be kept, none is deleted and the answer is `pending`
 * (`failed` / `account_deletion_pending`, as without this part):
 *
 * - a workspace that would go while other people are in it (the deletion would
 *   find no one to hand it to) is never deleted from here;
 * - a workspace that would go and holds an Organization linked to Ever Platform
 *   is kept: that organization may have other people on Ever Platform;
 * - an installation administrator is never deleted from here.
 */
@Injectable()
export class PersonDeletionParticipantService implements OnModuleInit {
    private readonly logger = new Logger(PersonDeletionParticipantService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly accounts: AccountDeletionService,
        @Optional() private readonly extensions?: EverConnectExtensions,
    ) {}

    onModuleInit(): void {
        const participant = this.participant();
        if (participant) this.extensions?.providePersonData(participant);
    }

    /** What is switched on, as the request handler calls it; `null` while off. */
    participant(
        env: Readonly<Record<string, string | undefined>> = process.env,
    ): PersonDataParticipant | null {
        if (!isPersonDeletionEnabled(env)) return null;
        return { deleteAccounts: (request) => this.deleteAccounts(request) };
    }

    /** Delete the person's accounts, all or none. */
    async deleteAccounts(request: PersonDataRequest): Promise<PersonDeletionOutcome> {
        // Never registered while off; a direct call deletes nothing either.
        if (!isPersonDeletionEnabled()) return { result: 'pending' };

        const present: string[] = [];
        for (const userId of new Set(request.userIds)) {
            const hold = await this.holdFor(userId);
            if (hold === 'gone') continue;
            if (hold) {
                this.logger.warn(`ever_connect.person_deletion.held ${hold}`);
                return { result: 'pending' };
            }
            present.push(userId);
        }

        for (const userId of present) {
            try {
                await this.accounts.execute(userId, { source: 'ever_platform' });
            } catch (error) {
                // Deleted meanwhile (by the person, or an earlier delivery): done.
                if (error instanceof NotFoundException) continue;
                throw error;
            }
        }
        this.logger.log(`ever_connect.person_deletion.deleted ${present.length}`);
        return { result: 'deleted' };
    }

    /**
     * Why the account must be kept, `null` when it may be deleted, `'gone'` when
     * there is no such account any more. Reads only.
     */
    async holdFor(userId: string): Promise<PersonDeletionHold | 'gone' | null> {
        const user = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: userId }, select: ['id', 'isPlatformAdmin'] });
        if (!user) return 'gone';
        if (user.isPlatformAdmin) return 'platform_admin';

        let preview: Awaited<ReturnType<AccountDeletionService['preview']>>;
        try {
            preview = await this.accounts.preview(userId);
        } catch (error) {
            if (error instanceof NotFoundException) return 'gone';
            throw error;
        }
        const going = preview.accounts.filter((account) => account.outcome === 'workspace-deleted');
        if (going.some((account) => account.otherMembers > 0)) return 'workspace_shared';
        if (going.length > 0) {
            // Only a workspace the account owns can go with it.
            const owned = await this.dataSource
                .getRepository(Tenant)
                .findOne({ where: { ownerUserId: userId }, select: ['id'] });
            if (owned) {
                const linked = await this.dataSource
                    .getRepository(EverConnectLink)
                    .count({ where: { tenantId: owned.id, status: 'active' } });
                if (linked > 0) return 'organization_linked';
            }
        }
        return null;
    }
}
