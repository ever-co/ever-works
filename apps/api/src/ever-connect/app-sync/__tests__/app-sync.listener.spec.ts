import { randomUUID } from 'node:crypto';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { In, type DataSource } from 'typeorm';
import {
    DeploymentCompletedEvent,
    DeploymentDispatchedEvent,
    DeploymentFailedEvent,
} from '@ever-works/agent/events';
import {
    EverConnectConnection,
    EverConnectIntegration,
    EverConnectLink,
    EverConnectOutbox,
    Organization,
    Work,
} from '@ever-works/agent/entities';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import type { EverConnectIntegrationService } from '../../ever-connect-integration.service';
import type { EverConnectService } from '../../ever-connect.service';
import { APP_SYNC_KEY, APP_SYNC_OUTBOX_EVENT, APP_SYNC_OUTBOX_EVENTS } from '../app-sync.mapping';
import { AppSyncListener } from '../app-sync.listener';
import { AppSyncService } from '../app-sync.service';

/**
 * What tells the apps mirror that a Work changed, with the events emitted on a
 * real emitter as the API emits them and the outbox on a real database: a step
 * of an App's deployment (reported by the worker that runs it) queues the
 * Work's one row, exactly as a deployment of a site does.
 */
const LINK = '01JZ8Q3M4N5P6R7S8T9V0W1XA1';

/** The names the API emits for the steps of an App's deployment that change what the mirror says. */
const APP_DEPLOY_EVENTS = [
    'app.deploy.started',
    'app.deploy.succeeded',
    'app.deploy.failed',
    'app.deploy.rolled_back',
] as const;

describe('AppSyncListener', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let moduleRef: TestingModule;
    let emitter: EventEmitter2;
    let mirror: AppSyncService;

    const linked = { id: randomUUID(), tenantId: randomUUID(), slug: 'acme' };
    const unlinked = { id: randomUUID(), tenantId: randomUUID(), slug: 'not-linked' };

    const rows = () =>
        dataSource
            .getRepository(EverConnectOutbox)
            .find({ where: { event: In([...APP_SYNC_OUTBOX_EVENTS]) }, order: { seq: 'ASC' } });
    const addWork = async (organization: { id: string; tenantId: string }, kind = 'app') => {
        const id = randomUUID();
        await dataSource.getRepository(Work).insert({
            id,
            name: 'Store',
            slug: `store-${id.slice(0, 8)}`,
            userId: randomUUID(),
            description: '',
            kind,
            status: 'active',
            organizationId: organization.id,
            tenantId: organization.tenantId,
        } as never);
        return id;
    };
    /** Emit as the API does, and wait for every listener of the name. */
    const emit = (name: string, payload: unknown) => emitter.emitAsync(name, payload);

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_APP_SYNC_ENABLED = 'true';
        for (const entity of [
            EverConnectOutbox,
            EverConnectIntegration,
            EverConnectLink,
            EverConnectConnection,
            Work,
            Organization,
        ]) {
            await dataSource.getRepository(entity).clear();
        }
        await dataSource.getRepository(EverConnectConnection).insert({
            id: 'self',
            status: 'active',
            platformInstanceId: '01JZ8Q3M4N5P6R7S8T9V0W1X2Y',
        });
        await dataSource.getRepository(Organization).insert(
            [linked, unlinked].map((organization) => ({
                ...organization,
                displayName: organization.slug,
            })) as never,
        );
        await dataSource.getRepository(EverConnectLink).insert({
            organizationId: linked.id,
            tenantId: linked.tenantId,
            everOrgId: '01JMQCK0RG000000000000000A',
            handle: 'acme',
            platformLinkId: LINK,
            productOrgRef: 'acme',
            createdVia: 'link_code',
            status: 'active',
        });
        await dataSource.getRepository(EverConnectIntegration).insert({
            linkId: LINK,
            integrationKey: APP_SYNC_KEY,
            state: 'enabled',
            enabled: true,
            scopeVersion: 2,
        });

        const repository = dataSource.getRepository(EverConnectConnection);
        const connection = {
            connection: async () => repository.findOneOrFail({ where: { id: 'self' } }),
            client: async () => null,
        } as unknown as EverConnectService;
        mirror = new AppSyncService(dataSource, connection, {
            refresh: async () => [],
        } as unknown as EverConnectIntegrationService);

        moduleRef = await Test.createTestingModule({
            imports: [EventEmitterModule.forRoot()],
            providers: [AppSyncListener, { provide: AppSyncService, useValue: mirror }],
        }).compile();
        // The listeners are bound when the application has started.
        await moduleRef.init();
        emitter = moduleRef.get(EventEmitter2);
    });

    afterEach(async () => {
        await moduleRef.close();
        process.env = { ...savedEnv };
    });

    describe("a step of an App's deployment", () => {
        it.each(APP_DEPLOY_EVENTS)('%s queues the Work, named by its id only', async (name) => {
            const work = await addWork(linked);
            await emit(name, {
                workId: work,
                deploymentId: randomUUID(),
                target: 'your-cluster',
                phase: 'rollout',
                code: 'image_pull_failed',
            });
            const queued = await rows();
            expect(queued).toHaveLength(1);
            expect(queued[0]).toMatchObject({
                event: APP_SYNC_OUTBOX_EVENT,
                payload: { workId: work },
                dedupeKey: `app_sync:${work}`,
                // Read from the Work: the event does not name the Organization.
                accountRef: linked.id,
                state: 'pending',
                attempts: 0,
            });
            // Nothing of the event is kept: not the deployment, the target or a code.
            expect(Object.keys(queued[0].payload)).toEqual(['workId']);
        });

        it('a whole deployment leaves one row, due now each time', async () => {
            const work = await addWork(linked);
            await emit('app.deploy.started', { workId: work });
            const [first] = await rows();
            // Tried and waiting for its next try: the next step makes it due again.
            await dataSource
                .getRepository(EverConnectOutbox)
                .update(
                    { id: first.id },
                    { attempts: 3, nextAttemptAt: new Date(Date.now() + 3_600_000) },
                );
            await emit('app.deploy.succeeded', { workId: work });
            const queued = await rows();
            expect(queued).toHaveLength(1);
            expect(queued[0].id).toBe(first.id);
            expect(queued[0].attempts).toBe(0);
            expect(new Date(queued[0].nextAttemptAt).getTime()).toBeLessThanOrEqual(Date.now());
            expect(BigInt(queued[0].seq)).toBeGreaterThan(BigInt(first.seq));
        });

        it('shares the row of every other change of the Work', async () => {
            const work = await addWork(linked, 'website');
            const site = { payload: { work: { id: work, organizationId: linked.id } } };
            await emit(DeploymentDispatchedEvent.EVENT_NAME, site);
            await emit('app.deploy.started', { workId: work });
            await emit(DeploymentCompletedEvent.EVENT_NAME, site);
            await emit('app.deploy.failed', { workId: work });
            await emit(DeploymentFailedEvent.EVENT_NAME, site);
            expect(await rows()).toHaveLength(1);
        });

        it('queues nothing for a Work of an Organization the mirror does not run for', async () => {
            await emit('app.deploy.succeeded', { workId: await addWork(unlinked) });
            // A Work that does not exist here: no Organization to queue it for.
            await emit('app.deploy.succeeded', { workId: randomUUID() });
            expect(await rows()).toEqual([]);
        });

        it.each([
            ['no Work id', {}],
            ['an empty Work id', { workId: '   ' }],
            ['a Work id that is not text', { workId: 42 }],
            ['an id that is not one', { workId: 'not an id' }],
            ['no payload', undefined],
        ])('queues nothing for an event with %s, and does not throw', async (_name, payload) => {
            await expect(emit('app.deploy.succeeded', payload)).resolves.toBeDefined();
            expect(await rows()).toEqual([]);
        });

        it.each([
            ['the switch is off', () => delete process.env.EVER_CONNECT_APP_SYNC_ENABLED],
            ['Ever Connect is off', () => delete process.env.EVER_CONNECT_ENABLED],
        ])('queues nothing while %s', async (_name, off) => {
            const work = await addWork(linked);
            off();
            for (const name of APP_DEPLOY_EVENTS) await emit(name, { workId: work });
            expect(await rows()).toEqual([]);
        });

        it('a failure to queue never reaches the emitter (the reconciliation sends the Work)', async () => {
            const work = await addWork(linked);
            jest.spyOn(mirror, 'enabledLinks').mockRejectedValueOnce(new Error('database is gone'));
            await expect(emit('app.deploy.succeeded', { workId: work })).resolves.toBeDefined();
            expect(await rows()).toEqual([]);
        });
    });

    it('queues nothing for what the mirror does not say of an App (a job, a check, its health, a dependency)', async () => {
        const work = await addWork(linked);
        const changed = jest.spyOn(mirror, 'workChanged');
        for (const name of [
            'app.job.succeeded',
            'app.job.failed',
            'app.smoke.passed',
            'app.smoke.failed',
            'app.health.degraded',
            'app.health.recovered',
            'app.dependency.provisioned',
        ]) {
            await emit(name, { workId: work });
        }
        expect(changed).not.toHaveBeenCalled();
        expect(await rows()).toEqual([]);
    });
});
