import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { subjectHash } from '@ever-co/connect-sdk';
import type { DataSource } from 'typeorm';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    ApiKey,
    EverConnectPersonRequest,
    ExternalIdentity,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
    WorkMember,
} from '@ever-works/agent/entities';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import { PersonRequestsHandler } from '../../identity/person-requests.handler';
import { createIdentityDataSource, insertIdentity } from '../../identity/__tests__/db.helper-spec';
import { FakePlatform } from '../../identity/__tests__/fakes.helper-spec';
import { PersonDataExportBuilder } from '../person-data-export.builder';
import {
    EverConnectPersonDataModule,
    everConnectPersonDataModuleImports,
} from '../person-data.module';
import {
    PERSON_EXPORT_LINK_DAYS,
    PersonDataParticipantService,
    personExportUrl,
} from '../person-data.participant';

/**
 * A person's export for Ever Platform (`EVER_CONNECT_PERSON_EXPORT_ENABLED`).
 *
 * - Off (the default): no module, nothing registered, the request handler
 *   answers `failed` / `export_not_available` exactly as before, and the
 *   download answers 404.
 * - On: the answer is `exported` with the web app's address for the job; the
 *   document is built when the signed-in person opens it, and holds their own
 *   account only: profile, identities, workspaces and Organizations with their
 *   own role, the Works they own and the ones they are a member of, their
 *   settings. Never another member, a password, a token or a key.
 */
describe('Ever Connect — person export', () => {
    const ISSUER = 'https://id.example.test';
    const WEB = 'https://works.example.test';
    const JOB = '01K6A7S2ABCDEFGHJKMNPQRSTV';
    const SWITCHES = ['EVER_CONNECT_ENABLED', 'EVER_CONNECT_PERSON_EXPORT_ENABLED', 'WEB_URL'];
    let dataSource: DataSource;
    let saved: Record<string, string | undefined>;

    const switchOn = () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_PERSON_EXPORT_ENABLED = 'true';
        process.env.WEB_URL = WEB;
    };

    const service = () =>
        new PersonDataParticipantService(
            dataSource,
            new PersonDataExportBuilder(dataSource),
            new EverConnectExtensions(),
        );

    const exportRequest = (jobId: string, hashes: string[]) => ({
        id: `evt-${jobId}`,
        type: 'ever.registry.person.export_requested',
        data: {
            person_id: '01JMQCKPERS0N00000000000P1',
            job_id: jobId,
            respond_by: '2026-11-30T00:00:00Z',
            subject_hashes: hashes,
        },
    });

    /** Two people in one workspace: Ada owns it, Bob was invited. */
    async function seed() {
        const users = dataSource.getRepository(User);
        const ada = await users.save(
            users.create({
                id: randomUUID(),
                username: 'ada',
                slug: 'ada',
                email: 'ada@example.test',
                password: 'hash-of-adas-password',
                passwordResetToken: 'adas-reset-token',
                displayName: 'Ada',
                lastLoginIp: '203.0.113.7',
            } as Partial<User>),
        );
        const bob = await users.save(
            users.create({
                id: randomUUID(),
                username: 'bob',
                slug: 'bob',
                email: 'bob@example.test',
            } as Partial<User>),
        );
        const tenant = await dataSource.getRepository(Tenant).save(
            dataSource.getRepository(Tenant).create({
                id: randomUUID(),
                ownerUserId: ada.id,
                slug: 'ada-co',
                displayName: 'Ada Co',
            }),
        );
        await users.update({ id: ada.id }, { tenantId: tenant.id });
        await users.update({ id: bob.id }, { tenantId: tenant.id });
        const organization = await dataSource.getRepository(Organization).save(
            dataSource.getRepository(Organization).create({
                id: randomUUID(),
                tenantId: tenant.id,
                slug: 'ada-co',
                displayName: 'Ada Co',
            } as Partial<Organization>),
        );
        await dataSource.getRepository(OrganizationMember).save(
            dataSource.getRepository(OrganizationMember).create({
                organizationId: organization.id,
                tenantId: tenant.id,
                userId: bob.id,
                role: 'admin',
                joinedAt: new Date('2026-10-01T00:00:00Z'),
            }),
        );
        const works = dataSource.getRepository(Work);
        const adaApp = await works.save(
            works.create({
                userId: ada.id,
                name: 'Ada App',
                slug: 'ada-app',
                owner: 'ada',
                description: 'an app',
                tenantId: tenant.id,
                organizationId: organization.id,
            } as Partial<Work>),
        );
        const bobSite = await works.save(
            works.create({
                userId: bob.id,
                name: 'Bob Site',
                slug: 'bob-site',
                owner: 'bob',
                description: 'a site',
            } as Partial<Work>),
        );
        await dataSource.getRepository(WorkMember).save(
            dataSource.getRepository(WorkMember).create({
                workId: bobSite.id,
                userId: ada.id,
                role: 'editor',
            } as Partial<WorkMember>),
        );
        await dataSource.getRepository(ApiKey).save(
            dataSource.getRepository(ApiKey).create({
                userId: ada.id,
                name: 'laptop',
                hashedKey: 'hashed-secret-of-the-key',
                prefix: 'ew_live_ab',
            } as Partial<ApiKey>),
        );
        await insertIdentity(dataSource, { userId: ada.id, issuer: ISSUER, subject: 'sub-ada' });
        await insertIdentity(dataSource, { userId: bob.id, issuer: ISSUER, subject: 'sub-bob' });
        return { ada, bob, tenant, organization, adaApp, bobSite };
    }

    async function answered(values: Partial<EverConnectPersonRequest>) {
        const repository = dataSource.getRepository(EverConnectPersonRequest);
        return repository.save(
            repository.create({
                jobId: JOB,
                eventId: 'evt',
                kind: 'export',
                result: 'exported',
                reasonCode: null,
                legalBasis: null,
                exportUrl: personExportUrl(JOB, WEB),
                answeredAt: new Date(),
                ...values,
            }),
        );
    }

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        saved = Object.fromEntries(SWITCHES.map((name) => [name, process.env[name]]));
        for (const name of SWITCHES) delete process.env[name];
        for (const entity of [
            ApiKey,
            WorkMember,
            Work,
            OrganizationMember,
            Organization,
            Tenant,
            ExternalIdentity,
            EverConnectPersonRequest,
            User,
        ]) {
            await dataSource.getRepository(entity).clear();
        }
    });

    afterEach(() => {
        for (const name of SWITCHES) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    });

    describe('switched off (the default)', () => {
        it('no module, nothing registered, the answer stays export_not_available', async () => {
            expect(everConnectPersonDataModuleImports({})).toEqual([]);
            expect(everConnectPersonDataModuleImports({ EVER_CONNECT_ENABLED: 'true' })).toEqual(
                [],
            );
            // The part's own switch without Ever Connect is nothing either.
            expect(
                everConnectPersonDataModuleImports({ EVER_CONNECT_PERSON_EXPORT_ENABLED: 'true' }),
            ).toEqual([]);

            const extensions = new EverConnectExtensions();
            const participant = new PersonDataParticipantService(
                dataSource,
                new PersonDataExportBuilder(dataSource),
                extensions,
            );
            participant.onModuleInit();
            expect(extensions.personDataParticipant()).toBeNull();

            const { ada } = await seed();
            const platform = new FakePlatform().answer('instanceAckRequest', undefined);
            const handler = new PersonRequestsHandler(
                platform,
                dataSource,
                { log: jest.fn().mockResolvedValue({}) } as unknown as ActivityLogService,
                undefined,
                extensions,
            );
            const answer = await handler.handle(
                exportRequest(JOB, [subjectHash(ISSUER, 'sub-ada')]),
            );
            expect(answer).toMatchObject({ result: 'failed', reasonCode: 'export_not_available' });
            expect(platform.callsOf('instanceAckRequest')[0].input?.body).toEqual({
                job_id: JOB,
                result: 'failed',
                detail: { reason_code: 'export_not_available' },
            });
            await expect(
                participant.exportAccounts({ userIds: [ada.id], jobId: JOB, respondBy: '' }),
            ).rejects.toThrow('person_export_disabled');
        });

        it('the download answers 404 even for a job answered exported', async () => {
            const { ada } = await seed();
            await answered({});
            await expect(service().documentFor(JOB, ada.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('switched on', () => {
        beforeEach(switchOn);

        it('the module is imported and the participant offers export only', () => {
            expect(everConnectPersonDataModuleImports(process.env)).toEqual([
                EverConnectPersonDataModule,
            ]);
            const extensions = new EverConnectExtensions();
            new PersonDataParticipantService(
                dataSource,
                new PersonDataExportBuilder(dataSource),
                extensions,
            ).onModuleInit();
            const registered = extensions.personDataParticipant();
            expect(typeof registered?.exportAccounts).toBe('function');
            expect(registered?.deleteAccounts).toBeUndefined();
        });

        it("answers exported with the web app's address for the job, and stores nothing else", async () => {
            await seed();
            const extensions = new EverConnectExtensions();
            new PersonDataParticipantService(
                dataSource,
                new PersonDataExportBuilder(dataSource),
                extensions,
            ).onModuleInit();
            const platform = new FakePlatform().answer('instanceAckRequest', undefined);
            const handler = new PersonRequestsHandler(
                platform,
                dataSource,
                { log: jest.fn().mockResolvedValue({}) } as unknown as ActivityLogService,
                undefined,
                extensions,
            );

            const answer = await handler.handle(
                exportRequest(JOB, [subjectHash(ISSUER, 'sub-ada')]),
            );

            expect(answer).toMatchObject({ kind: 'export', result: 'exported', recorded: true });
            expect(platform.callsOf('instanceAckRequest')[0].input?.body).toEqual({
                job_id: JOB,
                result: 'exported',
                export_url: `${WEB}/api/ever-connect/person-export/${JOB}`,
            });
            // The answer row is the only write; an export removes nothing.
            expect(await dataSource.getRepository(EverConnectPersonRequest).count()).toBe(1);
            expect(await dataSource.getRepository(ExternalIdentity).count()).toBe(2);
            expect(await dataSource.getRepository(User).count()).toBe(2);
        });

        it("the document is the signed-in account's own data, and nobody else's", async () => {
            const { ada, bob, tenant, organization, adaApp, bobSite } = await seed();
            await answered({});

            const document = await service().documentFor(JOB, ada.id);

            expect(document).toMatchObject({
                format: 'ever-works.person-data',
                version: 1,
                account: {
                    id: ada.id,
                    username: 'ada',
                    email: 'ada@example.test',
                    displayName: 'Ada',
                    lastLoginIp: '203.0.113.7',
                },
                identities: [{ issuer: ISSUER, subject: 'sub-ada' }],
                workspaces: [{ id: tenant.id, displayName: 'Ada Co', role: 'owner' }],
                organizations: [{ id: organization.id, slug: 'ada-co', role: 'owner' }],
            });
            expect(document.works.owned.map((work) => work.id)).toEqual([adaApp.id]);
            expect(document.works.memberOf).toEqual([
                expect.objectContaining({ id: bobSite.id, name: 'Bob Site', role: 'editor' }),
            ]);
            expect(document.settings.apiKeys).toEqual([
                expect.objectContaining({ name: 'laptop', prefix: 'ew_live_ab' }),
            ]);

            const text = JSON.stringify(document);
            // Nothing about the other member: not their address, name, identity or role.
            expect(text).not.toContain(bob.id);
            expect(text).not.toContain('bob@example.test');
            expect(text).not.toContain('sub-bob');
            // Never a secret of the account itself.
            expect(text).not.toContain('hash-of-adas-password');
            expect(text).not.toContain('adas-reset-token');
            expect(text).not.toContain('hashed-secret-of-the-key');
        });

        it('a member gets their own role, and the address gives each person only their own data', async () => {
            const { ada, bob, organization, bobSite } = await seed();
            await answered({});

            const document = await service().documentFor(JOB, bob.id);

            expect(document.account.id).toBe(bob.id);
            expect(document.workspaces).toEqual([expect.objectContaining({ role: 'member' })]);
            expect(document.organizations).toEqual([
                expect.objectContaining({ id: organization.id, role: 'admin' }),
            ]);
            expect(document.works.owned.map((work) => work.id)).toEqual([bobSite.id]);
            expect(document.works.memberOf).toEqual([]);
            const text = JSON.stringify(document);
            expect(text).not.toContain(ada.id);
            expect(text).not.toContain('ada@example.test');
        });

        it('404 for anything but an export answered exported, within its days', async () => {
            const { ada } = await seed();
            const participant = service();

            await expect(participant.documentFor(JOB, ada.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await answered({ result: 'failed', reasonCode: 'export_failed', exportUrl: null });
            await expect(participant.documentFor(JOB, ada.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await dataSource.getRepository(EverConnectPersonRequest).clear();
            await answered({ kind: 'deletion', result: 'deleted', exportUrl: null });
            await expect(participant.documentFor(JOB, ada.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await dataSource.getRepository(EverConnectPersonRequest).clear();
            await answered({});
            await expect(participant.documentFor('not-a-job', ada.id)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            const later = new Date(Date.now() + (PERSON_EXPORT_LINK_DAYS + 1) * 24 * 3_600_000);
            await expect(participant.documentFor(JOB, ada.id, later)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await expect(participant.documentFor(JOB, randomUUID())).rejects.toBeInstanceOf(
                NotFoundException,
            );
            // Within its days, for an account that exists: the document.
            await expect(participant.documentFor(JOB, ada.id)).resolves.toMatchObject({
                account: { id: ada.id },
            });
        });

        it('a web address that is not https is not passed on (the handler answers export_failed)', async () => {
            process.env.WEB_URL = 'http://localhost:3000';
            await seed();
            const extensions = new EverConnectExtensions();
            new PersonDataParticipantService(
                dataSource,
                new PersonDataExportBuilder(dataSource),
                extensions,
            ).onModuleInit();
            const handler = new PersonRequestsHandler(
                new FakePlatform().answer('instanceAckRequest', undefined),
                dataSource,
                { log: jest.fn().mockResolvedValue({}) } as unknown as ActivityLogService,
                undefined,
                extensions,
            );
            expect(
                await handler.handle(exportRequest(JOB, [subjectHash(ISSUER, 'sub-ada')])),
            ).toMatchObject({ result: 'failed', reasonCode: 'export_failed' });
        });
    });
});
