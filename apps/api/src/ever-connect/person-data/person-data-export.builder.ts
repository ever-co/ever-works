import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, type ObjectLiteral } from 'typeorm';
import {
    ApiKey,
    ExternalIdentity,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
    WorkMember,
} from '@ever-works/agent/entities';

/** The name and version of the document a person's export is. */
export const PERSON_DATA_EXPORT_FORMAT = 'ever-works.person-data';
export const PERSON_DATA_EXPORT_VERSION = 1;

type Iso = string | null;

/** One Work, as its owner or a member of it sees it. */
export interface ExportedPersonWork {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    /** `directory`, `app`, `company`, …: an App is a Work of kind `app`. */
    readonly kind: string;
    readonly status: string | null;
    readonly description: string | null;
    readonly website: string | null;
    readonly organizationId: string | null;
    readonly createdAt: Iso;
    readonly updatedAt: Iso;
}

/**
 * What Ever Works holds about one account, for the person it belongs to.
 *
 * Only the account's own data and what the person can already see: the
 * Organizations of their account (each with their own role in it, never the
 * other members), the Works they own and the ones they are a member of. Never a
 * password, a token, a key's secret or a plugin's settings (which may hold
 * credentials): those are named, not copied.
 */
export interface PersonDataExportDocument {
    readonly format: typeof PERSON_DATA_EXPORT_FORMAT;
    readonly version: typeof PERSON_DATA_EXPORT_VERSION;
    readonly exportedAt: string;
    readonly account: {
        readonly id: string;
        readonly username: string;
        readonly slug: string;
        readonly email: string | null;
        readonly emailVerified: boolean;
        readonly displayName: string | null;
        readonly avatar: string | null;
        readonly registrationProvider: string;
        readonly isAnonymous: boolean;
        readonly isActive: boolean;
        readonly isPlatformAdmin: boolean;
        readonly committerName: string | null;
        readonly committerEmail: string | null;
        readonly lastLoginAt: Iso;
        readonly lastLoginIp: string | null;
        readonly createdAt: Iso;
        readonly updatedAt: Iso;
    };
    /** The sign-in identities connected to the account (Ever ID and others). */
    readonly identities: ReadonlyArray<{
        readonly issuer: string;
        readonly subject: string;
        readonly emailAtLink: string;
        readonly emailVerifiedAtLink: boolean;
        readonly linkedVia: string;
        readonly linkedAt: Iso;
        readonly lastLoginAt: Iso;
        /** The apps that read the person's App Works for them. */
        readonly delegatedClients: unknown[];
    }>;
    /** The account's workspace: the one it owns, or the one it was invited into. */
    readonly workspaces: ReadonlyArray<{
        readonly id: string;
        readonly displayName: string;
        readonly role: 'owner' | 'member';
    }>;
    /** Every Organization of those workspaces, with the person's own role in it. */
    readonly organizations: ReadonlyArray<{
        readonly id: string;
        readonly workspaceId: string;
        readonly slug: string;
        readonly displayName: string;
        /** `owner` (the workspace owner), `admin` or `member`; `null`: no roster entry. */
        readonly role: string | null;
        readonly joinedAt: Iso;
    }>;
    readonly works: {
        /** The Works (and Apps) the account created and owns. */
        readonly owned: readonly ExportedPersonWork[];
        /** Other Works the account is a member of, with its role there. */
        readonly memberOf: ReadonlyArray<ExportedPersonWork & { readonly role: string }>;
    };
    readonly settings: {
        readonly notifications: {
            readonly emailAgentAlerts: boolean;
            readonly emailTaskNotifications: boolean;
            readonly emailBudgetAlerts: boolean;
            readonly digestFrequency: string;
        };
        readonly onboarding: {
            readonly completedAt: Iso;
            readonly dismissedAt: Iso;
            readonly state: unknown;
            readonly inferredInterests: unknown;
            readonly suggestedVerticals: unknown;
            readonly userResearchOptOut: boolean;
        };
        /** Plugins the account turned on for itself (their settings are not copied). */
        readonly plugins: ReadonlyArray<{
            readonly pluginId: string;
            readonly enabled: boolean;
            readonly createdAt: Iso;
        }>;
        /** The account's API keys, by name and visible prefix (never the key). */
        readonly apiKeys: ReadonlyArray<{
            readonly name: string;
            readonly prefix: string;
            readonly kind: string;
            readonly isActive: boolean;
            readonly createdAt: Iso;
            readonly lastUsedAt: Iso;
            readonly expiresAt: Iso;
        }>;
    };
}

/**
 * Builds a person's export from the database: one account, read for that
 * account only. Never writes.
 */
@Injectable()
export class PersonDataExportBuilder {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** The account's document, or `null` when there is no such account. */
    async build(userId: string, now = new Date()): Promise<PersonDataExportDocument | null> {
        const user = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
        if (!user) return null;

        const identities = await this.dataSource
            .getRepository(ExternalIdentity)
            .find({ where: { userId }, order: { linkedAt: 'ASC' } });

        const owned = await this.dataSource
            .getRepository(Tenant)
            .findOne({ where: { ownerUserId: userId } });
        const workspaceIds = [
            ...new Set([owned?.id, user.tenantId].filter((id): id is string => !!id)),
        ];
        const workspaces = workspaceIds.length
            ? await this.dataSource.getRepository(Tenant).find({ where: { id: In(workspaceIds) } })
            : [];
        const organizations = workspaceIds.length
            ? await this.dataSource.getRepository(Organization).find({
                  where: { tenantId: In(workspaceIds) },
                  order: { createdAt: 'ASC' },
              })
            : [];
        const roster = await this.dataSource
            .getRepository(OrganizationMember)
            .find({ where: { userId } });
        const rosterByOrg = new Map(roster.map((row) => [row.organizationId, row]));
        const ownerOf = new Set(
            workspaces.filter((t) => t.ownerUserId === userId).map((t) => t.id),
        );

        const ownedWorks = await this.dataSource
            .getRepository(Work)
            .find({ where: { userId }, order: { createdAt: 'ASC' } });
        const workMemberships = (
            await this.dataSource.getRepository(WorkMember).find({ where: { userId } })
        ).filter((membership) => !ownedWorks.some((work) => work.id === membership.workId));
        const memberWorks = workMemberships.length
            ? await this.dataSource.getRepository(Work).find({
                  where: { id: In(workMemberships.map((membership) => membership.workId)) },
              })
            : [];
        const memberWorkById = new Map(memberWorks.map((work) => [work.id, work]));

        const apiKeys = await this.dataSource
            .getRepository(ApiKey)
            .find({ where: { userId }, order: { createdAt: 'ASC' } });

        return {
            format: PERSON_DATA_EXPORT_FORMAT,
            version: PERSON_DATA_EXPORT_VERSION,
            exportedAt: now.toISOString(),
            account: {
                id: user.id,
                username: user.username,
                slug: user.slug,
                email: user.email ?? null,
                emailVerified: user.emailVerified === true,
                displayName: user.displayName ?? null,
                avatar: user.avatar ?? null,
                registrationProvider: user.registrationProvider,
                isAnonymous: user.isAnonymous === true,
                isActive: user.isActive !== false,
                isPlatformAdmin: user.isPlatformAdmin === true,
                committerName: user.committerName ?? null,
                committerEmail: user.committerEmail ?? null,
                lastLoginAt: iso(user.lastLoginAt),
                lastLoginIp: user.lastLoginIp ?? null,
                createdAt: iso(user.createdAt),
                updatedAt: iso(user.updatedAt),
            },
            identities: identities.map((identity) => ({
                issuer: identity.issuer,
                subject: identity.subject,
                emailAtLink: identity.emailAtLink,
                emailVerifiedAtLink: identity.emailVerifiedAtLink === true,
                linkedVia: identity.linkedVia,
                linkedAt: iso(identity.linkedAt),
                lastLoginAt: iso(identity.lastLoginAt),
                delegatedClients: Array.isArray(identity.delegatedClients)
                    ? [...identity.delegatedClients]
                    : [],
            })),
            workspaces: workspaces.map((tenant) => ({
                id: tenant.id,
                displayName: tenant.displayName,
                role: ownerOf.has(tenant.id) ? ('owner' as const) : ('member' as const),
            })),
            organizations: organizations.map((organization) => {
                const row = rosterByOrg.get(organization.id);
                return {
                    id: organization.id,
                    workspaceId: organization.tenantId,
                    slug: organization.slug,
                    displayName: organization.displayName,
                    role: ownerOf.has(organization.tenantId) ? 'owner' : (row?.role ?? null),
                    joinedAt: iso(row?.joinedAt ?? null),
                };
            }),
            works: {
                owned: ownedWorks.map(workView),
                memberOf: workMemberships
                    .filter((membership) => memberWorkById.has(membership.workId))
                    .map((membership) => ({
                        ...workView(memberWorkById.get(membership.workId) as Work),
                        role: String(membership.role),
                    })),
            },
            settings: {
                notifications: {
                    emailAgentAlerts: user.emailAgentAlerts === true,
                    emailTaskNotifications: user.emailTaskNotifications === true,
                    emailBudgetAlerts: user.emailBudgetAlerts !== false,
                    digestFrequency: user.digestFrequency ?? 'off',
                },
                onboarding: {
                    completedAt: iso(user.onboardingCompletedAt),
                    dismissedAt: iso(user.onboardingDismissedAt),
                    state: user.onboardingState ?? null,
                    inferredInterests: user.inferredInterests ?? null,
                    suggestedVerticals: user.suggestedVerticals ?? null,
                    userResearchOptOut: user.userResearchOptOut === true,
                },
                plugins: await this.userPlugins(userId),
                apiKeys: apiKeys.map((key) => ({
                    name: key.name,
                    prefix: key.prefix,
                    kind: String(key.kind),
                    isActive: key.isActive !== false,
                    createdAt: iso(key.createdAt),
                    lastUsedAt: iso(key.lastUsedAt),
                    expiresAt: iso(key.expiresAt),
                })),
            },
        };
    }

    /**
     * The account's plugin choices (`user_plugins`), read through the entity the
     * running schema maps to that table; none when it has no such table. The
     * settings columns are never read: they may hold credentials.
     */
    private async userPlugins(
        userId: string,
    ): Promise<PersonDataExportDocument['settings']['plugins']> {
        const meta = this.dataSource.entityMetadatas.find(
            (candidate) => candidate.tableName === 'user_plugins',
        );
        if (!meta) return [];
        const rows = (await this.dataSource.getRepository<ObjectLiteral>(meta.target).find({
            select: { pluginId: true, enabled: true, createdAt: true },
            where: { userId },
            order: { createdAt: 'ASC' },
        })) as Array<{ pluginId: string; enabled: boolean; createdAt: Date }>;
        return rows.map((row) => ({
            pluginId: row.pluginId,
            enabled: row.enabled === true,
            createdAt: iso(row.createdAt),
        }));
    }
}

function workView(work: Work): ExportedPersonWork {
    return {
        id: work.id,
        name: work.name,
        slug: work.slug,
        kind: String(work.kind),
        status: work.status ? String(work.status) : null,
        description: work.description ?? null,
        website: work.website ?? null,
        organizationId: work.organizationId ?? null,
        createdAt: iso(work.createdAt),
        updatedAt: iso(work.updatedAt),
    };
}

function iso(value: Date | string | null | undefined): Iso {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
