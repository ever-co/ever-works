import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In, IsNull, Not, type EntityMetadata } from 'typeorm';
import {
    DemoUsageCounter,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
} from '@ever-works/agent/entities';
import { DEMO_REGISTRATION_PROVIDER } from '@ever-works/agent/demo';
import { AnonymousUserCleanupService, WorkLifecycleService } from '@ever-works/agent/services';
import { getActiveStorageBackend } from '../uploads/storage-backend.factory';
import { sandboxQuotaKey } from './demo-ai-quota.service';

/**
 * The `demo_usage_counters` key counting a sandbox's failed purges (the demo sweeper holds a
 * sandbox for an operator at `DEMO_PURGE_MAX_FAILURES`). Removed by the purge that succeeds.
 */
export function sandboxPurgeFailureKey(userId: string): string {
    return `sweep:purge-fail:${userId}`;
}

/** What one sandbox's purge removed. */
export interface DemoSandboxPurgeSummary {
    worksDeleted: number;
    filesDeleted: number;
    tenantsDeleted: number;
    organizationsDeleted: number;
}

/** The ids that place a row in one demo sandbox. */
interface SandboxScope {
    readonly userId: string;
    readonly tenantIds: string[];
    readonly organizationIds: string[];
}

/** A table the content sweep deletes from, with the scope columns it has. */
interface ScopedTable {
    readonly metadata: EntityMetadata;
    readonly tenantId: boolean;
    readonly organizationId: boolean;
    readonly userId: boolean;
}

/** Removed explicitly, last and in this order, once nothing else of the sandbox is left. */
const WORKSPACE_TABLES = new Set(['users', 'tenants', 'organizations']);

/** Enough passes for the deepest chain of non-cascading foreign keys between scoped tables. */
const MAX_PASSES = 6;

/**
 * Platform demo mode — removes everything of ONE expired demo sandbox (design §5.2.5 step 2),
 * once the demo sweeper has removed its GitHub repositories. Leaves nothing behind: the demo
 * runs on SQLite, whose synchronize-built schema has none of the migrated schema's
 * tenant/organization cascades, so a deleted user would otherwise orphan every row of its
 * workspace.
 *
 *   1. Its Works, through the normal Work delete path (`WorkLifecycleService.deleteWork`),
 *      every repository KEPT: the ledger, not the Work, says which repositories are the
 *      sandbox's.
 *   2. Its uploaded files (the storage backend, as account deletion does).
 *   3. Every remaining row of its workspace: in every table of the schema, the rows whose
 *      `tenantId` is the sandbox's Tenant, whose `organizationId` is one of its
 *      Organizations, or whose `userId` is the sandbox user (Teams, Agents, Missions, Goals,
 *      Tasks, knowledge, agent runs, conversations, activity, sessions, domain events, …).
 *      Children without those columns go by their foreign-key cascade. Repeated until no
 *      table refuses (one non-cascading foreign key between two of them only orders the
 *      deletes); a table that still refuses fails the purge, before anything below.
 *   4. Its Organization(s) and Tenant — now empty.
 *   5. The user, through `AnonymousUserCleanupService.purgeUser`; then its counters (AI quota,
 *      failed purges).
 * The Tenant goes before the user: a purge interrupted between the two leaves the expired
 * user, which the next sweep finds and finishes, rather than a Tenant nothing points to.
 *
 * Every delete is scoped by the sandbox's own ids, and only a sandbox that owns its
 * workspace alone is purged: a Tenant another account belongs to, or an Organization with
 * another member, is refused and left for an operator.
 */
@Injectable()
export class DemoSandboxPurgeService {
    private readonly logger = new Logger(DemoSandboxPurgeService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly workLifecycle: WorkLifecycleService,
        private readonly anonymousCleanup: AnonymousUserCleanupService,
    ) {}

    /**
     * The ids of the sandbox's Works that are generating (started, not finished): a Trigger
     * worker may still be making a repository for one, which must be ledgered — and swept —
     * before the sandbox goes. The sweeper bounds how long it waits on them
     * (`DEMO_GENERATION_DEFERRAL_MAX_MS`): one that started and never progressed is never
     * closed by the stale-generation cleanup.
     */
    async generationsInFlight(userId: string): Promise<string[]> {
        const generating = await this.dataSource.getRepository(Work).find({
            where: {
                userId,
                generationStartedAt: Not(IsNull()),
                generationFinishedAt: IsNull(),
            },
            select: ['id'],
        });
        return generating.map((work) => work.id);
    }

    async purge(user: User): Promise<DemoSandboxPurgeSummary> {
        if (!user.isAnonymous || user.registrationProvider !== DEMO_REGISTRATION_PROVIDER) {
            throw new Error(`Refusing to purge ${user.id}: not a demo sandbox`);
        }
        const scope = await this.sandboxScope(user);

        const worksDeleted = await this.deleteWorks(user);
        const filesDeleted = await this.deleteFiles(user.id);

        const refused = await this.deleteSandboxRows(scope);
        if (refused.length > 0) {
            throw new Error(
                `Sandbox ${user.id} still has rows in ${refused.join(', ')}; kept for the next sweep`,
            );
        }
        const { tenantsDeleted, organizationsDeleted } = await this.deleteWorkspace(scope);

        const outcome = await this.anonymousCleanup.purgeUser(user);
        if (!outcome.deleted) {
            throw new Error(`Sandbox user ${user.id} could not be deleted: ${outcome.error}`);
        }

        await this.deleteSandboxCounters(user.id);
        return { worksDeleted, filesDeleted, tenantsDeleted, organizationsDeleted };
    }

    /**
     * Last, once the sandbox is gone: its AI quota counter and the sweeper's count of its failed
     * purges (cleared only by a purge that got to the end). The sandbox is already deleted, so a
     * failure here is only logged.
     */
    private async deleteSandboxCounters(userId: string): Promise<void> {
        try {
            await this.dataSource.getRepository(DemoUsageCounter).delete({
                key: In([sandboxQuotaKey(userId), sandboxPurgeFailureKey(userId)]),
            });
        } catch (error) {
            this.logger.warn(
                `demo purge: counters of the purged sandbox ${userId} stay (${messageOf(error)})`,
            );
        }
    }

    /**
     * The sandbox's Tenant(s) — those it owns — and their Organizations. Refuses a sandbox that
     * belongs to a Tenant it does not own, or whose workspace holds another account.
     */
    private async sandboxScope(user: User): Promise<SandboxScope> {
        const tenantIds = (
            await this.dataSource
                .getRepository(Tenant)
                .find({ where: { ownerUserId: user.id }, select: ['id'] })
        ).map((tenant) => tenant.id);
        if (
            user.tenantId &&
            !tenantIds.includes(user.tenantId) &&
            (await this.dataSource.getRepository(Tenant).countBy({ id: user.tenantId })) > 0
        ) {
            throw new Error(
                `Sandbox ${user.id} belongs to Tenant ${user.tenantId}, which it does not own`,
            );
        }

        const organizationIds = tenantIds.length
            ? (
                  await this.dataSource
                      .getRepository(Organization)
                      .find({ where: { tenantId: In(tenantIds) }, select: ['id'] })
              ).map((organization) => organization.id)
            : [];

        await this.assertSoleMember(user.id, tenantIds, organizationIds);
        return { userId: user.id, tenantIds, organizationIds };
    }

    private async assertSoleMember(
        userId: string,
        tenantIds: string[],
        organizationIds: string[],
    ): Promise<void> {
        const otherUsers = tenantIds.length
            ? await this.dataSource
                  .getRepository(User)
                  .count({ where: { tenantId: In(tenantIds), id: Not(userId) } })
            : 0;
        const otherMembers = organizationIds.length
            ? await this.dataSource.getRepository(OrganizationMember).count({
                  where: { organizationId: In(organizationIds), userId: Not(userId) },
              })
            : 0;
        if (otherUsers > 0 || otherMembers > 0) {
            throw new Error(
                `Sandbox ${userId}'s workspace has another member; left for an operator`,
            );
        }
    }

    /**
     * The normal Work delete path, every repository kept (as account deletion does). Best
     * effort per Work: whatever a failed teardown leaves, the row sweep removes.
     */
    private async deleteWorks(user: User): Promise<number> {
        const works = await this.dataSource
            .getRepository(Work)
            .find({ where: { userId: user.id }, select: ['id', 'slug'] });
        for (const work of works) {
            try {
                await this.workLifecycle.deleteWork(
                    work.id,
                    {
                        delete_data_repository: false,
                        delete_markdown_repository: false,
                        delete_website_repository: false,
                        delete_stored_data: true,
                        confirm_slug: work.slug,
                    },
                    user,
                );
            } catch (error) {
                this.logger.warn(
                    `demo purge: Work ${work.id} teardown failed (${messageOf(error)}); its row is removed with the sandbox`,
                );
            }
        }
        return works.length;
    }

    /** The sandbox's uploaded files, best effort (the storage backend is outside the database). */
    private async deleteFiles(userId: string): Promise<number> {
        try {
            const backend = (await getActiveStorageBackend()) as {
                deleteAllByOwner?: (ownerId: string) => Promise<{ deleted: number }>;
            };
            if (typeof backend?.deleteAllByOwner !== 'function') return 0;
            return (await backend.deleteAllByOwner(userId)).deleted;
        } catch (error) {
            this.logger.warn(
                `demo purge: file clean-up failed for ${userId} (${messageOf(error)})`,
            );
            return 0;
        }
    }

    /**
     * Step 3: every row of the sandbox in every table but the workspace's own. Answers the
     * tables that still refused after the last pass (empty when everything went).
     */
    private async deleteSandboxRows(scope: SandboxScope): Promise<string[]> {
        let pending = this.scopedTables();
        const failures = new Map<string, string>();
        for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass += 1) {
            const refused: ScopedTable[] = [];
            for (const table of pending) {
                try {
                    await this.deleteScopedRows(table, scope);
                    failures.delete(table.metadata.tableName);
                } catch (error) {
                    refused.push(table);
                    failures.set(table.metadata.tableName, messageOf(error));
                }
            }
            // A pass that removed nothing more cannot be helped by another.
            if (refused.length === pending.length) {
                pending = refused;
                break;
            }
            pending = refused;
        }
        return pending.map(
            (table) => `${table.metadata.tableName} (${failures.get(table.metadata.tableName)})`,
        );
    }

    private scopedTables(): ScopedTable[] {
        const tables: ScopedTable[] = [];
        for (const metadata of this.dataSource.entityMetadatas) {
            if (metadata.tableType === 'view' || WORKSPACE_TABLES.has(metadata.tableName)) continue;
            const has = (name: string) =>
                metadata.columns.some((column) => column.databaseName === name);
            const table = {
                metadata,
                tenantId: has('tenantId'),
                organizationId: has('organizationId'),
                userId: has('userId'),
            };
            if (table.tenantId || table.organizationId || table.userId) tables.push(table);
        }
        return tables;
    }

    private async deleteScopedRows(table: ScopedTable, scope: SandboxScope): Promise<void> {
        const escape = (name: string) => this.dataSource.driver.escape(name);
        const clauses: string[] = [];
        if (table.tenantId && scope.tenantIds.length > 0) {
            clauses.push(`${escape('tenantId')} IN (:...tenantIds)`);
        }
        if (table.organizationId && scope.organizationIds.length > 0) {
            clauses.push(`${escape('organizationId')} IN (:...organizationIds)`);
        }
        if (table.userId) {
            clauses.push(`${escape('userId')} = :userId`);
        }
        if (clauses.length === 0) return;
        await this.dataSource
            .createQueryBuilder()
            .delete()
            .from(table.metadata.target)
            .where(clauses.join(' OR '), {
                tenantIds: scope.tenantIds,
                organizationIds: scope.organizationIds,
                userId: scope.userId,
            })
            .execute();
    }

    /** Step 4: the Organizations, then the Tenants — empty once step 3 is done. */
    private async deleteWorkspace(
        scope: SandboxScope,
    ): Promise<{ tenantsDeleted: number; organizationsDeleted: number }> {
        if (scope.tenantIds.length === 0) return { tenantsDeleted: 0, organizationsDeleted: 0 };
        // Re-checked here: nobody may have joined the workspace while it was emptied.
        await this.assertSoleMember(scope.userId, scope.tenantIds, scope.organizationIds);
        return this.dataSource.transaction(async (manager) => {
            const organizations = await manager
                .getRepository(Organization)
                .delete({ tenantId: In(scope.tenantIds) });
            const tenants = await manager
                .getRepository(Tenant)
                .delete({ id: In(scope.tenantIds), ownerUserId: scope.userId });
            return {
                organizationsDeleted: organizations.affected ?? 0,
                tenantsDeleted: tenants.affected ?? 0,
            };
        });
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
