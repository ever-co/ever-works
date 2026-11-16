// The account deletion reaches the Work, billing and storage layers through
// optional providers; their barrels pull the whole API graph into a unit test
// (as in `account-deletion.service.spec.ts`). The account-deletion module pulls
// in the auth stack; the switch needs its name only.
jest.mock('@ever-works/agent/services', () => ({
    WorkLifecycleService: class WorkLifecycleService {},
}));
jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingService: class BillingService {},
    PaygService: class PaygService {},
    NoActiveSubscriptionError: class NoActiveSubscriptionError extends Error {},
    BillingProviderNotConfiguredError: class BillingProviderNotConfiguredError extends Error {},
}));
jest.mock('../../../uploads/storage-backend.factory', () => ({
    getActiveStorageBackend: jest.fn(),
}));
jest.mock('../../../account-deletion/account-deletion.module', () => ({
    AccountDeletionModule: class AccountDeletionModule {},
}));

import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { subjectHash } from '@ever-co/connect-sdk';
import type { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    ExternalIdentity,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
} from '@ever-works/agent/entities';
import { AccountDeletionService } from '../../../account-deletion/account-deletion.service';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import { PersonRequestsHandler } from '../../identity/person-requests.handler';
import { createIdentityDataSource, insertIdentity } from '../../identity/__tests__/db.helper-spec';
import { FakePlatform } from '../../identity/__tests__/fakes.helper-spec';
import {
    addLink,
    addMember,
    addUser,
    addWork,
    addWorkspace,
    clearPeople,
} from '../../__tests__/people.helper-spec';
import {
    EverConnectPersonDeletionModule,
    everConnectPersonDeletionModuleImports,
} from '../person-deletion.module';
import { PersonDeletionParticipantService } from '../person-deletion.participant';

/**
 * A person's deletion for Ever Platform (`EVER_CONNECT_PERSON_DELETION_ENABLED`),
 * through the account deletion of Settings → Danger Zone.
 *
 * - Off (the default): nothing is registered and nothing is deleted beyond the
 *   connected identities; the answer stays `failed` / `account_deletion_pending`.
 * - On: only the accounts the request matched go. Another person's account,
 *   Works and identities are untouched; a workspace with other people in it
 *   keeps existing (handed to one of them); a workspace that would go while it
 *   holds an Organization linked to Ever Platform, or an installation
 *   administrator, holds the whole request (nothing deleted, `pending`).
 */
describe('Ever Connect — person deletion', () => {
    const ISSUER = 'https://id.example.test';
    const JOB = '01K6A7S2ABCDEFGHJKMNPQRSTV';
    const SWITCHES = ['EVER_CONNECT_ENABLED', 'EVER_CONNECT_PERSON_DELETION_ENABLED'];
    let dataSource: DataSource;
    let accounts: AccountDeletionService;
    let execute: jest.SpyInstance;
    let mailer: { sendDeletedConfirmation: jest.Mock };
    let saved: Record<string, string | undefined>;

    const switchOn = () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_PERSON_DELETION_ENABLED = 'true';
    };

    const deletion = (hashes: string[]) => ({
        id: `evt-${JOB}`,
        type: 'ever.registry.person.deletion_requested',
        data: {
            person_id: '01JMQCKPERS0N00000000000P1',
            job_id: JOB,
            respond_by: '2026-11-30T00:00:00Z',
            subject_hashes: hashes,
        },
    });

    /** The request handler with the participant registered as the module does it. */
    function wired() {
        const extensions = new EverConnectExtensions();
        const participant = new PersonDeletionParticipantService(dataSource, accounts, extensions);
        participant.onModuleInit();
        const platform = new FakePlatform().answer('instanceAckRequest', undefined);
        const activity = { log: jest.fn().mockResolvedValue({}) };
        const handler = new PersonRequestsHandler(
            platform,
            dataSource,
            activity as unknown as ActivityLogService,
            undefined,
            extensions,
        );
        return { handler, platform, activity, extensions, participant };
    }

    const exists = async (entity: EntityTarget<ObjectLiteral>, id: string) =>
        (await dataSource.getRepository(entity).count({ where: { id } })) === 1;

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
        mailer = { sendDeletedConfirmation: jest.fn().mockResolvedValue(undefined) };
        accounts = new AccountDeletionService(
            dataSource,
            {
                insert: jest.fn().mockResolvedValue({}),
                update: jest.fn().mockResolvedValue(undefined),
                clearUser: jest.fn().mockResolvedValue(undefined),
            } as never,
            mailer as never,
            {
                get: () => {
                    throw new UnknownElementException();
                },
            } as never,
        );
        execute = jest.spyOn(accounts, 'execute');
    });

    afterEach(() => {
        for (const name of SWITCHES) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
        execute.mockRestore();
    });

    describe('switched off (the default)', () => {
        it('no module, nothing registered: the identities go, the account stays', async () => {
            expect(everConnectPersonDeletionModuleImports({})).toEqual([]);
            expect(
                everConnectPersonDeletionModuleImports({ EVER_CONNECT_ENABLED: 'true' }),
            ).toEqual([]);
            expect(
                everConnectPersonDeletionModuleImports({
                    EVER_CONNECT_PERSON_DELETION_ENABLED: 'true',
                }),
            ).toEqual([]);

            const ada = await addUser(dataSource, 'ada');
            const { tenant } = await addWorkspace(dataSource, ada, 'ada-co');
            await insertIdentity(dataSource, {
                userId: ada.id,
                issuer: ISSUER,
                subject: 'sub-ada',
            });
            const { handler, platform, extensions } = wired();
            expect(extensions.personDataParticipant()).toBeNull();

            const answer = await handler.handle(deletion([subjectHash(ISSUER, 'sub-ada')]));

            expect(answer).toMatchObject({
                result: 'failed',
                reasonCode: 'account_deletion_pending',
            });
            expect(platform.callsOf('instanceAckRequest')[0].input?.body).toEqual({
                job_id: JOB,
                result: 'failed',
                detail: { reason_code: 'account_deletion_pending' },
            });
            expect(execute).not.toHaveBeenCalled();
            expect(await exists(User, ada.id)).toBe(true);
            expect(await exists(Tenant, tenant.id)).toBe(true);
            expect(mailer.sendDeletedConfirmation).not.toHaveBeenCalled();
        });

        it('a direct call deletes nothing', async () => {
            const ada = await addUser(dataSource, 'ada');
            const participant = new PersonDeletionParticipantService(dataSource, accounts);
            expect(participant.participant()).toBeNull();
            expect(
                await participant.deleteAccounts({ userIds: [ada.id], jobId: JOB, respondBy: '' }),
            ).toEqual({ result: 'pending' });
            expect(execute).not.toHaveBeenCalled();
            expect(await exists(User, ada.id)).toBe(true);
        });
    });

    describe('switched on', () => {
        beforeEach(switchOn);

        it('the module is imported and the participant offers deletion only', () => {
            expect(everConnectPersonDeletionModuleImports(process.env)).toEqual([
                EverConnectPersonDeletionModule,
            ]);
            const { extensions } = wired();
            const registered = extensions.personDataParticipant();
            expect(typeof registered?.deleteAccounts).toBe('function');
            expect(registered?.exportAccounts).toBeUndefined();
        });

        it("a member's account goes; the workspace, its owner and their data stay", async () => {
            const ada = await addUser(dataSource, 'ada');
            const { tenant, organization } = await addWorkspace(dataSource, ada, 'ada-co');
            const adaWork = await addWork(dataSource, ada, 'ada-app', {
                tenantId: tenant.id,
                organizationId: organization.id,
            });
            const bob = await addUser(dataSource, 'bob');
            await addMember(dataSource, bob, organization, 'admin');
            const bobInWorkspace = await addWork(dataSource, bob, 'bob-in-ada-co', {
                tenantId: tenant.id,
                organizationId: organization.id,
            });
            await insertIdentity(dataSource, {
                userId: ada.id,
                issuer: ISSUER,
                subject: 'sub-ada',
            });
            await insertIdentity(dataSource, {
                userId: bob.id,
                issuer: ISSUER,
                subject: 'sub-bob',
            });
            const { handler, platform } = wired();

            const answer = await handler.handle(deletion([subjectHash(ISSUER, 'sub-bob')]));

            expect(answer).toMatchObject({ result: 'deleted', reasonCode: null });
            expect(platform.callsOf('instanceAckRequest')[0].input?.body).toEqual({
                job_id: JOB,
                result: 'deleted',
            });
            expect(execute).toHaveBeenCalledTimes(1);
            expect(execute).toHaveBeenCalledWith(bob.id, { source: 'ever_platform' });
            expect(await exists(User, bob.id)).toBe(false);
            // Everyone and everything else stays.
            expect(await exists(User, ada.id)).toBe(true);
            expect(await exists(Tenant, tenant.id)).toBe(true);
            expect(await exists(Organization, organization.id)).toBe(true);
            const works = dataSource.getRepository(Work);
            expect(await works.findOne({ where: { id: adaWork.id } })).toMatchObject({
                userId: ada.id,
            });
            // What Bob made in the workspace is handed to its owner, not deleted.
            expect(await works.findOne({ where: { id: bobInWorkspace.id } })).toMatchObject({
                userId: ada.id,
                tenantId: tenant.id,
            });
            const identities = await dataSource.getRepository(ExternalIdentity).find();
            expect(identities.map((identity) => identity.subject)).toEqual(['sub-ada']);
        });

        it('an owner leaves; the workspace with another member keeps existing, handed to them', async () => {
            const ada = await addUser(dataSource, 'ada');
            const { tenant, organization } = await addWorkspace(dataSource, ada, 'ada-co');
            const adaWork = await addWork(dataSource, ada, 'ada-app', {
                tenantId: tenant.id,
                organizationId: organization.id,
            });
            const bob = await addUser(dataSource, 'bob');
            await addMember(dataSource, bob, organization, 'admin');
            const bobWork = await addWork(dataSource, bob, 'bob-own');
            await insertIdentity(dataSource, {
                userId: ada.id,
                issuer: ISSUER,
                subject: 'sub-ada',
            });
            await insertIdentity(dataSource, {
                userId: bob.id,
                issuer: ISSUER,
                subject: 'sub-bob',
            });
            const { handler } = wired();

            const answer = await handler.handle(deletion([subjectHash(ISSUER, 'sub-ada')]));

            expect(answer).toMatchObject({ result: 'deleted' });
            expect(await exists(User, ada.id)).toBe(false);
            expect(await exists(User, bob.id)).toBe(true);
            expect(await exists(Organization, organization.id)).toBe(true);
            expect(
                await dataSource.getRepository(Tenant).findOne({ where: { id: tenant.id } }),
            ).toMatchObject({ ownerUserId: bob.id });
            const works = dataSource.getRepository(Work);
            expect(await works.findOne({ where: { id: adaWork.id } })).toMatchObject({
                userId: bob.id,
            });
            expect(await works.findOne({ where: { id: bobWork.id } })).toMatchObject({
                userId: bob.id,
            });
            expect(
                await dataSource
                    .getRepository(OrganizationMember)
                    .count({ where: { userId: bob.id } }),
            ).toBe(1);
        });

        it("a workspace only the person is in goes with them; another person's stays", async () => {
            const ada = await addUser(dataSource, 'ada');
            const { tenant, organization } = await addWorkspace(dataSource, ada, 'ada-co');
            const carol = await addUser(dataSource, 'carol');
            const carolSpace = await addWorkspace(dataSource, carol, 'carol-co');
            const carolWork = await addWork(dataSource, carol, 'carol-app', {
                tenantId: carolSpace.tenant.id,
            });
            await insertIdentity(dataSource, {
                userId: ada.id,
                issuer: ISSUER,
                subject: 'sub-ada',
            });
            const { handler } = wired();

            expect(await handler.handle(deletion([subjectHash(ISSUER, 'sub-ada')]))).toMatchObject({
                result: 'deleted',
            });

            expect(await exists(User, ada.id)).toBe(false);
            expect(await exists(Tenant, tenant.id)).toBe(false);
            expect(await exists(Organization, organization.id)).toBe(false);
            expect(await exists(User, carol.id)).toBe(true);
            expect(await exists(Tenant, carolSpace.tenant.id)).toBe(true);
            expect(await exists(Organization, carolSpace.organization.id)).toBe(true);
            expect(
                await dataSource.getRepository(Work).count({ where: { id: carolWork.id } }),
            ).toBe(1);
        });

        it('a workspace that would go while it holds a linked Organization holds the request', async () => {
            const ada = await addUser(dataSource, 'ada');
            const { tenant, organization } = await addWorkspace(dataSource, ada, 'ada-co');
            await addLink(dataSource, organization, '01JC5M2R4T6V8X0Z2B4D6F8H0K');
            await insertIdentity(dataSource, {
                userId: ada.id,
                issuer: ISSUER,
                subject: 'sub-ada',
            });
            const { handler, activity } = wired();

            const answer = await handler.handle(deletion([subjectHash(ISSUER, 'sub-ada')]));

            expect(answer).toMatchObject({
                result: 'failed',
                reasonCode: 'account_deletion_pending',
            });
            expect(execute).not.toHaveBeenCalled();
            expect(await exists(User, ada.id)).toBe(true);
            expect(await exists(Tenant, tenant.id)).toBe(true);
            expect(await exists(Organization, organization.id)).toBe(true);
            // As without a participant: the account's Activity says it is kept.
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: ada.id,
                    action: 'ever_connect.person_deletion.account_pending',
                }),
            );
        });

        it('an installation administrator is never deleted from here', async () => {
            const ada = await addUser(dataSource, 'ada', { isPlatformAdmin: true });
            await insertIdentity(dataSource, {
                userId: ada.id,
                issuer: ISSUER,
                subject: 'sub-ada',
            });
            const { participant } = wired();

            expect(await participant.holdFor(ada.id)).toBe('platform_admin');
            expect(
                await participant.deleteAccounts({ userIds: [ada.id], jobId: JOB, respondBy: '' }),
            ).toEqual({ result: 'pending' });
            expect(execute).not.toHaveBeenCalled();
            expect(await exists(User, ada.id)).toBe(true);
        });

        it('all or none: one account that must be kept holds the others too', async () => {
            const ada = await addUser(dataSource, 'ada', { isPlatformAdmin: true });
            const second = await addUser(dataSource, 'ada-second');
            const { participant } = wired();

            expect(
                await participant.deleteAccounts({
                    userIds: [second.id, ada.id],
                    jobId: JOB,
                    respondBy: '',
                }),
            ).toEqual({ result: 'pending' });
            expect(execute).not.toHaveBeenCalled();
            expect(await exists(User, second.id)).toBe(true);
        });

        it('an account already gone counts as deleted', async () => {
            const { participant } = wired();
            expect(
                await participant.deleteAccounts({
                    userIds: ['3f1c1d4a-7b2e-4f0a-9d3c-2a6b1e5f8c01'],
                    jobId: JOB,
                    respondBy: '',
                }),
            ).toEqual({ result: 'deleted' });
            expect(execute).not.toHaveBeenCalled();
        });
    });
});
