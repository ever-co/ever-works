// The Organization module pulls in the whole auth stack, and the membership
// code its own graph; the resync needs their names only (the membership code's
// rules have their own spec: `organization-member-platform.spec.ts`).
jest.mock('../../../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));
jest.mock('../../../organizations/organization-invitation-flow.service', () => ({
    OrganizationInvitationFlowService: class OrganizationInvitationFlowService {},
}));

import { Logger } from '@nestjs/common';
import { ProblemError, type OperationSpec } from '@ever-co/connect-sdk';
import type { DataSource } from 'typeorm';
import { EverConnectMembershipSync } from '@ever-works/agent/entities';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import { EverConnectFeedService } from '../../ever-connect-feed.service';
import type { EverConnectIntegrationService } from '../../ever-connect-integration.service';
import type { EverConnectService } from '../../ever-connect.service';
import type { PersonRequestsHandler } from '../../identity/person-requests.handler';
import { createIdentityDataSource, insertIdentity } from '../../identity/__tests__/db.helper-spec';
import { addLink, addUser, addWorkspace, clearPeople } from '../../__tests__/people.helper-spec';
import {
    ensureLinkMembershipsOperation,
    LINK_MEMBERSHIPS_OPERATION,
    LinkMembershipsAnswerError,
    readLinkMembershipsPage,
} from '../link-memberships.client';
import { EverConnectMembershipResyncService } from '../membership-resync.service';
import {
    EverConnectMembershipSyncService,
    RESYNC_CHANGE,
    RESYNC_POSITION,
} from '../membership-sync.service';

/**
 * The membership resync (`EVER_CONNECT_MEMBERSHIP_SYNC_ENABLED`): after the
 * feed answered `410 resync_required` (and at each start), the current members
 * of each linked organization are read
 * (`GET /v1/instances/me/tenant-links/{link}/memberships`, 100 a page) and
 * applied with the rules of the membership envelopes.
 *
 * - Every page is read; each member is added, or has their role set when the
 *   sync already keeps them as a member (removed here by hand: not added back).
 * - Once the whole list was read, the people the sync keeps as members but the
 *   list no longer names are removed; nobody else is.
 * - `404 module_disabled`: nothing to resync, logged once.
 * - A failure stops the resync (nobody removed) until the next `410` or start.
 */
describe('Ever Connect — membership resync', () => {
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

    const member = (subject: string, role = 'member', values: Record<string, unknown> = {}) => ({
        identity_issuer: ISSUER,
        identity_subject: subject,
        role,
        ...values,
    });

    /** The pages of a list, each pointing at the next. */
    const pages = (...lists: unknown[][]) =>
        lists.map((items, index) => ({
            tenant_link_id: LINK,
            items,
            next_cursor: index < lists.length - 1 ? `cursor-${index + 1}` : null,
        }));

    /** An SDK client whose `call` answers (or fails) in turn. */
    const platform = (...answers: Array<object | Error>) => {
        const call = jest.fn();
        for (const answer of answers) {
            if (answer instanceof Error) call.mockRejectedValueOnce(answer);
            else call.mockResolvedValueOnce(answer);
        }
        return { call };
    };

    function services(client: { call: jest.Mock }, extensions?: EverConnectExtensions) {
        const connection = {
            connection: jest.fn().mockResolvedValue({ status: 'active' }),
            client: jest.fn().mockResolvedValue(client),
        };
        const sync = new EverConnectMembershipSyncService(dataSource, flow as never, extensions);
        const resync = new EverConnectMembershipResyncService(
            dataSource,
            connection as unknown as EverConnectService,
            sync,
            extensions,
        );
        return { sync, resync, connection };
    }

    /** Ada's workspace, linked; Bob, Cara and Dan have an account and an Ever ID here. */
    async function seed() {
        const ada = await addUser(dataSource, 'ada');
        const { organization } = await addWorkspace(dataSource, ada, 'ada-co');
        await addLink(dataSource, organization, LINK);
        const person = async (name: string) => {
            const user = await addUser(dataSource, name);
            await insertIdentity(dataSource, {
                userId: user.id,
                issuer: ISSUER,
                subject: `sub-${name}`,
            });
            return user;
        };
        const bob = await person('bob');
        const cara = await person('cara');
        const dan = await person('dan');
        return { ada, organization, bob, cara, dan };
    }

    /** What the sync last kept for a person (as an envelope or a resync left it). */
    const keep = (
        organizationId: string,
        userId: string,
        values: Partial<EverConnectMembershipSync> = {},
    ) =>
        dataSource.getRepository(EverConnectMembershipSync).save(
            dataSource.getRepository(EverConnectMembershipSync).create({
                organizationId,
                userId,
                lastEventId: '01JD0000000000000000000001',
                lastOccurredAt: new Date('2026-11-02T10:00:00Z'),
                lastChange: 'created',
                lastRole: 'member',
                outcome: 'added',
                ...values,
            }),
        );

    const rowOf = (userId: string) =>
        dataSource.getRepository(EverConnectMembershipSync).findOne({ where: { userId } });

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
        jest.restoreAllMocks();
        for (const name of SWITCHES) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    });

    describe('switched off (the default)', () => {
        it('joins neither the feed nor the round, and reads nothing', async () => {
            const extensions = new EverConnectExtensions();
            const addListener = jest.spyOn(extensions, 'addResyncListener');
            const addParticipant = jest.spyOn(extensions, 'addRoundParticipant');
            const client = platform();
            const { resync } = services(client, extensions);
            resync.onModuleInit();

            expect(addListener).not.toHaveBeenCalled();
            expect(addParticipant).not.toHaveBeenCalled();
            expect(await resync.resync()).toBe('switched_off');
            expect(client.call).not.toHaveBeenCalled();
        });
    });

    describe('switched on', () => {
        beforeEach(switchOn);

        it('reads every page and applies each member with the rules of the envelopes', async () => {
            const { organization, bob, cara, dan } = await seed();
            const client = platform(
                ...pages(
                    [member('sub-bob', 'admin'), member('sub-cara')],
                    [member('sub-dan', 'owner', { product_user_ref: dan.id })],
                ),
            );
            const { resync } = services(client);

            expect(await resync.resync()).toBe('done');

            expect(client.call.mock.calls).toEqual([
                [
                    LINK_MEMBERSHIPS_OPERATION,
                    { path: { link: LINK }, query: { limit: 100, cursor: undefined } },
                ],
                [
                    LINK_MEMBERSHIPS_OPERATION,
                    { path: { link: LINK }, query: { limit: 100, cursor: 'cursor-1' } },
                ],
            ]);
            expect(flow.addMemberForPlatform.mock.calls).toEqual([
                [organization.id, bob.id, 'admin'],
                [organization.id, cara.id, 'member'],
                [organization.id, dan.id, 'admin'],
            ]);
            expect(flow.removeMemberForPlatform).not.toHaveBeenCalled();
            // Placed before every envelope: the next one for them is applied.
            expect(await rowOf(bob.id)).toEqual(
                expect.objectContaining({
                    lastEventId: RESYNC_POSITION,
                    lastOccurredAt: null,
                    lastChange: RESYNC_CHANGE,
                    lastRole: 'admin',
                    outcome: 'added',
                }),
            );
            expect(resync.isOwed()).toBe(false);
        });

        it('the next envelope is applied after a resync', async () => {
            const { bob } = await seed();
            const { sync, resync } = services(platform(...pages([member('sub-bob')])));
            await resync.resync();

            expect(
                await sync.apply({
                    id: '01JD0000000000000000000002',
                    type: 'ever.registry.membership.removed',
                    data: {
                        tenant_link_id: LINK,
                        identity_issuer: ISSUER,
                        identity_subject: 'sub-bob',
                        role: 'member',
                    },
                }),
            ).toBe('removed');
            expect(await rowOf(bob.id)).toEqual(
                expect.objectContaining({ lastEventId: '01JD0000000000000000000002' }),
            );
        });

        it('a member the sync keeps only has their role set; removed here by hand, not added back', async () => {
            const { organization, bob, cara } = await seed();
            await keep(organization.id, bob.id);
            await keep(organization.id, cara.id, { outcome: 'unchanged' });
            // Cara was removed from the Organization here by hand.
            flow.setMemberRoleForPlatform.mockImplementation(async (_org, userId) =>
                userId === cara.id ? 'not_a_member' : 'role_set',
            );
            const { resync } = services(
                platform(...pages([member('sub-bob', 'admin'), member('sub-cara')])),
            );

            expect(await resync.resync()).toBe('done');

            expect(flow.addMemberForPlatform).not.toHaveBeenCalled();
            expect(flow.setMemberRoleForPlatform.mock.calls).toEqual([
                [organization.id, bob.id, 'admin'],
                [organization.id, cara.id, 'member'],
            ]);
            // Bob's row keeps his last envelope's position.
            expect(await rowOf(bob.id)).toEqual(
                expect.objectContaining({
                    lastEventId: '01JD0000000000000000000001',
                    lastChange: RESYNC_CHANGE,
                    lastRole: 'admin',
                    outcome: 'role_set',
                }),
            );
            // Cara's row is left as it was, so the next resync does not add her either.
            expect(await rowOf(cara.id)).toEqual(
                expect.objectContaining({ lastChange: 'created', outcome: 'unchanged' }),
            );
        });

        it('removes those the sync keeps as members whom the list no longer names, and nobody else', async () => {
            const { organization, bob, cara, dan } = await seed();
            // Bob and Cara: kept by the sync. Dan: joined here otherwise (no row).
            await keep(organization.id, bob.id);
            await keep(organization.id, cara.id, { outcome: 'unchanged' });
            // Erin: kept by the sync, but no Ever ID of hers is known here.
            const erin = await addUser(dataSource, 'erin');
            await keep(organization.id, erin.id);
            // Finn: the sync removed him already.
            const finn = await addUser(dataSource, 'finn');
            await insertIdentity(dataSource, {
                userId: finn.id,
                issuer: ISSUER,
                subject: 'sub-finn',
            });
            await keep(organization.id, finn.id, { lastChange: 'removed', outcome: 'removed' });
            const { resync } = services(platform(...pages([member('sub-cara')])));

            expect(await resync.resync()).toBe('done');

            expect(flow.removeMemberForPlatform.mock.calls).toEqual([[organization.id, bob.id]]);
            expect(await rowOf(bob.id)).toEqual(
                expect.objectContaining({
                    lastEventId: '01JD0000000000000000000001',
                    lastChange: RESYNC_CHANGE,
                    outcome: 'removed',
                }),
            );
            expect(await rowOf(dan.id)).toBeNull();
            expect(await rowOf(erin.id)).toEqual(expect.objectContaining({ outcome: 'added' }));
        });

        it('an empty list, or one with an item it cannot read, removes nobody', async () => {
            const { organization, bob } = await seed();
            await keep(organization.id, bob.id);

            const empty = services(platform(...pages([])));
            expect(await empty.resync.resync()).toBe('done');
            const unreadable = services(
                platform(...pages([member('sub-cara'), { identity_subject: 'sub-bob' }])),
            );
            expect(await unreadable.resync.resync()).toBe('done');

            expect(flow.addMemberForPlatform).toHaveBeenCalledTimes(1);
            expect(flow.removeMemberForPlatform).not.toHaveBeenCalled();
        });

        it('404 module_disabled: nothing to resync, logged once', async () => {
            await seed();
            const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
            const client = platform(
                new ProblemError(404, 'module_disabled'),
                new ProblemError(404, 'module_disabled'),
            );
            const { resync } = services(client);

            expect(await resync.resync()).toBe('module_disabled');
            resync.resyncRequired();
            expect(await resync.resync()).toBe('module_disabled');

            expect(client.call).toHaveBeenCalledTimes(2);
            expect(flow.addMemberForPlatform).not.toHaveBeenCalled();
            expect(
                log.mock.calls.filter(([message]) => String(message).includes('module_disabled')),
            ).toHaveLength(1);
            expect(resync.isOwed()).toBe(false);
        });

        it('a link Ever Platform does not know as active is skipped; the others are read', async () => {
            const { organization, bob } = await seed();
            const ada2 = await addUser(dataSource, 'ada2');
            const other = await addWorkspace(dataSource, ada2, 'ada2-co');
            await addLink(dataSource, other.organization, '01JC5M2R4T6V8X0Z2B4D6F8H0M');
            await keep(organization.id, bob.id);
            const client = jest.fn(async (_id: string, input: { path: { link: string } }) => {
                if (input.path.link === LINK) throw new ProblemError(404, 'not_found');
                return { items: [member('sub-cara')], next_cursor: null };
            });
            const { resync } = services({ call: client as unknown as jest.Mock });

            expect(await resync.resync()).toBe('done');

            expect(client).toHaveBeenCalledTimes(2);
            expect(flow.addMemberForPlatform).toHaveBeenCalledWith(
                other.organization.id,
                expect.any(String),
                'member',
            );
            expect(flow.removeMemberForPlatform).not.toHaveBeenCalled();
        });

        it('an error mid-way stops the resync, removes nobody, and it runs again at the next 410', async () => {
            const { organization, bob, cara } = await seed();
            await keep(organization.id, bob.id);
            const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const first = pages([member('sub-cara')], [member('sub-dan')]);
            const client = platform(first[0], new ProblemError(503, 'unavailable'));
            const extensions = new EverConnectExtensions();
            const { resync } = services(client, extensions);
            resync.onModuleInit();

            expect(await resync.resync()).toBe('failed');
            expect(flow.addMemberForPlatform.mock.calls).toEqual([
                [organization.id, cara.id, 'member'],
            ]);
            expect(flow.removeMemberForPlatform).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalled();
            expect(resync.isOwed()).toBe(false);

            // Not owed: the next round reads nothing.
            await extensions.runRound(new Date());
            expect(client.call).toHaveBeenCalledTimes(2);

            // The feed answers 410 again: the next round reads the list from the start.
            client.call.mockResolvedValueOnce(pages([member('sub-cara')])[0]);
            extensions.feedResyncRequired();
            expect(resync.isOwed()).toBe(true);
            await extensions.runRound(new Date());
            expect(client.call).toHaveBeenCalledTimes(3);
            expect(client.call.mock.calls[2][1]).toEqual({
                path: { link: LINK },
                query: { limit: 100, cursor: undefined },
            });
            expect(flow.removeMemberForPlatform.mock.calls).toEqual([[organization.id, bob.id]]);
            expect(resync.isOwed()).toBe(false);
        });

        it('owed at start; waits while the installation is not active; stays owed when the lease is lost', async () => {
            await seed();
            const client = platform(...pages([member('sub-bob')], [member('sub-cara')]));
            const { resync, connection } = services(client);
            expect(resync.isOwed()).toBe(true);

            connection.connection.mockResolvedValueOnce({ status: 'pending_approval' });
            expect(await resync.resync()).toBe('not_connected');
            expect(resync.isOwed()).toBe(true);
            expect(client.call).not.toHaveBeenCalled();

            jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            let renewals = 0;
            const lease = { keep: async () => ++renewals < 2, held: true };
            expect(await resync.resync(lease)).toBe('lease_lost');
            expect(client.call).toHaveBeenCalledTimes(1);
            expect(resync.isOwed()).toBe(true);
        });

        it('a 410 on the feed makes the resync owed', async () => {
            const extensions = new EverConnectExtensions();
            const { resync } = services(platform(), extensions);
            resync.onModuleInit();
            await resync.resync();
            expect(resync.isOwed()).toBe(false);

            const instances = {
                events: jest
                    .fn()
                    .mockRejectedValue(
                        new ProblemError(
                            410,
                            'resync_required',
                            undefined,
                            null,
                            undefined,
                            undefined,
                            'evt-90',
                        ),
                    ),
                ackEvents: jest.fn().mockResolvedValue({}),
            };
            const feed = new EverConnectFeedService(
                {
                    client: jest.fn().mockResolvedValue({ instances }),
                    connection: jest.fn().mockResolvedValue({ lastFeedCursor: 'evt-0' }),
                    saveFeedCursor: jest.fn().mockResolvedValue(undefined),
                } as unknown as EverConnectService,
                {
                    refresh: jest.fn().mockResolvedValue([]),
                } as unknown as EverConnectIntegrationService,
                { handles: () => false } as unknown as PersonRequestsHandler,
                undefined,
                extensions,
            );

            expect(await feed.pollOnce(0)).toEqual({ handled: 0, more: true });
            expect(resync.isOwed()).toBe(true);
        });
    });

    describe('the call', () => {
        it('adds the operation to the SDK table once, and keeps one the SDK has', () => {
            const table: Record<string, OperationSpec> = {};
            ensureLinkMembershipsOperation(table);
            expect(table[LINK_MEMBERSHIPS_OPERATION]).toEqual(
                expect.objectContaining({
                    method: 'GET',
                    path: '/v1/instances/me/tenant-links/{link}/memberships',
                    pathParams: ['link'],
                    query: ['cursor', 'limit'],
                    auth: 'instance',
                    success: [200],
                }),
            );

            const own = { id: LINK_MEMBERSHIPS_OPERATION } as OperationSpec;
            const shipped: Record<string, OperationSpec> = { [LINK_MEMBERSHIPS_OPERATION]: own };
            ensureLinkMembershipsOperation(shipped);
            expect(shipped[LINK_MEMBERSHIPS_OPERATION]).toBe(own);
        });

        it('answers a page; an answer that is not one is an error', async () => {
            const client = platform(
                { items: [member('sub-bob')], next_cursor: 'c-2' },
                { items: [], next_cursor: null },
                { next_cursor: null },
                { items: [], next_cursor: 7 },
            );
            await expect(readLinkMembershipsPage(client as never, LINK, null)).resolves.toEqual({
                items: [member('sub-bob')],
                nextCursor: 'c-2',
            });
            await expect(readLinkMembershipsPage(client as never, LINK, 'c-2')).resolves.toEqual({
                items: [],
                nextCursor: null,
            });
            await expect(
                readLinkMembershipsPage(client as never, LINK, null),
            ).rejects.toBeInstanceOf(LinkMembershipsAnswerError);
            await expect(
                readLinkMembershipsPage(client as never, LINK, null),
            ).rejects.toBeInstanceOf(LinkMembershipsAnswerError);
        });
    });
});
