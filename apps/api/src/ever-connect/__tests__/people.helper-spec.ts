import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    ApiKey,
    AuthSession,
    EverConnectLink,
    EverConnectPersonRequest,
    ExternalIdentity,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
    WorkMember,
} from '@ever-works/agent/entities';

/**
 * People, workspaces and links in the in-memory database of
 * `identity/__tests__/db.helper-spec.ts` (keys off: rows are seeded as the
 * code under test reads them, not through their relations).
 */

/** Empty every table these helpers write. */
export async function clearPeople(dataSource: DataSource): Promise<void> {
    for (const entity of [
        ApiKey,
        AuthSession,
        WorkMember,
        Work,
        OrganizationMember,
        EverConnectLink,
        Organization,
        Tenant,
        ExternalIdentity,
        EverConnectPersonRequest,
        User,
    ]) {
        await dataSource.getRepository(entity).clear();
    }
}

/** An account (`username` doubles as its slug and the local part of its address). */
export async function addUser(
    dataSource: DataSource,
    username: string,
    values: Partial<User> = {},
): Promise<User> {
    const users = dataSource.getRepository(User);
    return users.save(
        users.create({
            id: randomUUID(),
            username,
            slug: username,
            email: `${username}@example.test`,
            ...values,
        } as Partial<User>),
    );
}

/** A workspace the account owns, with one Organization (the account is homed in it). */
export async function addWorkspace(
    dataSource: DataSource,
    owner: User,
    slug: string,
): Promise<{ tenant: Tenant; organization: Organization }> {
    const tenant = await dataSource.getRepository(Tenant).save(
        dataSource.getRepository(Tenant).create({
            id: randomUUID(),
            ownerUserId: owner.id,
            slug,
            displayName: slug,
        }),
    );
    await dataSource.getRepository(User).update({ id: owner.id }, { tenantId: tenant.id });
    owner.tenantId = tenant.id;
    const organization = await dataSource.getRepository(Organization).save(
        dataSource.getRepository(Organization).create({
            id: randomUUID(),
            tenantId: tenant.id,
            slug,
            displayName: slug,
        } as Partial<Organization>),
    );
    return { tenant, organization };
}

/** The account joins the Organization's workspace with a roster role, as an accepted invitation does. */
export async function addMember(
    dataSource: DataSource,
    user: User,
    organization: Organization,
    role: 'admin' | 'member' = 'member',
    joinedAt = new Date('2026-10-01T00:00:00Z'),
): Promise<OrganizationMember> {
    await dataSource
        .getRepository(User)
        .update({ id: user.id }, { tenantId: organization.tenantId });
    user.tenantId = organization.tenantId;
    const roster = dataSource.getRepository(OrganizationMember);
    return roster.save(
        roster.create({
            organizationId: organization.id,
            tenantId: organization.tenantId,
            userId: user.id,
            role,
            joinedAt,
        }),
    );
}

/** A Work the account created (in a workspace when `tenantId` is given). */
export async function addWork(
    dataSource: DataSource,
    user: User,
    slug: string,
    values: Partial<Work> = {},
): Promise<Work> {
    const works = dataSource.getRepository(Work);
    return works.save(
        works.create({
            userId: user.id,
            name: slug,
            slug,
            owner: user.username,
            description: slug,
            ...values,
        } as Partial<Work>),
    );
}

/** The Organization's active link to an Ever organization. */
export async function addLink(
    dataSource: DataSource,
    organization: Organization,
    platformLinkId: string,
): Promise<EverConnectLink> {
    const links = dataSource.getRepository(EverConnectLink);
    return links.save(
        links.create({
            organizationId: organization.id,
            tenantId: organization.tenantId,
            everOrgId: '01JNB79NZW2S85GF4A96MMX6BT',
            handle: '',
            platformLinkId,
            productOrgRef: organization.slug,
            createdVia: 'link_code',
            status: 'active',
        }),
    );
}
