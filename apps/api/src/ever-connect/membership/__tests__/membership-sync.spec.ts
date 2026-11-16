// The Organization module pulls in the whole auth stack, and the membership
// code its own graph; the sync needs their names only (the membership code's
// rules have their own spec: `organization-member-platform.spec.ts`).
jest.mock('../../../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));
jest.mock('../../../organizations/organization-invitation-flow.service', () => ({
    OrganizationInvitationFlowService: class OrganizationInvitationFlowService {},
}));

import type { DataSource } from 'typeorm';
import { EverConnectLink, EverConnectMembershipSync } from '@ever-works/agent/entities';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import { createIdentityDataSource, insertIdentity } from '../../identity/__tests__/db.helper-spec';
import { addLink, addUser, addWorkspace, clearPeople } from '../../__tests__/people.helper-spec';
import {
    EverConnectMembershipSyncModule,
    everConnectMembershipSyncModuleImports,
} from '../membership-sync.module';
import { EverConnectMembershipSyncService } from '../membership-sync.service';

/**
 * The membership changes Ever Platform sends on the feed
 * (`ever.registry.membership.created|role_changed|removed`, the installation's
 * shape: tenant link, Ever ID identity, optional local account, Ever role),
 * applied to the linked Organization (`EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED`).
 *
 * - Off (the default): not registered; nothing is read or written.
 * - The person is the account with that identity; the Organization the one of
 *   that active link; nothing changes for anyone else.
 * - Ever roles map to roster roles (`owner` and `admin` → `admin`, `member` →
 *   `member`); any other role changes nothing.
 * - The same envelope twice changes nothing more; an older one than the last
 *   applied (by `occurred_at`, then id) is skipped.
 */
describe('Ever Connect — membership sync', () => {
    const ISSUER = 'https://id.example.test';
    const LINK = '01JC5M2R4T6V8X0Z2B4D6F8H0K';
    const SWITCHES = ['EVER_CONNECT_ENABLED', 'EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED'];
    let dataSource: DataSource;
    let saved: Record<string, string | undefined>;
    let flow: {
        addMemberForPlatform: jest.Mock;
        setMemberRoleForPlatform: jest.Mock;
        removeMemberForPlatform: jest.Mock;
    };

    const switchOn = () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED = 'true';
    };

    const envelope = (
        id: string,
        change: 'created' | 'role_changed' | 'removed',
        values: Record<string, unknown> = {},
        occurredAt = '2026-11-02T10:00:00Z',
    ) => ({
        id,
        type: `ever.registry.membership.${change}`,
        version: 1,
        occurred_at: occurredAt,
        subject: { kind: 'membership', id: '01J5J6QCKEW0ZYA4ABZ82DVQ7X' },
        data: {
            tenant_link_id: LINK,
            identity_issuer: ISSUER,
            identity_subject: 'sub-bob',
            role: 'admin',
            ...values,
        },
    });

    const service = (extensions?: EverConnectExtensions) =>
        new EverConnectMembershipSyncService(dataSource, flow as never, extensions);

    /** Ada's workspace, linked to Ever Platform; Bob has an account and an Ever ID here. */
    async function seed() {
        const ada = await addUser(dataSource, 'ada');
        const { organization } = await addWorkspace(dataSource, ada, 'ada-co');
        await addLink(dataSource, organization, LINK);
        const bob = await addUser(dataSource, 'bob');
        await insertIdentity(dataSource, { userId: bob.id, issuer: ISSUER, subject: 'sub-bob' });
        return { ada, bob, organization };
    }

    const syncRows = () => dataSource.getRepository(EverConnectMembershipSync).find();

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        saved = Object.fromEntries(SWITCHES.map((name) => [name, process.env[name]]));
        for (const name of SWITCHES) delete process.env[name];
        await clearPeople(dataSource);
        await dataSource.getRepository(EverConnectMembershipSync).clear();
        flow = {
            addMemberForPlatform: jest.fn().mockResolvedValue('added'),
            setMemberRoleForPlatform: jest.fn().mockResolvedValue('role_set'),
            removeMemberForPlatform: jest.fn().mockResolvedValue('removed'),
        };
    });

    afterEach(() => {
        for (const name of SWITCHES) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    });

    describe('switched off (the default)', () => {
        it('no module, not on the feed, nothing applied', async () => {
            expect(everConnectMembershipSyncModuleImports({})).toEqual([]);
            expect(
                everConnectMembershipSyncModuleImports({ EVER_CONNECT_ENABLED: 'true' }),
            ).toEqual([]);
            expect(
                everConnectMembershipSyncModuleImports({
                    EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED: 'true',
                }),
            ).toEqual([]);

            await seed();
            const extensions = new EverConnectExtensions();
            const sync = service(extensions);
            sync.onModuleInit();
            expect(extensions.handlesFeedEvent('ever.registry.membership.created')).toBe(false);

            expect(await sync.apply(envelope('01JD0000000000000000000001', 'created'))).toBe(
                'switched_off',
            );
            expect(flow.addMemberForPlatform).not.toHaveBeenCalled();
            expect(await syncRows()).toEqual([]);
        });
    });

    describe('switched on', () => {
        beforeEach(switchOn);

        it('joins the feed and applies an addition to the linked Organization', async () => {
            expect(everConnectMembershipSyncModuleImports(process.env)).toEqual([
                EverConnectMembershipSyncModule,
            ]);
            const { bob, organization } = await seed();
            const extensions = new EverConnectExtensions();
            service(extensions).onModuleInit();
            expect(extensions.handlesFeedEvent('ever.registry.membership.created')).toBe(true);
            expect(extensions.handlesFeedEvent('ever.registry.membership.removed')).toBe(true);
            expect(extensions.handlesFeedEvent('ever.registry.person.export_requested')).toBe(
                false,
            );

            await extensions.dispatchFeedEvent(envelope('01JD0000000000000000000001', 'created'));

            expect(flow.addMemberForPlatform).toHaveBeenCalledWith(
                organization.id,
                bob.id,
                'admin',
            );
            expect(await syncRows()).toEqual([
                expect.objectContaining({
                    organizationId: organization.id,
                    userId: bob.id,
                    lastEventId: '01JD0000000000000000000001',
                    lastChange: 'created',
                    lastRole: 'admin',
                    outcome: 'added',
                }),
            ]);
        });

        it('maps Ever roles to roster roles; an unknown role changes nothing', async () => {
            const { bob, organization } = await seed();
            const sync = service();

            await sync.apply(envelope('01JD0000000000000000000001', 'created', { role: 'owner' }));
            expect(flow.addMemberForPlatform).toHaveBeenLastCalledWith(
                organization.id,
                bob.id,
                'admin',
            );
            await sync.apply(
                envelope(
                    '01JD0000000000000000000002',
                    'role_changed',
                    { role: 'member' },
                    '2026-11-03T10:00:00Z',
                ),
            );
            expect(flow.setMemberRoleForPlatform).toHaveBeenLastCalledWith(
                organization.id,
                bob.id,
                'member',
            );

            expect(
                await sync.apply(
                    envelope(
                        '01JD0000000000000000000003',
                        'role_changed',
                        { role: 'billing' },
                        '2026-11-04T10:00:00Z',
                    ),
                ),
            ).toBe('role_unknown');
            expect(
                await sync.apply(
                    envelope(
                        '01JD0000000000000000000004',
                        'removed',
                        { role: 'guest' },
                        '2026-11-05T10:00:00Z',
                    ),
                ),
            ).toBe('role_unknown');
            expect(flow.setMemberRoleForPlatform).toHaveBeenCalledTimes(1);
            expect(flow.removeMemberForPlatform).not.toHaveBeenCalled();
            // The unknown role is not even remembered as the last change.
            expect(await syncRows()).toEqual([
                expect.objectContaining({ lastEventId: '01JD0000000000000000000002' }),
            ]);
        });

        it('the same envelope twice changes nothing more', async () => {
            await seed();
            const sync = service();
            const added = envelope('01JD0000000000000000000001', 'created');

            expect(await sync.apply(added)).toBe('added');
            expect(await sync.apply(added)).toBe('duplicate');

            expect(flow.addMemberForPlatform).toHaveBeenCalledTimes(1);
            expect(await syncRows()).toHaveLength(1);
        });

        it('an envelope older than the last one applied is skipped', async () => {
            await seed();
            const sync = service();

            expect(
                await sync.apply(
                    envelope('01JD0000000000000000000002', 'removed', {}, '2026-11-03T10:00:00Z'),
                ),
            ).toBe('removed');
            // The addition happened before the removal: applying it now would undo it.
            expect(
                await sync.apply(
                    envelope('01JD0000000000000000000001', 'created', {}, '2026-11-02T10:00:00Z'),
                ),
            ).toBe('stale');

            expect(flow.addMemberForPlatform).not.toHaveBeenCalled();
            expect(await syncRows()).toEqual([
                expect.objectContaining({
                    lastEventId: '01JD0000000000000000000002',
                    lastChange: 'removed',
                }),
            ]);
        });

        it('at the same time, the envelope id decides', async () => {
            await seed();
            const sync = service();
            const at = '2026-11-02T10:00:00Z';

            await sync.apply(envelope('01JD0000000000000000000005', 'role_changed', {}, at));
            expect(
                await sync.apply(envelope('01JD0000000000000000000004', 'removed', {}, at)),
            ).toBe('stale');
            expect(
                await sync.apply(envelope('01JD0000000000000000000006', 'removed', {}, at)),
            ).toBe('removed');
        });

        it('a later change for the person is applied after an earlier one', async () => {
            const { bob, organization } = await seed();
            const sync = service();

            await sync.apply(envelope('01JD0000000000000000000001', 'created'));
            await sync.apply(
                envelope('01JD0000000000000000000002', 'removed', {}, '2026-11-03T10:00:00Z'),
            );

            expect(flow.removeMemberForPlatform).toHaveBeenCalledWith(organization.id, bob.id);
            expect(await syncRows()).toEqual([
                expect.objectContaining({ lastChange: 'removed', outcome: 'removed' }),
            ]);
        });

        it('only an active link of this installation, and only a person with an account here', async () => {
            const { organization } = await seed();
            const sync = service();

            expect(
                await sync.apply(
                    envelope('01JD0000000000000000000001', 'created', {
                        tenant_link_id: '01JC5M2R4T6V8X0Z2B4D6F8H0Z',
                    }),
                ),
            ).toBe('link_unknown');
            expect(
                await sync.apply(
                    envelope('01JD0000000000000000000002', 'created', {
                        identity_subject: 'sub-nobody',
                    }),
                ),
            ).toBe('person_unknown');

            await dataSource
                .getRepository(EverConnectLink)
                .update({ organizationId: organization.id }, { status: 'archived' });
            expect(await sync.apply(envelope('01JD0000000000000000000003', 'created'))).toBe(
                'link_unknown',
            );

            expect(flow.addMemberForPlatform).not.toHaveBeenCalled();
            expect(await syncRows()).toEqual([]);
        });

        it("a local account named in the envelope must be the identity's own", async () => {
            const { ada, bob, organization } = await seed();
            const sync = service();

            expect(
                await sync.apply(
                    envelope('01JD0000000000000000000001', 'created', { product_user_ref: ada.id }),
                ),
            ).toBe('person_mismatch');
            expect(flow.addMemberForPlatform).not.toHaveBeenCalled();

            expect(
                await sync.apply(
                    envelope('01JD0000000000000000000002', 'created', { product_user_ref: bob.id }),
                ),
            ).toBe('added');
            expect(flow.addMemberForPlatform).toHaveBeenCalledWith(
                organization.id,
                bob.id,
                'admin',
            );
        });

        it('an issuer written with a trailing slash is the same issuer', async () => {
            const { bob } = await seed();
            expect(
                await service().apply(
                    envelope('01JD0000000000000000000001', 'created', {
                        identity_issuer: `${ISSUER}/`,
                    }),
                ),
            ).toBe('added');
            expect(flow.addMemberForPlatform).toHaveBeenCalledWith(
                expect.any(String),
                bob.id,
                'admin',
            );
        });

        it("another shape (the organization audiences') or a malformed envelope changes nothing", async () => {
            await seed();
            const sync = service();

            const orgShape = {
                ...envelope('01JD0000000000000000000001', 'created'),
                data: {
                    org_id: '01JNB79NZW2S85GF4A96MMX6BT',
                    person_id: '01JBX1A2B3C4D5E6F7G8H9J0P1',
                    role: 'admin',
                },
            };
            expect(await sync.apply(orgShape)).toBe('malformed');
            expect(
                await sync.apply(
                    envelope('01JD0000000000000000000002', 'created', {
                        identity_issuer: 'http://id.example.test',
                    }),
                ),
            ).toBe('malformed');
            expect(await sync.apply({ ...envelope('not-an-id', 'created') })).toBe('malformed');
            expect(
                await sync.apply({
                    id: '01JD0000000000000000000003',
                    type: 'ever.registry.membership.created',
                    data: null,
                }),
            ).toBe('malformed');

            expect(flow.addMemberForPlatform).not.toHaveBeenCalled();
            expect(await syncRows()).toEqual([]);
        });

        it('a database failure is thrown, so the feed reads the envelope again', async () => {
            await seed();
            flow.addMemberForPlatform.mockRejectedValueOnce(new Error('database is down'));
            const sync = service();
            const added = envelope('01JD0000000000000000000001', 'created');

            await expect(sync.apply(added)).rejects.toThrow('database is down');
            expect(await syncRows()).toEqual([]);
            expect(await sync.apply(added)).toBe('added');
        });
    });
});
